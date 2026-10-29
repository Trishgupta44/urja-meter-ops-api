import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApiSpec } from './openapi.js';
import { ApiError, badRequest } from './errors.js';
import { assertKnownParams, parseFlags } from './queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicIndexPath = path.resolve(__dirname, 'public', 'index.html');

const BASE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'X-Content-Type-Options': 'nosniff',
};

const json = (body, headers = {}, status = 200) => ({
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  body: JSON.stringify(body, null, 2),
});

const html = (body, status = 200) => ({
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body,
});

/** `X-Cache` reflects where the data came from: HIT, MISS (just synced) or STALE (portal unreachable). */
function cacheHeader(meta) {
  if (meta.staleFallback) return 'STALE';
  return meta.cacheHit ? 'HIT' : 'MISS';
}

const withCacheHeader = (result) => json(result, { 'X-Cache': cacheHeader(result.meta) });

function renderScalarDocsHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Urja Meter Ops Clean API — OpenAPI Reference</title>
</head>
<body>
  <script id="api-reference" data-url="/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
}

async function renderDashboard() {
  try {
    return html(await fs.readFile(publicIndexPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return json({
      service: 'Urja Meter Ops Clean API Service',
      docs: '/docs',
      openapi: '/openapi.json',
      health: '/api/v1/health',
    });
  }
}

/**
 * Route table. Paths use `:name` segments; handlers receive the store, parsed
 * query string and decoded path params, and return a response descriptor.
 * Exported so tests can verify it stays in sync with `openapi.json`.
 */
export const routes = [
  { method: 'GET', path: '/', handler: () => renderDashboard() },
  { method: 'GET', path: '/index.html', handler: () => renderDashboard() },
  { method: 'GET', path: '/openapi.json', handler: () => json(openApiSpec) },
  { method: 'GET', path: '/docs', handler: () => html(renderScalarDocsHtml()) },

  {
    method: 'GET',
    path: '/api/v1/health',
    handler: ({ store, startedAt }) => {
      const cache = store.getCacheMeta();
      return json({
        status: cache.lastRefreshError ? 'degraded' : 'ok',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        cache,
        upstreamPortal: {
          baseUrl: store.client.baseUrl,
          hasValidSession: store.client.hasValidSession(),
          stats: store.client.stats,
        },
      });
    },
  },
  {
    method: 'POST',
    path: '/api/v1/sync',
    handler: async ({ store, query }) => {
      assertKnownParams(query, []);
      const { cacheHit } = await store.ensureIndex({ forceRefresh: true });
      return json({
        // "throttled" means a sync already ran within the minimum refresh interval.
        status: cacheHit ? 'throttled' : 'synced',
        cache: store.getCacheMeta(),
      });
    },
  },

  {
    method: 'GET',
    path: '/api/v1/meters',
    handler: async ({ store, query }) => withCacheHeader(await store.queryMeters(query)),
  },
  {
    method: 'GET',
    path: '/api/v1/meters/:meterId/consumption',
    handler: async ({ store, query, params }) => {
      const { refresh } = parseFlags(query, ['refresh'], ['from', 'to']);
      return withCacheHeader(
        await store.getMeterConsumption(params.meterId, { from: query.from, to: query.to, refresh }),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/v1/meters/:meterId',
    handler: async ({ store, query, params }) => {
      const flags = parseFlags(query, ['refresh', 'includeSsrDetail']);
      return withCacheHeader(await store.getMeterById(params.meterId, flags));
    },
  },

  {
    method: 'GET',
    path: '/api/v1/transformers',
    handler: async ({ store, query }) => withCacheHeader(await store.queryTransformers(query)),
  },
  {
    method: 'GET',
    path: '/api/v1/transformers/:code',
    handler: async ({ store, query, params }) => {
      const flags = parseFlags(query, ['refresh']);
      return withCacheHeader(await store.getTransformerByCode(params.code, flags));
    },
  },

  {
    method: 'GET',
    path: '/api/v1/hierarchy',
    handler: async ({ store, query }) => withCacheHeader(await store.getHierarchy(parseFlags(query, ['refresh']))),
  },
  {
    method: 'GET',
    path: '/api/v1/anomalies',
    handler: async ({ store, query }) => withCacheHeader(await store.getAnomalies(parseFlags(query, ['refresh']))),
  },
];

/** Compiles `/a/:id/b` into a case-insensitive matcher with named captures. */
function compileRoute(route) {
  const keys = [];
  const source = route.path
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
  return { ...route, keys, pattern: new RegExp(`^${source}$`, 'i') };
}

const compiledRoutes = routes.map(compileRoute);

function matchRoutes(method, pathname) {
  const pathMatches = [];
  for (const route of compiledRoutes) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    if (route.method === method) {
      const params = {};
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(match[i + 1]);
        } catch {
          throw badRequest(`Malformed URL encoding in path segment "${match[i + 1]}".`);
        }
      });
      return { route, params };
    }
    pathMatches.push(route.method);
  }
  return { allowed: pathMatches };
}

/**
 * Maps any thrown value to an HTTP error response. Deliberate API errors keep
 * their status; portal failures become 502/504/429; everything else is a 500
 * whose internals are logged but never returned to the caller.
 */
function toErrorResponse(err, logger) {
  if (err instanceof ApiError) {
    return json(
      { error: { code: err.code, message: err.message, status: err.status, ...(err.details ? { details: err.details } : {}) } },
      {},
      err.status,
    );
  }

  let status = 500;
  let code = 'internal_error';
  let message = 'Unexpected error occurred.';
  if (err?.name === 'AbortError') {
    status = 504;
    code = 'upstream_timeout';
    message = 'The upstream portal did not respond in time.';
  } else if (err?.status === 429) {
    status = 429;
    code = 'upstream_rate_limited';
    message = 'The upstream portal is rate limiting requests. Retry shortly.';
  } else if (Number.isInteger(err?.status)) {
    status = 502;
    code = err.status === 401 ? 'upstream_unauthorized' : 'upstream_error';
    message = `The upstream portal request failed: ${err.message}`;
  }

  if (status >= 500) logger.error(`[${code}] ${err?.stack || err}`);
  return json({ error: { code, message, status } }, {}, status);
}

/**
 * Creates the HTTP request handler bound to a `UrjaDataStore` instance.
 * @param {object} store
 * @param {{ logger?: Pick<Console, 'error'> }} [options]
 */
export function createRequestHandler(store, { logger = console } = {}) {
  const startedAt = Date.now();

  return async function handleRequest(req, res) {
    let response;
    try {
      if (req.method === 'OPTIONS') {
        response = { status: 204, headers: {}, body: '' };
      } else {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        const query = Object.fromEntries(url.searchParams.entries());
        const { route, params, allowed } = matchRoutes(req.method, pathname);

        if (route) {
          response = await route.handler({ store, query, params, startedAt });
        } else if (allowed.length > 0) {
          response = json(
            { error: { code: 'method_not_allowed', message: `${req.method} is not allowed on ${pathname}.`, status: 405 } },
            { Allow: [...new Set(allowed)].join(', ') },
            405,
          );
        } else {
          response = json(
            {
              error: {
                code: 'not_found',
                message: `Route ${req.method} ${pathname} not found. See /docs or /openapi.json for available endpoints.`,
                status: 404,
              },
            },
            {},
            404,
          );
        }
      }
    } catch (err) {
      response = toErrorResponse(err, logger);
    }

    res.writeHead(response.status, { ...BASE_HEADERS, ...response.headers });
    res.end(response.body);
  };
}
