import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileDataset } from '../src/normalizer.js';
import { ApiError } from '../src/errors.js';
import {
  computeMeterFacets,
  filterMeters,
  filterTransformers,
  paginate,
  parseMeterQuery,
  parseTransformerQuery,
} from '../src/queries.js';
import { RAW_METERS, RAW_TRANSFORMERS } from './fixtures.js';

const dataset = reconcileDataset(structuredClone(RAW_METERS), structuredClone(RAW_TRANSFORMERS));
const { meters, transformers } = dataset;

const run = (params) => filterMeters(meters, parseMeterQuery(params, meters)).map((m) => m.meterId);
const rejects400 = (fn, pattern) =>
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ApiError, 'expected an ApiError');
    assert.equal(err.status, 400);
    assert.equal(err.code, 'bad_request');
    if (pattern) assert.match(err.message, pattern);
    return true;
  });

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test('no filters returns every meter in meterId order', () => {
  assert.deepEqual(run({}), ['J100000', 'J100003', 'J100004', 'J100040', 'J100400']);
});

test('text search matches ids, serials (including a literal "&"), DT and make, case-insensitively', () => {
  assert.deepEqual(run({ q: 'L&84997' }), ['J100003']);
  assert.deepEqual(run({ q: 'j10004' }), ['J100040']);
  assert.deepEqual(run({ q: 'raja park' }), ['J100003']);
  assert.deepEqual(run({ q: 'hpl' }), ['J100000']);
  assert.deepEqual(run({ q: '   ' }), run({}), 'a blank query means no filter');
});

test('enum filters accept comma-separated, case-insensitive values', () => {
  assert.deepEqual(run({ status: 'faulty' }), ['J100004']);
  assert.deepEqual(run({ status: 'FAULTY, decommissioned' }), ['J100000', 'J100004']);
  assert.deepEqual(run({ make: 'genus', phase: 'three' }), ['J100040', 'J100400']);
  assert.deepEqual(run({ installType: 'CT Operated', build: 'v2' }), ['J100004']);
  assert.deepEqual(run({ granularity: 'daily' }), ['J100040', 'J100400']);
});

test('an enum value that never occurs in the data is a 400 listing the allowed values', () => {
  assert.throws(
    () => parseMeterQuery({ status: 'bogus' }, meters),
    (err) => {
      assert.equal(err.status, 400);
      assert.deepEqual(err.details.allowed, ['Decommissioned', 'Faulty', 'Installed']);
      return true;
    },
  );
  rejects400(() => parseMeterQuery({ make: 'HPL,Nope' }, meters), /Nope/);
});

test('hierarchy filters match a code exactly or a name by substring', () => {
  assert.deepEqual(run({ circle: 'C-04' }), ['J100003']);
  assert.deepEqual(run({ division: 'division 7' }), ['J100400']);
  assert.deepEqual(run({ zone: 'Z-01' }).length, 5);
  assert.deepEqual(run({ dt: 'DT-001' }), ['J100000', 'J100040']);
  assert.deepEqual(run({ circle: 'C-0' }), [], 'a code must match exactly');
});

test('data-quality flags filter on healed anomalies and serial/make mismatches', () => {
  assert.deepEqual(run({ hasAnomaly: 'true' }), ['J100400']);
  assert.equal(run({ hasAnomaly: 'false' }).length, 4);
  assert.deepEqual(run({ serialMismatch: 'true' }), ['J100000', 'J100003']);
  rejects400(() => parseMeterQuery({ hasAnomaly: 'maybe' }, meters), /true.*false/);
});

// ---------------------------------------------------------------------------
// Geospatial search
// ---------------------------------------------------------------------------

test('geo search returns nearest-first results with distanceKm', () => {
  const results = filterMeters(meters, parseMeterQuery({ nearLat: '26.8549', nearLng: '75.8243', radiusKm: '2' }, meters));
  assert.deepEqual(results.map((m) => m.meterId), ['J100000', 'J100040']);
  assert.equal(results[0].distanceKm, 0);
  assert.ok(results[1].distanceKm > 0 && results[1].distanceKm < 2);
});

test('geo search defaults to a 5 km radius and respects explicit radii', () => {
  const near = { nearLat: '26.8549', nearLng: '75.8243' };
  assert.ok(!run(near).includes('J100003'), 'J100003 is ~5.2 km away');
  assert.ok(run({ ...near, radiusKm: '6' }).includes('J100003'));
  assert.deepEqual(run({ ...near, radiusKm: '0' }), ['J100000']);
});

test('geo search composes with attribute filters', () => {
  assert.deepEqual(run({ nearLat: '26.8549', nearLng: '75.8243', radiusKm: '2', phase: 'three' }), ['J100040']);
});

test('geo parameters are validated', () => {
  rejects400(() => parseMeterQuery({ nearLat: '26.8' }, meters), /together/);
  rejects400(() => parseMeterQuery({ nearLng: '75.8' }, meters), /together/);
  rejects400(() => parseMeterQuery({ radiusKm: '3' }, meters), /requires/);
  rejects400(() => parseMeterQuery({ nearLat: 'abc', nearLng: '75' }, meters), /nearLat/);
  rejects400(() => parseMeterQuery({ nearLat: '91', nearLng: '75' }, meters), /nearLat/);
  rejects400(() => parseMeterQuery({ nearLat: '26', nearLng: '181' }, meters), /nearLng/);
  rejects400(() => parseMeterQuery({ nearLat: '26', nearLng: '75', radiusKm: '-1' }, meters), /radiusKm/);
});

