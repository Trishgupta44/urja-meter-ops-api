import test from 'node:test';
import assert from 'node:assert/strict';

import {
  haversineDistanceKm,
  normalizeEnergyReadings,
  normalizeSsrDetailPayload,
  parsePortalTimestamp,
  reconcileDataset,
} from '../src/normalizer.js';
import { decodeSvelteKitDataNode } from '../src/portalClient.js';
import { RAW_METERS, RAW_TRANSFORMERS } from './fixtures.js';

// ---------------------------------------------------------------------------
// Portal payload decoding
// ---------------------------------------------------------------------------

test('normalizeSsrDetailPayload handles both legacy parameter lists and v2 classData JSON', () => {
  const legacy = normalizeSsrDetailPayload({
    data: [
      { parameterName: 'Meter ID', parameterValue: 'J100000' },
      { parameterName: 'Make', parameterValue: 'HPL' },
    ],
  });
  assert.equal(legacy.schemaFormat, 'legacy_parameterList');
  assert.equal(legacy.fields['Meter ID'], 'J100000');

  const v2 = normalizeSsrDetailPayload({
    classData: JSON.stringify({ installed_meter: { MeterId: 'J100004', Make: 'Genus' } }),
  });
  assert.equal(v2.schemaFormat, 'v2_classData');
  assert.equal(v2.fields.MeterId, 'J100004');
});

test('normalizeSsrDetailPayload degrades safely on malformed input', () => {
  assert.deepEqual(normalizeSsrDetailPayload(null), {});
  assert.equal(normalizeSsrDetailPayload({ classData: '{not json' }).schemaFormat, 'v2_classData_invalid');
  assert.equal(normalizeSsrDetailPayload({ something: 'else' }).schemaFormat, 'unknown');
  assert.deepEqual(normalizeSsrDetailPayload({ classData: '{}' }).fields, {});
});

test('decodeSvelteKitDataNode reconstructs nested objects from a devalue array', () => {
  const decoded = decodeSvelteKitDataNode([{ user: 1 }, { name: 2, email: 3 }, 'Ops Desk', 'operator@urja.local']);
  assert.deepEqual(decoded, { user: { name: 'Ops Desk', email: 'operator@urja.local' } });
  assert.equal(decodeSvelteKitDataNode([]), null);
  assert.equal(decodeSvelteKitDataNode(null), null);
});

test('parsePortalTimestamp converts DD/MM/YYYY HH:mm to ISO-8601 in IST', () => {
  assert.equal(parsePortalTimestamp('30/06/2026 23:30'), '2026-06-30T23:30:00+05:30');
  assert.equal(parsePortalTimestamp('  01/06/2026 00:00 '), '2026-06-01T00:00:00+05:30');
  assert.equal(parsePortalTimestamp('2026-06-30'), null);
  assert.equal(parsePortalTimestamp(undefined), null);
});

test('haversineDistanceKm matches known great-circle distances', () => {
  assert.equal(haversineDistanceKm(26.9, 75.8, 26.9, 75.8), 0);
  assert.ok(Math.abs(haversineDistanceKm(0, 0, 1, 0) - 111.19) < 0.1, 'one degree of latitude is ~111.19 km');
  assert.ok(Math.abs(haversineDistanceKm(26.9124, 75.7873, 28.6139, 77.209) - 235) < 5, 'Jaipur to Delhi is ~235 km');
});

// ---------------------------------------------------------------------------
// Telemetry normalization
// ---------------------------------------------------------------------------

test('normalizeEnergyReadings strips a corrupted duplicate trailing row and computes deltas', () => {
  const res = normalizeEnergyReadings('J100089', [
    { timestamp: '28/06/2026 00:00', kwh: '12717.05', kvah: '13734.42', voltR: '235' },
    { timestamp: '29/06/2026 00:00', kwh: '12724.70', kvah: '13742.67', voltR: '232' },
    { timestamp: '30/06/2026 00:00', kwh: '12732.34', kvah: '13750.93', voltR: '229' },
    { timestamp: '30/06/2026 00:00', kwh: '', kvah: '13750.93', voltR: '' },
  ]);
  assert.equal(res.rawCount, 4);
  assert.equal(res.count, 3);
  assert.equal(res.granularity, 'daily');
  assert.equal(res.anomalies.length, 1);
  assert.equal(res.anomalies[0].type, 'corrupted_duplicate_reading');
  assert.equal(res.summary.totalConsumptionKwh, 15.29);
  assert.equal(res.summary.minVoltageR, 229);
  assert.equal(res.summary.maxVoltageR, 235);
  assert.equal(res.readings[0].deltaKwh, null);
  assert.equal(res.readings[1].deltaKwh, 7.65);
  assert.equal(res.readings[0].timestamp, parsePortalTimestamp('28/06/2026 00:00'));
});

