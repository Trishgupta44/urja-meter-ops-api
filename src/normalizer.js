export const HIERARCHY_LEVELS = [
  'zone',
  'circle',
  'division',
  'subdivision',
  'substation',
  'feeder',
  'dt',
];

export const SERIAL_PREFIX_TO_MAKE = {
  SE: 'Secure',
  GE: 'Genus',
  GN: 'Genus', // Used only on tail meters J100400..J100402
  AL: 'Allied',
  'L&': 'L&T',
  HP: 'HPL',
};

/**
 * Meters whose `/energy` series carries a trailing corrupted duplicate row, found by
 * scanning the whole fleet. `normalizeEnergyReadings` strips such rows from any meter;
 * this list is reference data for the anomaly report only.
 */
export const KNOWN_CORRUPTED_TELEMETRY_METERS = ['J100089', 'J100134', 'J100195', 'J100211', 'J100330'];

/**
 * Great-circle distance between two coordinates in kilometers using the Haversine formula.
 */
export function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth mean radius in km
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Normalizes the two distinct SSR detail schemas found on `/meters/:id`:
 * - Legacy (`build === "legacy"`): `{ data: [{ parameterName, parameterValue }, ...] }`
 * - V2 (`build === "v2"`): `{ classData: "{\"installed_meter\":{...}}" }`
 */
export function normalizeSsrDetailPayload(detail) {
  if (!detail || typeof detail !== 'object') return {};
  if ('classData' in detail && typeof detail.classData === 'string') {
    try {
      const parsed = JSON.parse(detail.classData)?.installed_meter ?? {};
      return {
        schemaFormat: 'v2_classData',
        fields: parsed,
      };
    } catch {
      return { schemaFormat: 'v2_classData_invalid', fields: {} };
    }
  }
  if (Array.isArray(detail.data)) {
    const fields = {};
    for (const item of detail.data) {
      if (item?.parameterName) {
        fields[item.parameterName] = item.parameterValue;
      }
    }
    return {
      schemaFormat: 'legacy_parameterList',
      fields,
    };
  }
  return { schemaFormat: 'unknown', fields: {} };
}

/**
 * Parses `DD/MM/YYYY HH:mm` timestamps returned by `/portal/meters/:id/energy`
 * into ISO-8601 strings (`YYYY-MM-DDTHH:mm:00+05:30` and UTC Date).
 */
