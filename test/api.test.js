import test from 'node:test';
import assert from 'node:assert/strict';

import { UrjaDataStore } from '../src/store.js';
import { routes } from '../src/app.js';
import { openApiSpec } from '../src/openapi.js';
import { METER_QUERY_PARAMS, TRANSFORMER_QUERY_PARAMS } from '../src/queries.js';
import { fakeClock, makeMockClient, startApi } from './fixtures.js';

/** Boots the API against a mock portal client; always closes the server afterwards. */
async function withApi(run, { client = makeMockClient(), storeOptions = {}, appOptions } = {}) {
  const store = new UrjaDataStore(client, storeOptions);
  const api = await startApi(store, appOptions);
  try {
    await run(api, { store, client });
  } finally {
    await api.close();
  }
}

const quietLogger = () => {
  const errors = [];
  return { errors, error: (msg) => errors.push(String(msg)) };
};

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test('meters: search a serial containing a literal "&", filter, and geo-search', async () => {
  await withApi(async (api) => {
    const search = await api.getJson(`/api/v1/meters?q=${encodeURIComponent('L&84997')}`);
    assert.equal(search.status, 200);
    assert.equal(search.body.pagination.total, 1);
    assert.equal(search.body.data[0].meterId, 'J100003');

    const faulty = await api.getJson('/api/v1/meters?status=faulty&make=secure');
    assert.deepEqual(faulty.body.data.map((m) => m.meterId), ['J100004']);
    assert.equal(faulty.body.facets.byStatus.Faulty, 1);

    const geo = await api.getJson('/api/v1/meters?nearLat=26.8549&nearLng=75.8243&radiusKm=2');
    assert.deepEqual(geo.body.data.map((m) => m.meterId), ['J100000', 'J100040']);
    assert.equal(geo.body.data[0].distanceKm, 0);
  });
});

test('meter detail, consumption and transformer endpoints return normalized data', async () => {
  await withApi(async (api) => {
    const detail = await api.getJson('/api/v1/meters/j100003');
    assert.equal(detail.body.data.serialNo, 'L&84997');
    assert.equal(detail.body.data.transformer.capacityKva, 400);

    const consumption = await api.getJson('/api/v1/meters/J100000/consumption?from=2026-06-01&to=2026-06-30');
    assert.equal(consumption.body.data.granularity, '30m');
    assert.equal(consumption.body.data.summary.totalConsumptionKwh, 0.5);
    assert.equal(consumption.body.meta.window.isPortalDefault, false);

    const dt = await api.getJson('/api/v1/transformers/DT-007');
    assert.equal(dt.body.data.name, 'Sanganer DT 7');
    assert.deepEqual(dt.body.data.aliases, ['Old Malviya Nagar Xfmr']);

    const list = await api.getJson('/api/v1/transformers?minCapacityKva=250');
    assert.deepEqual(list.body.data.map((t) => t.code), ['DT-004', 'DT-007']);

    const hierarchy = await api.getJson('/api/v1/hierarchy');
    assert.equal(hierarchy.body.data.dtPaths.length, 4);

    const anomalies = await api.getJson('/api/v1/anomalies');
    assert.equal(anomalies.body.data.dtNameConflicts, 1);
    assert.equal(anomalies.body.data.nonStandardSerialPrefixes, 1);
  });
});

test('responses carry cache provenance in meta and the X-Cache header', async () => {
  await withApi(async (api) => {
    const first = await api.getJson('/api/v1/meters');
    assert.equal(first.headers.get('x-cache'), 'MISS');
    assert.equal(first.body.meta.cacheHit, false);

    const second = await api.getJson('/api/v1/meters');
    assert.equal(second.headers.get('x-cache'), 'HIT');
    assert.equal(second.body.meta.staleFallback, false);
  });
});