test('normalizeEnergyReadings classifies each kind of bad row', () => {
  const res = normalizeEnergyReadings('J1', [
    { timestamp: '01/06/2026 00:30', kwh: '1', kvah: '1', voltR: '230' },
    { timestamp: '01/06/2026 00:30', kwh: '2', kvah: '2', voltR: '230' }, // repeated timestamp, valid values
    { timestamp: '01/06/2026 01:00', kwh: '', kvah: '2', voltR: '230' }, // blank value
    { timestamp: '01/06/2026 01:00', kwh: '3', kvah: '3', voltR: '231' },
  ]);
  assert.deepEqual(res.anomalies.map((a) => a.type), ['duplicate_timestamp', 'incomplete_reading']);
  assert.equal(res.count, 2);
  assert.equal(res.granularity, '30m');
});

test('normalizeEnergyReadings handles empty and single-point series', () => {
  const empty = normalizeEnergyReadings('J1', []);
  assert.equal(empty.count, 0);
  assert.equal(empty.granularity, 'unknown');
  assert.equal(empty.summary.totalConsumptionKwh, 0);
  assert.equal(empty.summary.minVoltageR, null);

  const single = normalizeEnergyReadings('J1', [{ timestamp: '01/06/2026 00:00', kwh: '5', kvah: '0', voltR: '230' }]);
  assert.equal(single.granularity, 'single_point');
  assert.equal(single.readings[0].powerFactor, null, 'no power factor when kVAh is zero');
});

// ---------------------------------------------------------------------------
// Dataset reconciliation
// ---------------------------------------------------------------------------

test('reconcileDataset heals blank hierarchy codes and names from canonical peers', () => {
  const meters = structuredClone(RAW_METERS);
  meters[0].hierarchy.circle = { code: '', name: 'Circle 1' }; // blank code
  meters[3].hierarchy.feeder = { code: 'F-001', name: '' }; // blank name; J100000 supplies the canonical name

  const result = reconcileDataset(meters, structuredClone(RAW_TRANSFORMERS));
  const byId = Object.fromEntries(result.meters.map((m) => [m.meterId, m]));

  assert.deepEqual(byId.J100000.hierarchy.circle, { code: 'C-01', name: 'Circle 1' });
  assert.equal(byId.J100000.dataQuality.hasStructuralAnomaly, true);
  assert.deepEqual(byId.J100040.hierarchy.feeder, { code: 'F-001', name: 'Feeder 1' });
  assert.equal(result.anomaliesSummary.missingHierarchyCodes, 1);
  assert.equal(result.anomaliesSummary.missingHierarchyNames, 1);

  const record = result.anomaliesSummary.records.find((r) => r.category === 'missing_hierarchy_code');
  assert.deepEqual(record.raw, { code: '', name: 'Circle 1' });
  assert.deepEqual(record.healed, { code: 'C-01', name: 'Circle 1' });
});

test('reconcileDataset leaves an unresolvable blank alone rather than guessing', () => {
  const meters = structuredClone(RAW_METERS);
  meters[2].hierarchy.circle = { code: '', name: 'Circle 99' }; // no peer carries this name
  const result = reconcileDataset(meters, structuredClone(RAW_TRANSFORMERS));
  const healed = result.meters.find((m) => m.meterId === 'J100004');
  assert.deepEqual(healed.hierarchy.circle, { code: '', name: 'Circle 99' });
  assert.equal(result.anomaliesSummary.missingHierarchyCodes, 0);
});

test('reconcileDataset reconciles the DT-007 name conflict and flags the GN prefix', () => {
  const result = reconcileDataset(structuredClone(RAW_METERS), structuredClone(RAW_TRANSFORMERS));
  const tail = result.meters.find((m) => m.meterId === 'J100400');
  assert.equal(tail.hierarchy.dt.name, 'Sanganer DT 7');
  assert.equal(tail.dtName, 'Sanganer DT 7');

  const dt7 = result.transformers.find((t) => t.code === 'DT-007');
  assert.deepEqual(dt7.aliases, ['Old Malviya Nagar Xfmr']);
  assert.equal(result.anomaliesSummary.dtNameConflicts, 1);
  assert.equal(result.anomaliesSummary.nonStandardSerialPrefixes, 1);
});