export function parsePortalTimestamp(rawTs) {
  if (typeof rawTs !== 'string') return null;
  const match = rawTs.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, dd, mm, yyyy, hh, min] = match;
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:00+05:30`;
}

/**
 * Cleanses and enriches energy readings from `/portal/meters/:id/energy`:
 * - Strips corrupted duplicate rows where `kwh` or `voltR` is empty (`""`), such as
 *   the trailing `30/06/2026 00:00` row on J100089, J100134, J100195, J100211, J100330.
 * - Converts string numbers to floats.
 * - Computes interval `deltaKwh`, `deltaKvah`, `powerFactor`, and summary statistics.
 */
export function normalizeEnergyReadings(meterId, rawReadings = []) {
  const cleanReadings = [];
  const anomalies = [];
  const seenTimestamps = new Set();

  for (let i = 0; i < rawReadings.length; i++) {
    const raw = rawReadings[i];
    const ts = raw?.timestamp?.trim() || '';
    const isDuplicateTs = seenTimestamps.has(ts);
    const hasMissingValue =
      raw?.kwh === '' || raw?.kvah === '' || raw?.voltR === '' ||
      raw?.kwh == null || raw?.kvah == null || raw?.voltR == null;

    if (isDuplicateTs || hasMissingValue) {
      anomalies.push({
        meterId,
        index: i,
        type: isDuplicateTs && hasMissingValue
          ? 'corrupted_duplicate_reading'
          : isDuplicateTs
            ? 'duplicate_timestamp'
            : 'incomplete_reading',
        raw,
        resolution: 'Filtered out corrupted/duplicate reading row',
      });
      continue;
    }

    seenTimestamps.add(ts);
    const kwh = Number(raw.kwh);
    const kvah = Number(raw.kvah);
    const voltR = Number(raw.voltR);
    const isoTimestamp = parsePortalTimestamp(ts);

    const prev = cleanReadings[cleanReadings.length - 1];
    const deltaKwh = prev ? Number((kwh - prev.kwh).toFixed(4)) : null;
    const deltaKvah = prev ? Number((kvah - prev.kvah).toFixed(4)) : null;
    const powerFactor = kvah > 0 ? Number((kwh / kvah).toFixed(4)) : null;

    cleanReadings.push({
      timestamp: isoTimestamp || ts,
      rawTimestamp: ts,
      kwh,
      kvah,
      voltR,
      deltaKwh,
      deltaKvah,
      powerFactor,
    });
  }

  // Detect granularity: 30m (J100000..J100039) vs daily (J100040..J100402)
  let granularity = 'unknown';
  if (cleanReadings.length >= 2) {
    const t0 = Date.parse(cleanReadings[0].timestamp);
    const t1 = Date.parse(cleanReadings[1].timestamp);
    const diffMinutes = Math.round((t1 - t0) / 60000);
    if (diffMinutes === 30) granularity = '30m';
    else if (diffMinutes === 1440) granularity = 'daily';
    else granularity = `${diffMinutes}m`;
  } else if (cleanReadings.length === 1) {
    granularity = 'single_point';
  }

  const first = cleanReadings[0] || null;
  const last = cleanReadings[cleanReadings.length - 1] || null;
  const totalConsumptionKwh = first && last ? Number((last.kwh - first.kwh).toFixed(2)) : 0;
  const totalConsumptionKvah = first && last ? Number((last.kvah - first.kvah).toFixed(2)) : 0;
  const voltages = cleanReadings.map((r) => r.voltR);
  const minVoltageR = voltages.length ? Math.min(...voltages) : null;
  const maxVoltageR = voltages.length ? Math.max(...voltages) : null;
  const avgVoltageR = voltages.length
    ? Number((voltages.reduce((a, b) => a + b, 0) / voltages.length).toFixed(1))
    : null;

  return {
    meterId,
    granularity,
    count: cleanReadings.length,
    rawCount: rawReadings.length,
    summary: {
      startTimestamp: first?.timestamp || null,
      endTimestamp: last?.timestamp || null,
      startCumulativeKwh: first?.kwh ?? null,
      endCumulativeKwh: last?.kwh ?? null,
      totalConsumptionKwh,
      totalConsumptionKvah,
      minVoltageR,
      maxVoltageR,
      avgVoltageR,
    },
    anomalies,
    readings: cleanReadings,
  };
}

/** Indexes the authoritative `/portal/dts` registry by transformer code. */
function indexTransformers(rawTransformers) {
  const dtByCode = new Map();
  for (const dt of rawTransformers) {
    dtByCode.set(dt.code, {
      code: dt.code,
      name: dt.name,
      feederCode: dt.feederCode,
      capacityKva: Number(dt.capacityKva),
    });
  }
  return dtByCode;
}

/**
 * Builds per-level `code -> name` and `name -> code` dictionaries from every
 * complete hierarchy node in the dataset. DT names come from the registry first.
 */
function buildHierarchyDictionaries(rawMeters, dtByCode) {
  const codeToName = {};
  const nameToCode = {};
  for (const lvl of HIERARCHY_LEVELS) {
    codeToName[lvl] = new Map();
    nameToCode[lvl] = new Map();
  }

  for (const dt of dtByCode.values()) {
    codeToName.dt.set(dt.code, dt.name);
    nameToCode.dt.set(dt.name, dt.code);
  }

  for (const m of rawMeters) {
    const h = m.hierarchy || {};
    for (const lvl of HIERARCHY_LEVELS) {
      const node = h[lvl];
      if (node?.code && node?.name) {
        if (!codeToName[lvl].has(node.code)) codeToName[lvl].set(node.code, node.name);
        if (!nameToCode[lvl].has(node.name)) nameToCode[lvl].set(node.name, node.code);
      }
    }
  }
  return { codeToName, nameToCode };
}

/**
 * Heals blank hierarchy `code` / `name` values from the dictionaries and reconciles
 * the DT name against the registry. Every change is reported as an issue.
 */
function healHierarchy(raw, { codeToName, nameToCode }, dtByCode) {
  const rawH = raw.hierarchy || {};
  const hierarchy = {};
  const issues = [];

  for (const lvl of HIERARCHY_LEVELS) {
    const rawNode = rawH[lvl] || { code: '', name: '' };
    let code = (rawNode.code || '').trim();
    let name = (rawNode.name || '').trim();

    if (!code && name) {
      const inferredCode = nameToCode[lvl].get(name) || (lvl === 'dt' ? raw.dtCode : '');
      if (inferredCode) {
        code = inferredCode;
        issues.push({
          meterId: raw.meterId,
          category: 'missing_hierarchy_code',
          level: lvl,
          raw: { code: rawNode.code, name: rawNode.name },
          healed: { code, name },
          description: `Missing ${lvl} code on ${raw.meterId}; inferred "${code}" from canonical name "${name}".`,
        });
      }
    } else if (code && !name) {
      const inferredName = codeToName[lvl].get(code) || '';
      if (inferredName) {
        name = inferredName;
        issues.push({
          meterId: raw.meterId,
          category: 'missing_hierarchy_name',
          level: lvl,
          raw: { code: rawNode.code, name: rawNode.name },
          healed: { code, name },
          description: `Missing ${lvl} name on ${raw.meterId}; inferred "${name}" from canonical code "${code}".`,
        });
      }
    }

    // Reconcile the DT name against `/portal/dts` (catches DT-007 "Old Malviya Nagar Xfmr").
    if (lvl === 'dt' && code && dtByCode.has(code)) {
      const canonicalDtName = dtByCode.get(code).name;
      if (name && name !== canonicalDtName) {
        issues.push({
          meterId: raw.meterId,
          category: 'dt_name_conflict',
          level: 'dt',
          raw: { code, name },
          healed: { code, name: canonicalDtName },
          description: `Conflicting DT name "${name}" on ${raw.meterId} for ${code}; reconciled to "${canonicalDtName}" from /portal/dts.`,
        });
        name = canonicalDtName;
      }
    }

    hierarchy[lvl] = { code, name };
  }
  return { hierarchy, issues };
}

/**
 * Compares the serial prefix with the manufacturer. A mismatch is flagged on the
 * meter only; a `GN` prefix is also reported fleet-wide as a structural anomaly.
 */
function checkSerial(raw) {
  const serialPrefix = (raw.serialNo || '').slice(0, 2);
  const expectedMake = SERIAL_PREFIX_TO_MAKE[serialPrefix] || null;
  const matchesMake = expectedMake === raw.make;

  const meterOnly = [];
  if (!matchesMake) {
    meterOnly.push({
      meterId: raw.meterId,
      category: 'serial_make_mismatch',
      serialNo: raw.serialNo,
      serialPrefix,
      expectedMake,
      actualMake: raw.make,
      description: `Serial prefix "${serialPrefix}" implies make "${expectedMake}", but make is "${raw.make}".`,
    });
  }

  const structural = [];
  if (serialPrefix === 'GN') {
    structural.push({
      meterId: raw.meterId,
      category: 'non_standard_serial_prefix',
      serialNo: raw.serialNo,
      description: `Uses "GN" prefix for Genus instead of "GE" (found on tail meters J100400–J100402).`,
    });
  }
  return { matchesMake, meterOnly, structural };
}

/** Telemetry resolution is fixed by the portal: J100000–J100039 are half-hourly, the rest daily. */
function telemetryGranularityFor(meterId) {
  const meterNum = Number((meterId || '').replace(/^J/, ''));
  return meterNum >= 100000 && meterNum <= 100039 ? '30m' : 'daily';
}

/**
 * Normalizes one raw export record. Returns the clean meter plus the anomalies
 * that should also be counted fleet-wide.
 */
function normalizeMeter(raw, dictionaries, dtByCode) {
  const { hierarchy, issues } = healHierarchy(raw, dictionaries, dtByCode);
  const serial = checkSerial(raw);
  const meterAnomalies = [...issues, ...serial.meterOnly, ...serial.structural];
  const dtInfo = dtByCode.get(raw.dtCode) || null;

  const meter = {
    meterId: raw.meterId,
    serialNo: raw.serialNo,
    make: raw.make,
    phaseType: raw.phaseType,
    installStatus: raw.installStatus,
    installType: raw.installType || null,
    build: raw.build || 'legacy',
    telemetryGranularity: telemetryGranularityFor(raw.meterId),
    dtCode: raw.dtCode,
    dtName: dtInfo?.name || hierarchy.dt?.name || null,
    dtCapacityKva: dtInfo?.capacityKva ?? null,
    feederCode: dtInfo?.feederCode || hierarchy.feeder?.code || null,
    location: raw.geo
      ? { latitude: Number(raw.geo.lat), longitude: Number(raw.geo.lng) }
      : null,
    hierarchy,
    dataQuality: {
      hasStructuralAnomaly: meterAnomalies.some((a) => a.category !== 'serial_make_mismatch'),
      serialPrefixMatchesMake: serial.matchesMake,
      containsUrlUnsafeSerialChar: (raw.serialNo || '').includes('&'),
      anomalies: meterAnomalies,
    },
  };
  return { meter, fleetAnomalies: [...issues, ...serial.structural] };
}

/**
 * Finds hierarchy nodes whose code appears under more than one parent code. The portal
 * generated upstream codes with modulo arithmetic, so intermediate codes repeat.
 */
function findMultiParentNodes(meters) {
  const parentSetsByNode = new Map();
  for (const m of meters) {
    for (let i = 1; i < HIERARCHY_LEVELS.length; i++) {
      const parentLvl = HIERARCHY_LEVELS[i - 1];
      const childLvl = HIERARCHY_LEVELS[i];
      const pNode = m.hierarchy[parentLvl];
      const cNode = m.hierarchy[childLvl];
      if (!pNode?.code || !cNode?.code) continue;

      const key = `${childLvl}:${cNode.code}`;
      if (!parentSetsByNode.has(key)) {
        parentSetsByNode.set(key, {
          level: childLvl,
          code: cNode.code,
          name: cNode.name,
          parentLevel: parentLvl,
          parents: new Set(),
        });
      }
      parentSetsByNode.get(key).parents.add(`${pNode.code} (${pNode.name})`);
    }
  }

  return [...parentSetsByNode.values()]
    .filter((entry) => entry.parents.size > 1)
    .map((entry) => ({
      level: entry.level,
      code: entry.code,
      name: entry.name,
      parentLevel: entry.parentLevel,
      distinctParents: [...entry.parents].sort(),
    }));
}

/** Builds the enriched transformer list, preserving conflicting meter-level names as aliases. */
function buildTransformers(dtByCode, normalizedMeters, rawMeters) {
  const transformers = [];
  for (const [dtCode, dt] of dtByCode.entries()) {
    const dtMeters = normalizedMeters.filter((m) => m.dtCode === dtCode);

    const aliases = new Set();
    for (const rm of rawMeters) {
      if (rm.dtCode === dtCode && rm.hierarchy?.dt?.name && rm.hierarchy.dt.name !== dt.name) {
        aliases.add(rm.hierarchy.dt.name);
      }
    }

    const statusBreakdown = { Installed: 0, Decommissioned: 0, Faulty: 0 };
    const phaseBreakdown = { single: 0, three: 0 };
    for (const m of dtMeters) {
      statusBreakdown[m.installStatus] = (statusBreakdown[m.installStatus] || 0) + 1;
      phaseBreakdown[m.phaseType] = (phaseBreakdown[m.phaseType] || 0) + 1;
    }

    transformers.push({
      code: dt.code,
      name: dt.name,
      aliases: [...aliases],
      feederCode: dt.feederCode,
      capacityKva: dt.capacityKva,
      meterCount: dtMeters.length,
      statusBreakdown,
      phaseBreakdown,
      hierarchy: dtMeters[0]?.hierarchy || null,
      meterIds: dtMeters.map((m) => m.meterId),
    });
  }
  return transformers.sort((a, b) => a.code.localeCompare(b.code));
}

const TOPOLOGY_NOTE =
  'Each of the 40 Distribution Transformers (DT-001..DT-040) has a unique, deterministic 7-level upstream path. However, because the portal generated upstream codes using modulo arithmetic (3 Zones, 6 Circles, 10 Divisions, 14 Subdivisions, 18 Substations, 28 Feeders), intermediate codes (Division through Feeder) appear under multiple parent codes across different DTs (forming a DAG by code, or a strict tree by path). Both views are provided below.';

/**
 * Reconciles all meters and Distribution Transformers:
 * - Heals missing hierarchy `code` / `name` strings using canonical peer mappings.
 * - Reconciles the DT-007 name conflict ("Old Malviya Nagar Xfmr" -> "Sanganer DT 7").
 * - Catalogs every anomaly (missing hierarchy fields, DT name conflict, serial/make mismatches,
 *   non-standard `GN` prefix, and modulo-DAG multi-parent hierarchy nodes).
 */
export function reconcileDataset(rawMeters = [], rawTransformers = []) {
  const dtByCode = indexTransformers(rawTransformers);
  const dictionaries = buildHierarchyDictionaries(rawMeters, dtByCode);

  const meters = [];
  const anomalies = [];
  for (const raw of rawMeters) {
    const { meter, fleetAnomalies } = normalizeMeter(raw, dictionaries, dtByCode);
    meters.push(meter);
    anomalies.push(...fleetAnomalies);
  }

  const multiParentNodes = findMultiParentNodes(meters);
  const transformers = buildTransformers(dtByCode, meters, rawMeters);
  const countCategory = (category) => anomalies.filter((a) => a.category === category).length;

  return {
    meters,
    transformers,
    hierarchy: {
      levels: HIERARCHY_LEVELS,
      topologyNote: TOPOLOGY_NOTE,
      multiParentNodesCount: multiParentNodes.length,
      multiParentNodes,
      zones: buildNestedHierarchyTree(meters, dtByCode),
      dtPaths: transformers.map((t) => ({
        dtCode: t.code,
        dtName: t.name,
        capacityKva: t.capacityKva,
        meterCount: t.meterCount,
        path: t.hierarchy,
      })),
    },
    anomaliesSummary: {
      totalStructuralAnomalies: anomalies.length,
      missingHierarchyCodes: countCategory('missing_hierarchy_code'),
      missingHierarchyNames: countCategory('missing_hierarchy_name'),
      dtNameConflicts: countCategory('dt_name_conflict'),
      nonStandardSerialPrefixes: countCategory('non_standard_serial_prefix'),
      serialMakeMismatches: meters.filter((m) => !m.dataQuality.serialPrefixMatchesMake).length,
      urlUnsafeSerialsCount: meters.filter((m) => m.dataQuality.containsUrlUnsafeSerialChar).length,
      knownCorruptedTelemetryMeters: KNOWN_CORRUPTED_TELEMETRY_METERS,
      records: anomalies,
    },
  };
}

function buildNestedHierarchyTree(meters, dtByCode) {
  const rootMap = new Map();

  for (const m of meters) {
    let currentMap = rootMap;
    for (let i = 0; i < HIERARCHY_LEVELS.length; i++) {
      const lvl = HIERARCHY_LEVELS[i];
      const nodeInfo = m.hierarchy[lvl] || { code: 'UNKNOWN', name: 'Unknown' };
      const key = `${lvl}:${nodeInfo.code}`;
      if (!currentMap.has(key)) {
        const entry = {
          level: lvl,
          code: nodeInfo.code,
          name: nodeInfo.name,
          meterCount: 0,
        };
        if (lvl === 'dt' && dtByCode.has(nodeInfo.code)) {
          entry.capacityKva = dtByCode.get(nodeInfo.code).capacityKva;
          entry.meterIds = [];
        } else {
          entry.childrenMap = new Map();
        }
        currentMap.set(key, entry);
      }
      const node = currentMap.get(key);
      node.meterCount += 1;
      if (lvl === 'dt') {
        node.meterIds.push(m.meterId);
      } else {
        currentMap = node.childrenMap;
      }
    }
  }

  function mapToArray(map) {
    return [...map.values()]
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((node) => {
        if (node.childrenMap) {
          const children = mapToArray(node.childrenMap);
          const { childrenMap, ...rest } = node;
          return { ...rest, children };
        }
        return node;
      });
  }

  return mapToArray(rootMap);
}
