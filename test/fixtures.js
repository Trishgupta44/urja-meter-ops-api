import http from 'node:http';
import { createRequestHandler } from '../src/app.js';

/**
 * Shared test data: five meters and four transformers with known attributes,
 * so every filter, count and distance asserted in the suite can be checked by hand.
 *
 *   id       serial  make    phase  status          type          build   DT      notes
 *   J100000  SE33962 HPL     single Decommissioned  Whole Current legacy  DT-001  serial prefix != make
 *   J100003  L&84997 Genus   single Installed       Whole Current v2      DT-004  serial prefix != make, literal "&"
 *   J100004  SE65293 Secure  single Faulty          CT Operated   v2      DT-005
 *   J100040  GE11111 Genus   three  Installed       CT Operated   legacy  DT-001  daily telemetry
 *   J100400  GN31592 Genus   three  Installed       CT Operated   legacy  DT-007  DT name conflict + GN prefix
 */

const hierarchy = (circle, division, dt) => ({
  zone: { code: 'Z-01', name: 'Jaipur Zone 1' },
  circle: { code: `C-0${circle}`, name: `Circle ${circle}` },
  division: { code: `D-0${division}`, name: `Division ${division}` },
  subdivision: { code: `SD-0${division}`, name: `Subdivision ${division}` },
  substation: { code: `SS-0${division}`, name: `Substation ${division}` },
  feeder: { code: `F-00${division}`, name: `Feeder ${division}` },
  dt,
});

export const RAW_TRANSFORMERS = [
  { code: 'DT-001', name: 'Malviya Nagar DT 1', feederCode: 'F-001', capacityKva: 100 },
  { code: 'DT-004', name: 'Raja Park DT 4', feederCode: 'F-004', capacityKva: 400 },
  { code: 'DT-005', name: 'Bani Park DT 5', feederCode: 'F-005', capacityKva: 63 },
  { code: 'DT-007', name: 'Sanganer DT 7', feederCode: 'F-007', capacityKva: 250 },
];

export const RAW_METERS = [
  {
    meterId: 'J100000', serialNo: 'SE33962', make: 'HPL', phaseType: 'single',
    installStatus: 'Decommissioned', installType: 'Whole Current', build: 'legacy', dtCode: 'DT-001',
    hierarchy: hierarchy(1, 1, { code: 'DT-001', name: 'Malviya Nagar DT 1' }),
    geo: { lat: 26.8549, lng: 75.8243 },
  },
  {
    meterId: 'J100003', serialNo: 'L&84997', make: 'Genus', phaseType: 'single',
    installStatus: 'Installed', installType: 'Whole Current', build: 'v2', dtCode: 'DT-004',
    hierarchy: hierarchy(4, 4, { code: 'DT-004', name: 'Raja Park DT 4' }),
    geo: { lat: 26.9012, lng: 75.8295 },
  },
  {
    meterId: 'J100004', serialNo: 'SE65293', make: 'Secure', phaseType: 'single',
    installStatus: 'Faulty', installType: 'CT Operated', build: 'v2', dtCode: 'DT-005',
    hierarchy: hierarchy(5, 5, { code: 'DT-005', name: 'Bani Park DT 5' }),
    geo: { lat: 26.9124, lng: 75.7873 },
  },
  {
    meterId: 'J100040', serialNo: 'GE11111', make: 'Genus', phaseType: 'three',
    installStatus: 'Installed', installType: 'CT Operated', build: 'legacy', dtCode: 'DT-001',
    hierarchy: hierarchy(1, 1, { code: 'DT-001', name: 'Malviya Nagar DT 1' }),
    geo: { lat: 26.86, lng: 75.83 },
  },
  {
    meterId: 'J100400', serialNo: 'GN31592', make: 'Genus', phaseType: 'three',
    installStatus: 'Installed', installType: 'CT Operated', build: 'legacy', dtCode: 'DT-007',
    hierarchy: hierarchy(1, 7, { code: 'DT-007', name: 'Old Malviya Nagar Xfmr' }),
    geo: { lat: 26.88, lng: 75.74 },
  },
];

export const RAW_ENERGY = [
  { timestamp: '23/06/2026 23:30', kwh: '100.0', kvah: '110.0', voltR: '230' },
  { timestamp: '24/06/2026 00:00', kwh: '100.5', kvah: '110.6', voltR: '231' },
];

const clone = (value) => structuredClone(value);

/**
 * A stand-in for `PortalClient`. `calls` counts upstream requests; pass overrides
 * to simulate latency or failures.
 */
export function makeMockClient(overrides = {}) {
  const calls = { bulk: 0, transformers: 0, energy: 0, ssr: 0 };
  return {
    baseUrl: 'https://portal.test',
    hasValidSession: () => true,
    stats: { totalRequests: 0, loginCount: 1, reauthCount: 0, rateLimitHits: 0, retries: 0 },
    calls,
    fetchAllMetersBulk: async () => { calls.bulk += 1; return clone(RAW_METERS); },
    fetchAllTransformers: async () => { calls.transformers += 1; return clone(RAW_TRANSFORMERS); },
    fetchMeterEnergy: async () => { calls.energy += 1; return clone(RAW_ENERGY); },
    fetchMeterSsrDetail: async () => {
      calls.ssr += 1;
      return { detail: { data: [{ parameterName: 'Meter ID', parameterValue: 'J100000' }] } };
    },
    ...overrides,
  };
}

/** A controllable clock for the store's injectable `now`. */
export function fakeClock(start = 1_000_000) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => { current += ms; };
  return now;
}

/** Starts the real HTTP handler on an ephemeral port. */
export async function startApi(store, options) {
  const server = http.createServer(createRequestHandler(store, options));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    get: (path, init) => fetch(`${base}${path}`, init),
    getJson: async (path) => {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, headers: res.headers, body: await res.json() };
    },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