test('health reports ok, then degraded with a stale-data warning when the portal fails', async () => {
  const now = fakeClock();
  const client = makeMockClient();
  await withApi(async (api, { store }) => {
    assert.equal((await api.getJson('/api/v1/health')).body.status, 'ok');

    await api.getJson('/api/v1/meters'); // fill the cache
    now.advance(10_000); // past the TTL
    client.fetchAllMetersBulk = async () => { throw new Error('portal down'); };

    const stale = await api.getJson('/api/v1/meters');
    assert.equal(stale.status, 200, 'cached data is still served');
    assert.equal(stale.headers.get('x-cache'), 'STALE');
    assert.equal(stale.body.meta.staleFallback, true);

    const health = await api.getJson('/api/v1/health');
    assert.equal(health.body.status, 'degraded');
    assert.equal(health.body.cache.lastRefreshError.message, 'portal down');
    assert.equal(health.body.upstreamPortal.baseUrl, 'https://portal.test');
    assert.ok(store.getCacheMeta().isStale);
  }, { client, storeOptions: { now, indexTtlMs: 1_000 } });
});

test('POST /api/v1/sync syncs once and then reports throttled', async () => {
  const now = fakeClock();
  await withApi(async (api, { client }) => {
    const first = await (await api.get('/api/v1/sync', { method: 'POST' })).json();
    assert.equal(first.status, 'synced');
    const second = await (await api.get('/api/v1/sync', { method: 'POST' })).json();
    assert.equal(second.status, 'throttled');
    assert.equal(client.calls.bulk, 1);
  }, { storeOptions: { now, minForceRefreshIntervalMs: 5_000 } });
});

