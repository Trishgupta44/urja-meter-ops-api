import test from 'node:test';
import assert from 'node:assert/strict';

import { UrjaDataStore } from '../src/store.js';
import { ApiError } from '../src/errors.js';
import { fakeClock, makeMockClient } from './fixtures.js';

const TTL = 1_000;
const COOLDOWN = 500;
const MIN_FORCE = 200;

function makeStore(clientOverrides = {}, options = {}) {
  const now = fakeClock();
  const client = makeMockClient(clientOverrides);
  const store = new UrjaDataStore(client, {
    now,
    indexTtlMs: TTL,
    energyTtlMs: TTL,
    refreshCooldownMs: COOLDOWN,
    minForceRefreshIntervalMs: MIN_FORCE,
    ...options,
  });
  return { store, client, now };
}

const failingBulk = (message = 'portal down') => async () => { throw new Error(message); };

// ---------------------------------------------------------------------------
// Snapshot freshness
// ---------------------------------------------------------------------------

test('the index is fetched once and served from cache within the TTL', async () => {
  const { store, client, now } = makeStore();
  const first = await store.queryMeters({});
  assert.equal(first.meta.cacheHit, false);
  assert.equal(client.calls.bulk, 1);

  now.advance(TTL - 1);
  const second = await store.queryMeters({});
  assert.equal(second.meta.cacheHit, true);
  assert.equal(second.meta.staleFallback, false);
  assert.equal(client.calls.bulk, 1);
  assert.equal(client.calls.transformers, 1);
});

test('the index is re-fetched once the TTL has elapsed', async () => {
  const { store, client, now } = makeStore();
  await store.queryMeters({});
  now.advance(TTL + 1);
  const result = await store.queryMeters({});
  assert.equal(result.meta.cacheHit, false);
  assert.equal(client.calls.bulk, 2);
});

test('concurrent requests share a single upstream sync', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { store, client } = makeStore();
  const original = client.fetchAllMetersBulk;
  client.fetchAllMetersBulk = async () => { await gate; return original(); };

  const pending = Array.from({ length: 5 }, () => store.queryMeters({}));
  release();
  const results = await Promise.all(pending);

  assert.equal(client.calls.bulk, 1);
  assert.ok(results.every((r) => r.pagination.total === 5));
});

// ---------------------------------------------------------------------------
// Stale-while-error
// ---------------------------------------------------------------------------

test('a failed first load is an error, because there is nothing to fall back on', async () => {
  const { store } = makeStore({ fetchAllMetersBulk: failingBulk() });
  await assert.rejects(() => store.queryMeters({}), /portal down/);
});

test('when a refresh fails the last good snapshot is served and flagged stale', async () => {
  const { store, client, now } = makeStore();
  await store.queryMeters({});
  now.advance(TTL + 1);
  client.fetchAllMetersBulk = failingBulk('boom');

  const result = await store.queryMeters({});
  assert.equal(result.pagination.total, 5, 'data is still served');
  assert.equal(result.meta.staleFallback, true);
  assert.equal(result.meta.cacheHit, true);
  assert.equal(result.meta.lastRefreshError.message, 'boom');
  assert.equal(store.getCacheMeta().isStale, true);
});

test('after a failed refresh the portal is not retried until the cooldown ends', async () => {
  const { store, client, now } = makeStore();
  await store.queryMeters({});
  now.advance(TTL + 1);

  let attempts = 0;
  client.fetchAllMetersBulk = async () => { attempts += 1; throw new Error('boom'); };

  await store.queryMeters({});
  assert.equal(attempts, 1);

  for (let i = 0; i < 10; i++) await store.queryMeters({});
  assert.equal(attempts, 1, 'requests during the cooldown do not hit the portal');
  assert.ok(store.getCacheMeta().nextRefreshAttemptAt, 'the next attempt time is exposed');

  now.advance(COOLDOWN + 1);
  const result = await store.queryMeters({});
  assert.equal(attempts, 2, 'one new attempt once the cooldown has passed');
  assert.equal(result.meta.staleFallback, true);
});

test('every caller waiting on a failed shared refresh is told the data is stale', async () => {
  const { store, client, now } = makeStore();
  await store.queryMeters({});
  now.advance(TTL + 1);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  client.fetchAllMetersBulk = async () => { await gate; throw new Error('boom'); };

  const pending = Array.from({ length: 4 }, () => store.queryMeters({}));
  release();
  const results = await Promise.all(pending);
  assert.ok(results.every((r) => r.meta.staleFallback === true));
});

test('recovery clears the stale state and the recorded error', async () => {
  const { store, client, now } = makeStore();
  const healthy = client.fetchAllMetersBulk;
  await store.queryMeters({});
  now.advance(TTL + 1);
  client.fetchAllMetersBulk = failingBulk();
  await store.queryMeters({});

  client.fetchAllMetersBulk = healthy;
  now.advance(COOLDOWN + 1);
  const result = await store.queryMeters({});
  assert.equal(result.meta.staleFallback, false);
  assert.equal(store.getCacheMeta().lastRefreshError, null);
  assert.equal(store.getCacheMeta().nextRefreshAttemptAt, null);
});

// ---------------------------------------------------------------------------
// Forced refresh
// ---------------------------------------------------------------------------

test('a forced refresh is throttled so callers cannot hammer the portal', async () => {
  const { store, client, now } = makeStore();
  await store.ensureIndex();
  const throttled = await store.ensureIndex({ forceRefresh: true });
  assert.equal(throttled.cacheHit, true);
  assert.equal(client.calls.bulk, 1);

  now.advance(MIN_FORCE);
  const refreshed = await store.ensureIndex({ forceRefresh: true });
  assert.equal(refreshed.cacheHit, false);
  assert.equal(client.calls.bulk, 2);
});

