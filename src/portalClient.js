import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Computes the HMAC-SHA256 signature required by `/portal/export`.
 * Canonical payload format discovered in `/_app/immutable/nodes/4.2Bgc2kUI.js`:
 *   [method, path, query, timestampSeconds].join('\n')
 *
 * @param {string} method - HTTP method (e.g. "GET")
 * @param {string} path - URL pathname (e.g. "/portal/export")
 * @param {string} query - Raw query string without leading '?' (e.g. "page=1")
 * @param {string} secret - Signing secret from `/portal/keys`
 * @param {number} [nowMs] - Optional timestamp override in ms for deterministic testing
 * @returns {{ timestamp: string, signature: string }}
 */
export function signPortalRequest(method, path, query, secret, nowMs = Date.now()) {
  const timestamp = String(Math.floor(nowMs / 1000));
  const canonical = [method.toUpperCase(), path, query, timestamp].join('\n');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(canonical, 'utf8')
    .digest('hex');
  return { timestamp, signature };
}

/**
 * Decodes SvelteKit's compact `devalue`-serialized array from `__data.json`.
 * Used when inspecting `/meters/:id/__data.json` directly.
 */
export function decodeSvelteKitDataNode(dataArray) {
  if (!Array.isArray(dataArray) || dataArray.length === 0) return null;
  const memo = new Map();
  function resolve(idx) {
    if (typeof idx !== 'number' || idx < 0 || idx >= dataArray.length) return idx;
    if (memo.has(idx)) return memo.get(idx);
    const val = dataArray[idx];
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) {
      const arr = [];
      memo.set(idx, arr);
      for (const itemIdx of val) arr.push(resolve(itemIdx));
      return arr;
    }
    const obj = {};
    memo.set(idx, obj);
    for (const [k, vIdx] of Object.entries(val)) {
      obj[k] = resolve(vIdx);
    }
    return obj;
  }
  return resolve(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class PortalClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || config.portalBaseUrl).replace(/\/+$/, '');
    this.email = options.email || config.portalEmail;
    this.password = options.password || config.portalPassword;
    this.timeoutMs = options.timeoutMs || config.requestTimeoutMs;
    this.maxRetries = options.maxRetries ?? config.maxRetries;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;

    this.cookieHeader = null;
    this.sessionExpiresAt = 0;
    this.signingSecret = null;
    this.loginPromise = null;

    this.stats = {
      totalRequests: 0,
      loginCount: 0,
      reauthCount: 0,
      rateLimitHits: 0,
      retries: 0,
      lastLoginAt: null,
      lastError: null,
    };
  }

  /**
   * Returns true if we have a session cookie that is not within 2 minutes of expiring.
   */
  hasValidSession() {
    return Boolean(this.cookieHeader && Date.now() < this.sessionExpiresAt - 120_000);
  }

  /**
   * Authenticates against the portal using Better Auth (`/api/auth/sign-in/email`)
   * with a fallback to the SvelteKit form action (`POST /login`).
   * Concurrent callers share a single in-flight login promise.
   */
  async login(force = false) {
    if (!force && this.hasValidSession()) {
      return this.cookieHeader;
    }
    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = (async () => {
      try {
        // Primary: Better Auth JSON endpoint
        let res = await this._rawFetch('/api/auth/sign-in/email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Origin: this.baseUrl,
          },
          body: JSON.stringify({
            email: this.email,
            password: this.password,
          }),
        });

        let cookies = this._extractCookies(res);

        // Fallback: SvelteKit `/login` form action if needed
        if (!cookies) {
          res = await this._rawFetch('/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
              'x-sveltekit-action': 'true',
              Origin: this.baseUrl,
              Referer: `${this.baseUrl}/login`,
            },
            body: new URLSearchParams({
              email: this.email,
              password: this.password,
            }),
            redirect: 'manual',
          });
          cookies = this._extractCookies(res);
        }

        if (!cookies) {
          throw new Error(`Portal login failed (HTTP ${res.status}): no session cookie returned`);
        }

        this.cookieHeader = cookies.cookieHeader;
        this.sessionExpiresAt = Date.now() + cookies.maxAgeSeconds * 1000;
        this.stats.loginCount += 1;
        this.stats.lastLoginAt = new Date().toISOString();
        return this.cookieHeader;
      } finally {
        this.loginPromise = null;
      }
    })();

    return this.loginPromise;
  }

  _extractCookies(res) {
    const rawCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);

    if (!rawCookies || rawCookies.length === 0) return null;

    let maxAgeSeconds = 3600; // Default Max-Age=3600 observed on Better Auth cookie
    const pairs = [];
    for (const raw of rawCookies) {
      const parts = raw.split(';').map((s) => s.trim());
      if (parts[0]) pairs.push(parts[0]);
      for (const attr of parts.slice(1)) {
        if (attr.toLowerCase().startsWith('max-age=')) {
          const parsed = Number(attr.split('=')[1]);
          if (!Number.isNaN(parsed) && parsed > 0) {
            maxAgeSeconds = parsed;
          }
        }
      }
    }

    if (pairs.length === 0) return null;
    return { cookieHeader: pairs.join('; '), maxAgeSeconds };
  }

  async _rawFetch(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.stats.totalRequests += 1;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Executes an authenticated JSON request against the portal with:
   * - Automatic session login & 401 re-authentication
   * - Exponential backoff + jitter on HTTP 429 (Too Many Requests) and 5xx errors
   */
  async requestJson(path, options = {}) {
    await this.login(false);

    let reauthed = false;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this._rawFetch(path, {
          ...options,
          headers: {
            Accept: 'application/json',
            Cookie: this.cookieHeader,
            ...(options.headers || {}),
          },
        });

        // Handle 401 Unauthorized (session expired)
        if (res.status === 401) {
          const errBody = await res.json().catch(() => ({}));
          if (errBody.error === 'signature_invalid') {
            const err = new Error(errBody.message || 'Invalid HMAC signature');
            err.code = 'SIGNATURE_INVALID';
            err.status = 401;
            throw err;
          }
          if (!reauthed) {
            reauthed = true;
            this.stats.reauthCount += 1;
            await this.login(true);
            continue;
          }
          const err = new Error(errBody.message || 'Unauthorized');
          err.status = 401;
          throw err;
        }

        // Handle 429 Too Many Requests
        if (res.status === 429) {
          this.stats.rateLimitHits += 1;
          if (attempt < this.maxRetries) {
            this.stats.retries += 1;
            const retryAfter = Number(res.headers.get('retry-after'));
            const baseDelay = !Number.isNaN(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : 1000 * Math.pow(2, attempt);
            const jitter = Math.floor(Math.random() * 250);
            await sleep(baseDelay + jitter);
            continue;
          }
          const err = new Error('Upstream portal rate limit exceeded (HTTP 429)');
          err.status = 429;
          throw err;
        }

        // Handle 5xx transient server errors
        if (res.status >= 500 && attempt < this.maxRetries) {
          this.stats.retries += 1;
          await sleep(500 * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
          continue;
        }

        if (res.status === 404) {
          const errBody = await res.json().catch(() => ({}));
          const err = new Error(errBody.message || 'Resource not found on portal');
          err.status = 404;
          throw err;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new Error(`Portal HTTP ${res.status}: ${text.slice(0, 200)}`);
          err.status = res.status;
          throw err;
        }

        const data = await res.json();

        // SvelteKit __data.json returns 200 with { type: "redirect", location: "/login" } when unauthenticated
        if (data && data.type === 'redirect' && data.location === '/login' && !reauthed) {
          reauthed = true;
          this.stats.reauthCount += 1;
          await this.login(true);
          continue;
        }

        return data;
      } catch (err) {
        this.stats.lastError = {
          message: err.message,
          path,
          timestamp: new Date().toISOString(),
        };
        if (err.name === 'AbortError' && attempt < this.maxRetries) {
          this.stats.retries += 1;
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }

    // Every attempt was consumed (e.g. by repeated re-auth redirects) without a usable response.
    const err = new Error(`Portal request to ${path} failed after ${this.maxRetries + 1} attempts`);
    err.status = 502;
    throw err;
  }

  /**
   * Retrieves (and caches) the HMAC signing secret from `GET /portal/keys`.
   */
  async getSigningSecret(forceRefresh = false) {
    if (!forceRefresh && this.signingSecret) {
      return this.signingSecret;
    }
    const res = await this.requestJson('/portal/keys');
    const secret = res?.data?.signingSecret;
    if (!secret) {
      throw new Error('Failed to retrieve signingSecret from /portal/keys');
    }
    this.signingSecret = secret;
    return secret;
  }

  /**
   * Fetches the complete 403-meter dataset in a single bulk call via HMAC-signed
   * `GET /portal/export?page=1`. If the signing key rotated, refreshes the key once.
   */
  async fetchAllMetersBulk() {
    const query = 'page=1';
    const exportOnce = async (refreshSecret) => {
      const secret = await this.getSigningSecret(refreshSecret);
      const { timestamp, signature } = signPortalRequest('GET', '/portal/export', query, secret);
      const res = await this.requestJson(`/portal/export?${query}`, {
        headers: { 'x-timestamp': timestamp, 'x-signature': signature },
      });
      return res.data || [];
    };

    try {
      return await exportOnce(false);
    } catch (err) {
      if (err.code !== 'SIGNATURE_INVALID') throw err;
      return exportOnce(true); // the signing key rotated: fetch a fresh one and retry once
    }
  }

  /**
   * Fetches all Distribution Transformers across all pages of `GET /portal/dts?page=N`.
   */
  async fetchAllTransformers() {
    const firstPage = await this.requestJson('/portal/dts?page=1');
    const total = Number(firstPage.total || 0);
    const pageSize = Number(firstPage.pageSize || 20);
    const all = [...(firstPage.data || [])];
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    for (let page = 2; page <= totalPages; page++) {
      const next = await this.requestJson(`/portal/dts?page=${page}`);
      if (Array.isArray(next.data)) {
        all.push(...next.data);
      }
    }
    return all;
  }

  /**
   * Searches meters directly on the portal (`GET /portal/meters/search?q=...&page=...`).
   * Ensures `encodeURIComponent` is used so `L&` serials (containing `&`) are never truncated.
   */
  async searchMetersPage(query = '', page = 1) {
    const encodedQ = encodeURIComponent(query);
    return this.requestJson(`/portal/meters/search?q=${encodedQ}&page=${Number(page)}`);
  }

  /**
   * Fetches energy consumption readings for a specific meter (`GET /portal/meters/:id/energy`).
   * Supports optional `from` and `to` (YYYY-MM-DD) parameters, which unlock the full 30-day
   * June 2026 dataset beyond the portal's default 7-day window.
   */
  async fetchMeterEnergy(meterId, { from, to } = {}) {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    const path = `/portal/meters/${encodeURIComponent(meterId)}/energy${qs ? `?${qs}` : ''}`;
    const res = await this.requestJson(path);
    return res.data || [];
  }

  /**
   * Fetches GPS coordinates for a specific meter (`GET /portal/meters/:id/geo`).
   */
  async fetchMeterGeo(meterId) {
    const res = await this.requestJson(`/portal/meters/${encodeURIComponent(meterId)}/geo`);
    return res.data || null;
  }

  /**
   * Fetches and decodes the SvelteKit SSR payload (`/meters/:id/__data.json`),
   * normalizing both `legacy` (`detail.data` array) and `v2` (`detail.classData` JSON string) schemas.
   */
  async fetchMeterSsrDetail(meterId) {
    const raw = await this.requestJson(`/meters/${encodeURIComponent(meterId)}/__data.json`);
    const detailNode = raw?.nodes?.[2]?.data;
    if (!detailNode) return null;
    const decoded = decodeSvelteKitDataNode(detailNode);
    return decoded;
  }
}