test('the dashboard, docs page, spec and CORS preflight are served', async () => {
  await withApi(async (api) => {
    const home = await api.get('/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(await home.text(), /<html/);

    const docs = await api.get('/docs');
    assert.match(await docs.text(), /api-reference/);

    const spec = await (await api.get('/openapi.json')).json();
    assert.equal(spec.openapi, '3.1.0');

    const preflight = await api.get('/api/v1/meters', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.equal(preflight.headers.get('x-content-type-options'), 'nosniff');
  });
});

// ---------------------------------------------------------------------------
// Client errors
// ---------------------------------------------------------------------------

test('invalid input is a 400 with a stable error code and helpful details', async () => {
  await withApi(async (api) => {
    const badEnum = await api.getJson('/api/v1/meters?status=bogus');
    assert.equal(badEnum.status, 400);
    assert.equal(badEnum.body.error.code, 'bad_request');
    assert.deepEqual(badEnum.body.error.details.allowed, ['Decommissioned', 'Faulty', 'Installed']);

    const typo = await api.getJson('/api/v1/meters?lat=26.9&lng=75.8');
    assert.equal(typo.status, 400);
    assert.deepEqual(typo.body.error.details.unknown, ['lat', 'lng']);

    for (const path of [
      '/api/v1/meters?limit=abc',
      '/api/v1/meters?nearLat=26.9',
      '/api/v1/meters?sortBy=nope',
      '/api/v1/meters?hasAnomaly=maybe',
      '/api/v1/meters?refresh=yes',
      '/api/v1/meters/J100000/consumption?from=06-01-2026',
      '/api/v1/meters/J100000/consumption?from=2026-13-45',
      '/api/v1/meters/J100000/consumption?from=2026-06-30&to=2026-06-01',
      '/api/v1/meters/J100000?bogus=1',
      '/api/v1/transformers?minCapacityKva=big',
      '/api/v1/hierarchy?x=1',
      '/api/v1/meters/%E0%A4%A',
    ]) {
      const res = await api.getJson(path);
      assert.equal(res.status, 400, `${path} should be a 400`);
      assert.equal(res.body.error.status, 400);
    }
  });
});

test('unknown meters, transformers and routes are 404s', async () => {
  await withApi(async (api) => {
    assert.equal((await api.getJson('/api/v1/meters/J999999')).status, 404);
    assert.equal((await api.getJson('/api/v1/meters/J999999/consumption')).status, 404);
    assert.equal((await api.getJson('/api/v1/transformers/DT-999')).status, 404);
    const missing = await api.getJson('/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
  });
});

test('a known path with the wrong method is a 405 listing the allowed methods', async () => {
  await withApi(async (api) => {
    const res = await api.get('/api/v1/meters', { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
    assert.equal((await res.json()).error.code, 'method_not_allowed');

    const sync = await api.get('/api/v1/sync');
    assert.equal(sync.status, 405);
    assert.equal(sync.headers.get('allow'), 'POST');
  });
});

// ---------------------------------------------------------------------------
// Upstream and internal failures
// ---------------------------------------------------------------------------

test('portal failures map to 429, 502 and 504; internal bugs map to 500 without leaking details', async () => {
  const cases = [
    { error: Object.assign(new Error('slow down'), { status: 429 }), status: 429, code: 'upstream_rate_limited' },
    { error: Object.assign(new Error('Unauthorized'), { status: 401 }), status: 502, code: 'upstream_unauthorized' },
    { error: Object.assign(new Error('Portal HTTP 503'), { status: 503 }), status: 502, code: 'upstream_error' },
    { error: Object.assign(new Error('aborted'), { name: 'AbortError' }), status: 504, code: 'upstream_timeout' },
    { error: new Error('secret internal detail'), status: 500, code: 'internal_error' },
  ];

  for (const { error, status, code } of cases) {
    const logger = quietLogger();
    const client = makeMockClient({ fetchAllMetersBulk: async () => { throw error; } });
    await withApi(async (api) => {
      const res = await api.getJson('/api/v1/meters');
      assert.equal(res.status, status, code);
      assert.equal(res.body.error.code, code);
      if (status === 500) {
        assert.ok(!res.body.error.message.includes('secret'), 'internals are not returned to the caller');
        assert.equal(logger.errors.length, 1, 'internal errors are logged');
      }
    }, { client, appOptions: { logger } });
  }
});

test('an upstream failure on a forced sync is reported, not hidden', async () => {
  const now = fakeClock();
  const client = makeMockClient();
  await withApi(async (api) => {
    await api.getJson('/api/v1/meters');
    now.advance(10_000);
    client.fetchAllMetersBulk = async () => { throw Object.assign(new Error('Portal HTTP 500'), { status: 500 }); };
    const res = await api.get('/api/v1/sync', { method: 'POST' });
    assert.equal(res.status, 502);
  }, { client, appOptions: { logger: quietLogger() }, storeOptions: { now, minForceRefreshIntervalMs: 100 } });
});

// ---------------------------------------------------------------------------
// The contract: router and OpenAPI document must agree
// ---------------------------------------------------------------------------

const apiRoutes = routes.filter((r) => r.path.startsWith('/api/v1/'));
const toOpenApiPath = (p) => p.replace(/:([A-Za-z]+)/g, '{$1}');

test('every API route is documented in openapi.json, and every documented operation is routed', () => {
  const routed = new Set(apiRoutes.map((r) => `${r.method} ${toOpenApiPath(r.path)}`));
  const documented = new Set(
    Object.entries(openApiSpec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)),
  );
  assert.deepEqual([...routed].sort(), [...documented].sort());
});

test('documented query parameters match what the endpoints accept', () => {
  const queryParams = (path) =>
    openApiSpec.paths[path].get.parameters.filter((p) => p.in === 'query').map((p) => p.name).sort();
  assert.deepEqual(queryParams('/api/v1/meters'), [...METER_QUERY_PARAMS].sort());
  assert.deepEqual(queryParams('/api/v1/transformers'), [...TRANSFORMER_QUERY_PARAMS].sort());
});

test('every $ref in the OpenAPI document resolves', () => {
  const refs = [...new Set(JSON.stringify(openApiSpec).match(/#\/components\/[A-Za-z]+\/[A-Za-z]+/g))];
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    const target = ref.slice(2).split('/').reduce((node, key) => node?.[key], openApiSpec);
    assert.ok(target, `${ref} is defined`);
  }
});

test('the committed openapi.json is in sync with the code', async () => {
  const { readFile } = await import('node:fs/promises');
  const committed = JSON.parse(await readFile(new URL('../openapi.json', import.meta.url), 'utf8'));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(openApiSpec)),
    'run `npm run generate:openapi` and commit the result');
});