test('a forced refresh surfaces upstream failures instead of hiding them behind stale data', async () => {
  const { store, client, now } = makeStore();
  await store.ensureIndex();
  now.advance(MIN_FORCE);
  client.fetchAllMetersBulk = failingBulk('still down');
  await assert.rejects(() => store.ensureIndex({ forceRefresh: true }), /still down/);
  assert.equal((await store.queryMeters({})).pagination.total, 5, 'normal reads keep working');
});

test('refresh=true is validated and honoured through the query API', async () => {
  const { store, now } = makeStore();
  await store.queryMeters({});
  now.advance(MIN_FORCE);
  const result = await store.queryMeters({ refresh: 'true' });
  assert.equal(result.meta.cacheHit, false);
  await assert.rejects(() => store.queryMeters({ refresh: 'yes' }), (err) => err.status === 400);
});

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

test('meter and transformer lookups are case-insensitive and 404 when unknown', async () => {
  const { store } = makeStore();
  assert.equal((await store.getMeterById('j100003')).data.serialNo, 'L&84997');
  assert.equal((await store.getTransformerByCode('dt-001')).data.meters.length, 2);
  await assert.rejects(() => store.getMeterById('J999999'), (err) => err instanceof ApiError && err.status === 404);
  await assert.rejects(() => store.getTransformerByCode('DT-999'), (err) => err instanceof ApiError && err.status === 404);
});

test('meter detail embeds its transformer, and optionally the decoded SSR nameplate', async () => {
  const { store, client } = makeStore();
  const plain = await store.getMeterById('J100000');
  assert.equal(plain.data.transformer.capacityKva, 100);
  assert.equal(plain.data.ssrNameplate, undefined);
  assert.equal(client.calls.ssr, 0);

  const verified = await store.getMeterById('J100000', { includeSsrDetail: true });
  assert.equal(verified.data.ssrNameplate.schemaFormat, 'legacy_parameterList');
  assert.equal(client.calls.ssr, 1);
});

test('the DT-007 name conflict is reconciled and kept as an alias', async () => {
  const { store } = makeStore();
  const { data } = await store.getTransformerByCode('DT-007');
  assert.equal(data.name, 'Sanganer DT 7');
  assert.deepEqual(data.aliases, ['Old Malviya Nagar Xfmr']);
});

// ---------------------------------------------------------------------------
// Telemetry cache
// ---------------------------------------------------------------------------

test('telemetry is cached per (meter, window) until its TTL expires', async () => {
  const { store, client, now } = makeStore();
  const first = await store.getMeterConsumption('J100000', { from: '2026-06-01', to: '2026-06-30' });
  assert.equal(first.meta.cacheHit, false);
  assert.deepEqual(first.meta.window, { from: '2026-06-01', to: '2026-06-30', isPortalDefault: false });

  const second = await store.getMeterConsumption('J100000', { from: '2026-06-01', to: '2026-06-30' });
  assert.equal(second.meta.cacheHit, true);
  assert.equal(client.calls.energy, 1);

  await store.getMeterConsumption('J100000', {});
  assert.equal(client.calls.energy, 2, 'a different window is a different cache entry');
  assert.equal((await store.getMeterConsumption('J100000', {})).meta.window.isPortalDefault, true);

  now.advance(TTL + 1);
  await store.getMeterConsumption('J100000', { from: '2026-06-01', to: '2026-06-30' });
  assert.equal(client.calls.energy, 3, 'expired entries are re-fetched');
});

test('refresh=true bypasses the telemetry cache', async () => {
  const { store, client } = makeStore();
  await store.getMeterConsumption('J100000', {});
  await store.getMeterConsumption('J100000', { refresh: true });
  assert.equal(client.calls.energy, 2);
});

test('identical concurrent telemetry requests share one upstream call', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { store, client } = makeStore();
  const original = client.fetchMeterEnergy;
  client.fetchMeterEnergy = async (...args) => { await gate; return original(...args); };

  const pending = Array.from({ length: 4 }, () => store.getMeterConsumption('J100000', {}));
  await store.queryMeters({}); // let the index load while the telemetry call is held
  release();
  await Promise.all(pending);
  assert.equal(client.calls.energy, 1);
});

test('the telemetry cache is bounded and evicts the oldest entries', async () => {
  const { store } = makeStore({}, { energyCacheMaxEntries: 2 });
  for (const meterId of ['J100000', 'J100003', 'J100004']) {
    await store.getMeterConsumption(meterId, {});
  }
  assert.equal(store.energyCache.size, 2);
  assert.ok(!store.energyCache.has('J100000:default:default'), 'the oldest entry was evicted');
  assert.equal(store.getCacheMeta().energyCacheEntries, 2);
});

test('telemetry parameters are validated before the portal is called', async () => {
  const { store, client } = makeStore();
  const bad = (opts) => assert.rejects(() => store.getMeterConsumption('J100000', opts), (err) => err.status === 400);
  await bad({ from: '06-01-2026' });
  await bad({ from: '2026-13-45' });
  await bad({ to: '2026-02-30' });
  await bad({ from: '2026-06-30', to: '2026-06-01' });
  assert.equal(client.calls.energy, 0);
  await assert.rejects(() => store.getMeterConsumption('J999999', {}), (err) => err.status === 404);
});

test('a leap day is accepted and a non-leap one is not', async () => {
  const { store } = makeStore();
  await store.getMeterConsumption('J100000', { from: '2028-02-29' });
  await assert.rejects(() => store.getMeterConsumption('J100000', { from: '2026-02-29' }), (err) => err.status === 400);
});