// ---------------------------------------------------------------------------
// Sorting, strictness, paging
// ---------------------------------------------------------------------------

test('sorting supports ascending and descending, and distanceKm with a geo search', () => {
  assert.deepEqual(run({ sortBy: 'installStatus', sortOrder: 'desc' }).slice(0, 1), ['J100003'], 'Installed sorts last ascending, so first descending');
  assert.deepEqual(run({ sortBy: 'meterId', sortOrder: 'desc' }), ['J100400', 'J100040', 'J100004', 'J100003', 'J100000']);
  const byDistanceDesc = run({ nearLat: '26.8549', nearLng: '75.8243', radiusKm: '20', sortBy: 'distanceKm', sortOrder: 'desc' });
  assert.equal(byDistanceDesc[0], 'J100400', 'farthest meter (~8.8 km) comes first');
});

test('invalid sort parameters are rejected', () => {
  rejects400(() => parseMeterQuery({ sortBy: 'nope' }, meters), /sortBy/);
  rejects400(() => parseMeterQuery({ sortBy: 'distanceKm' }, meters), /requires/);
  rejects400(() => parseMeterQuery({ sortBy: 'meterId', sortOrder: 'sideways' }, meters), /sortOrder/);
  rejects400(() => parseMeterQuery({ sortOrder: 'desc' }, meters), /requires "sortBy"/);
});

test('unknown query parameters are rejected so typos fail loudly', () => {
  assert.throws(
    () => parseMeterQuery({ lat: '26.9', lng: '75.8' }, meters),
    (err) => {
      assert.equal(err.status, 400);
      assert.deepEqual(err.details.unknown, ['lat', 'lng']);
      assert.ok(err.details.supported.includes('nearLat'));
      return true;
    },
  );
  rejects400(() => parseTransformerQuery({ capacity: '100' }), /capacity/);
});

test('pagination defaults, clamps and validates', () => {
  const all = ['a', 'b', 'c', 'd', 'e'];
  const { paging } = parseMeterQuery({}, meters);
  assert.deepEqual(paging, { page: 1, limit: 20 });

  const page2 = paginate(all, { page: 2, limit: 2 });
  assert.deepEqual(page2.data, ['c', 'd']);
  assert.deepEqual(page2.pagination, { total: 5, page: 2, limit: 2, totalPages: 3, hasNextPage: true, hasPrevPage: true });

  assert.equal(paginate(all, { page: 99, limit: 2 }).pagination.page, 3, 'a page beyond the end clamps to the last page');
  assert.equal(paginate([], { page: 1, limit: 20 }).pagination.totalPages, 1);

  assert.equal(parseMeterQuery({ limit: '9999' }, meters).paging.limit, 500, 'limit clamps to the maximum');
  rejects400(() => parseMeterQuery({ limit: 'abc' }, meters), /limit/);
  rejects400(() => parseMeterQuery({ limit: '0' }, meters), /limit/);
  rejects400(() => parseMeterQuery({ limit: '2.5' }, meters), /limit/);
  rejects400(() => parseMeterQuery({ page: '-1' }, meters), /page/);
});

test('facets count each attribute over the filtered set', () => {
  const facets = computeMeterFacets(meters);
  assert.deepEqual(facets.byStatus, { Decommissioned: 1, Installed: 3, Faulty: 1 });
  assert.deepEqual(facets.byMake, { HPL: 1, Genus: 3, Secure: 1 });
  assert.deepEqual(facets.byPhase, { single: 3, three: 2 });
  assert.deepEqual(facets.byBuild, { legacy: 3, v2: 2 });
  assert.deepEqual(facets.byZone, { 'Z-01': 5 });
  assert.deepEqual(computeMeterFacets(filterMeters(meters, parseMeterQuery({ status: 'Installed' }, meters))).byStatus, { Installed: 3 });
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

test('transformer filters: text, feeder, zone and minimum capacity', () => {
  const codes = (params) => filterTransformers(transformers, parseTransformerQuery(params)).map((t) => t.code);
  assert.deepEqual(codes({}), ['DT-001', 'DT-004', 'DT-005', 'DT-007']);
  assert.deepEqual(codes({ q: 'raja' }), ['DT-004']);
  assert.deepEqual(codes({ feeder: 'f-005' }), ['DT-005']);
  assert.deepEqual(codes({ minCapacityKva: '250' }), ['DT-004', 'DT-007']);
  assert.deepEqual(codes({ zone: 'Z-01' }).length, 4);
  assert.deepEqual(codes({ zone: 'Z-99' }), []);
  rejects400(() => parseTransformerQuery({ minCapacityKva: 'big' }), /minCapacityKva/);
  rejects400(() => parseTransformerQuery({ minCapacityKva: '-5' }), /minCapacityKva/);
});

test('transformer page size is capped at 100', () => {
  assert.equal(parseTransformerQuery({ limit: '1000' }).paging.limit, 100);
});
