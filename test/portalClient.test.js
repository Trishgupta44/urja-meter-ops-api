import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { PortalClient, signPortalRequest } from '../src/portalClient.js';

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
const loginResponse = (n = 1) =>
  json({ token: `tok_${n}` }, { headers: { 'set-cookie': `__Secure-better-auth.session_token=sess_${n}; Max-Age=3600; Path=/` } });

/** A scripted portal: login always works; `handler(url, init, call)` answers everything else. */
function scriptedPortal(handler) {
  const stats = { logins: 0, calls: [] };
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/api/auth/sign-in/email')) { stats.logins += 1; return loginResponse(stats.logins); }
    stats.calls.push({ url, init });
    return handler(url, init, stats.calls.length);
  };
  const client = new PortalClient({ baseUrl: 'https://portal.test', fetchImpl, maxRetries: 2, timeoutMs: 200 });
  return { client, stats };
}

// ---------------------------------------------------------------------------
// Request signing
// ---------------------------------------------------------------------------

test('signPortalRequest is the HMAC-SHA256 of "METHOD\\nPATH\\nQUERY\\nTIMESTAMP"', () => {
  const secret = 'I3dZPPf5CgTp7JyGNMI8i6z8LFR7TmSR';
  const { timestamp, signature } = signPortalRequest('get', '/portal/export', 'page=1', secret, 1_700_000_000_000);
  assert.equal(timestamp, '1700000000');
  const expected = crypto.createHmac('sha256', secret).update('GET\n/portal/export\npage=1\n1700000000').digest('hex');
  assert.equal(signature, expected);
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test('concurrent requests share a single login', async () => {
  const { client, stats } = scriptedPortal(() => json({ data: [], total: 0, pageSize: 20 }));
  await Promise.all([client.fetchAllTransformers(), client.fetchAllTransformers(), client.fetchAllTransformers()]);
  assert.equal(stats.logins, 1);
});

test('login falls back to the SvelteKit form action when Better Auth sets no cookie', async () => {
  let formCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/sign-in/email')) return json({});
    if (url.endsWith('/login')) { formCalls += 1; return loginResponse(); }
    return json({ data: [] });
  };
  const client = new PortalClient({ baseUrl: 'https://portal.test', fetchImpl });
  await client.login();
  assert.equal(formCalls, 1);
  assert.ok(client.hasValidSession());
});

test('login fails clearly when no session cookie is ever returned', async () => {
  const client = new PortalClient({ baseUrl: 'https://portal.test', fetchImpl: async () => json({}) });
  await assert.rejects(() => client.login(), /no session cookie/);
});

test('a session close to expiry is not considered valid', async () => {
  const { client } = scriptedPortal(() => json({ data: [] }));
  await client.login();
  assert.equal(client.hasValidSession(), true);
  client.sessionExpiresAt = Date.now() + 60_000; // inside the 2-minute safety margin
  assert.equal(client.hasValidSession(), false);
});

test('a 401 triggers one re-authentication and the request is retried', async () => {
  const { client, stats } = scriptedPortal((_url, _init, call) =>
    (call === 1 ? json({ error: 'unauthorized' }, { status: 401 }) : json({ data: [{ code: 'DT-001' }], total: 1, pageSize: 20 })));
  const dts = await client.fetchAllTransformers();
  assert.equal(dts.length, 1);
  assert.equal(stats.logins, 2);
  assert.equal(client.stats.reauthCount, 1);
});

test('a SvelteKit redirect-to-login body is treated as an expired session', async () => {
  const { client, stats } = scriptedPortal((_url, _init, call) =>
    (call === 1 ? json({ type: 'redirect', location: '/login' }) : json({ nodes: [] })));
  await client.requestJson('/meters/J100000/__data.json');
  assert.equal(stats.logins, 2);
});

test('a persistent 401 gives up after one re-authentication', async () => {
  const { client, stats } = scriptedPortal(() => json({ message: 'nope' }, { status: 401 }));
  await assert.rejects(() => client.requestJson('/portal/dts?page=1'), (err) => err.status === 401);
  assert.equal(stats.logins, 2);
});

// ---------------------------------------------------------------------------
// Rate limits and transient failures
// ---------------------------------------------------------------------------

test('a 429 is retried after the Retry-After delay', async () => {
  const { client } = scriptedPortal((_url, _init, call) =>
    (call === 1 ? json({}, { status: 429, headers: { 'retry-after': '0.01' } }) : json({ data: [{ code: 'DT-001' }], total: 1, pageSize: 20 })));
  assert.equal((await client.fetchAllTransformers()).length, 1);
  assert.equal(client.stats.rateLimitHits, 1);
  assert.equal(client.stats.retries, 1);
});

test('a 429 that never clears surfaces as an error with status 429', async () => {
  const { client, stats } = scriptedPortal(() => json({}, { status: 429, headers: { 'retry-after': '0.01' } }));
  await assert.rejects(() => client.requestJson('/portal/dts?page=1'), (err) => err.status === 429);
  assert.equal(stats.calls.length, 3, 'the original attempt plus maxRetries');
});

test('a 5xx is retried with backoff and then succeeds', async () => {
  const { client, stats } = scriptedPortal((_url, _init, call) =>
    (call === 1 ? json({}, { status: 503 }) : json({ ok: true })));
  assert.deepEqual(await client.requestJson('/portal/keys'), { ok: true });
  assert.equal(stats.calls.length, 2);
});

test('a 5xx that persists is reported with the upstream status', async () => {
  const { client } = scriptedPortal(() => json('boom', { status: 500 }));
  client.maxRetries = 0;
  await assert.rejects(() => client.requestJson('/portal/keys'), (err) => err.status === 500 && /Portal HTTP 500/.test(err.message));
});

test('a request that exceeds the timeout is aborted and retried', async () => {
  let attempts = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/api/auth/sign-in/email')) return loginResponse();
    attempts += 1;
    if (attempts === 1) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return json({ ok: true });
  };
  const client = new PortalClient({ baseUrl: 'https://portal.test', fetchImpl, timeoutMs: 20, maxRetries: 1 });
  assert.deepEqual(await client.requestJson('/portal/keys'), { ok: true });
  assert.equal(attempts, 2);
});