test('a serial/make mismatch is flagged on the meter but is not a structural anomaly', () => {
  const result = reconcileDataset(structuredClone(RAW_METERS), structuredClone(RAW_TRANSFORMERS));
  const mismatched = result.meters.find((m) => m.meterId === 'J100000');
  assert.equal(mismatched.dataQuality.serialPrefixMatchesMake, false);
  assert.equal(mismatched.dataQuality.hasStructuralAnomaly, false);
  assert.equal(mismatched.dataQuality.anomalies[0].category, 'serial_make_mismatch');
  assert.equal(result.anomaliesSummary.serialMakeMismatches, 2);
  assert.equal(result.anomaliesSummary.totalStructuralAnomalies, 2, 'mismatches are not counted as structural');
});

test('reconcileDataset derives telemetry granularity, "&" safety and location per meter', () => {
  const result = reconcileDataset(structuredClone(RAW_METERS), structuredClone(RAW_TRANSFORMERS));
  const byId = Object.fromEntries(result.meters.map((m) => [m.meterId, m]));
  assert.equal(byId.J100003.telemetryGranularity, '30m');
  assert.equal(byId.J100040.telemetryGranularity, 'daily');
  assert.equal(byId.J100003.dataQuality.containsUrlUnsafeSerialChar, true);
  assert.equal(result.anomaliesSummary.urlUnsafeSerialsCount, 1);
  assert.deepEqual(byId.J100000.location, { latitude: 26.8549, longitude: 75.8243 });
  assert.equal(reconcileDataset([{ ...RAW_METERS[0], geo: undefined }], RAW_TRANSFORMERS).meters[0].location, null);
});

test('transformers carry meter counts and status/phase breakdowns', () => {
  const result = reconcileDataset(structuredClone(RAW_METERS), structuredClone(RAW_TRANSFORMERS));
  const dt1 = result.transformers.find((t) => t.code === 'DT-001');
  assert.equal(dt1.meterCount, 2);
  assert.deepEqual(dt1.meterIds, ['J100000', 'J100040']);
  assert.equal(dt1.statusBreakdown.Decommissioned, 1);
  assert.equal(dt1.statusBreakdown.Installed, 1);
  assert.deepEqual(dt1.phaseBreakdown, { single: 1, three: 1 });
});

test('the hierarchy is exposed as a nested tree and as one path per transformer', () => {
  const result = reconcileDataset(structuredClone(RAW_METERS), structuredClone(RAW_TRANSFORMERS));
  const { zones, dtPaths, levels } = result.hierarchy;
  assert.deepEqual(levels, ['zone', 'circle', 'division', 'subdivision', 'substation', 'feeder', 'dt']);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].meterCount, 5);
  assert.deepEqual(zones[0].children.map((c) => c.code), ['C-01', 'C-04', 'C-05']);
  assert.equal(dtPaths.length, 4);
  assert.equal(dtPaths.find((p) => p.dtCode === 'DT-004').path.circle.code, 'C-04');
});

test('intermediate codes that appear under several parents are reported as multi-parent nodes', () => {
  const meters = structuredClone(RAW_METERS);
  meters[1].hierarchy.division = { code: 'D-01', name: 'Division 1' }; // D-01 now sits under C-01 and C-04
  const result = reconcileDataset(meters, structuredClone(RAW_TRANSFORMERS));
  const node = result.hierarchy.multiParentNodes.find((n) => n.code === 'D-01');
  assert.ok(node, 'D-01 is reported');
  assert.deepEqual(node.distinctParents, ['C-01 (Circle 1)', 'C-04 (Circle 4)']);
  assert.equal(result.hierarchy.multiParentNodesCount, result.hierarchy.multiParentNodes.length);
});

test('reconcileDataset tolerates an empty dataset', () => {
  const result = reconcileDataset([], []);
  assert.deepEqual(result.meters, []);
  assert.deepEqual(result.transformers, []);
  assert.equal(result.anomaliesSummary.totalStructuralAnomalies, 0);
});