test('a 404 becomes an error carrying status 404', async () => {
  const { client } = scriptedPortal(() => json({ message: 'no such meter' }, { status: 404 }));
  await assert.rejects(() => client.requestJson('/portal/meters/X/geo'), (err) => err.status === 404 && /no such meter/.test(err.message));
});

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

test('the bulk export is signed, and the signing key is refreshed once if it rotated', async () => {
  const seen = [];
  const { client } = scriptedPortal((url, init) => {
    if (url.endsWith('/portal/keys')) {
      const secret = seen.filter((s) => s === 'keys').length === 0 ? 'old-secret' : 'new-secret';
      seen.push('keys');
      return json({ data: { signingSecret: secret } });
    }
    if (url.includes('/portal/export')) {
      const { 'x-timestamp': ts, 'x-signature': sig } = init.headers;
      const good = crypto.createHmac('sha256', 'new-secret').update(`GET\n/portal/export\npage=1\n${ts}`).digest('hex');
      seen.push('export');
      return sig === good ? json({ data: [{ meterId: 'J100000' }] }) : json({ error: 'signature_invalid', message: 'bad signature' }, { status: 401 });
    }
    throw new Error(`unexpected ${url}`);
  });
  const meters = await client.fetchAllMetersBulk();
  assert.deepEqual(meters, [{ meterId: 'J100000' }]);
  assert.deepEqual(seen, ['keys', 'export', 'keys', 'export'], 'one rejected export, one key refresh, one success');
});

test('a missing signing secret is a clear error', async () => {
  const { client } = scriptedPortal(() => json({ data: {} }));
  await assert.rejects(() => client.getSigningSecret(), /signingSecret/);
});

test('transformers are fetched across every page', async () => {
  const { client, stats } = scriptedPortal((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return json({ data: [{ code: `DT-${page}` }], total: 3, pageSize: 1 });
  });
  const all = await client.fetchAllTransformers();
  assert.deepEqual(all.map((d) => d.code), ['DT-1', 'DT-2', 'DT-3']);
  assert.equal(stats.calls.length, 3);
});

test('search queries are URL-encoded so a literal "&" is not truncated', async () => {
  const { client, stats } = scriptedPortal(() => json({ data: [], total: 0 }));
  await client.searchMetersPage('L&84997', 2);
  assert.match(stats.calls[0].url, /q=L%2684997&page=2$/);
});

test('energy requests pass the date window through', async () => {
  const { client, stats } = scriptedPortal(() => json({ data: [{ kwh: '1' }] }));
  await client.fetchMeterEnergy('J100000', { from: '2026-06-01', to: '2026-06-30' });
  await client.fetchMeterEnergy('J100000');
  assert.match(stats.calls[0].url, /\/portal\/meters\/J100000\/energy\?from=2026-06-01&to=2026-06-30$/);
  assert.match(stats.calls[1].url, /\/portal\/meters\/J100000\/energy$/);
});

test('the SSR detail payload is decoded from the SvelteKit data node', async () => {
  const { client } = scriptedPortal(() => json({ nodes: [null, null, { data: [{ detail: 1 }, { data: 2 }, [3], { parameterName: 4, parameterValue: 5 }, 'Make', 'HPL'] }] }));
  const decoded = await client.fetchMeterSsrDetail('J100000');
  assert.deepEqual(decoded, { detail: { data: [{ parameterName: 'Make', parameterValue: 'HPL' }] } });
});
