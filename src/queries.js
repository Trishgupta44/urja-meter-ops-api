import { haversineDistanceKm, HIERARCHY_LEVELS } from './normalizer.js';
import { badRequest } from './errors.js';

/**
 * Pure query layer over the reconciled in-memory dataset. Nothing here touches
 * the network or the cache, so every function is deterministic and unit-testable.
 */

export const METER_QUERY_PARAMS = [
  'q', 'make', 'phase', 'status', 'installType', 'build', 'granularity',
  ...HIERARCHY_LEVELS,
  'hasAnomaly', 'serialMismatch',
  'nearLat', 'nearLng', 'radiusKm',
  'sortBy', 'sortOrder', 'page', 'limit', 'refresh',
];

export const TRANSFORMER_QUERY_PARAMS = [
  'q', 'feeder', 'zone', 'minCapacityKva', 'page', 'limit', 'refresh',
];

export const METER_SORT_KEYS = [
  'meterId', 'serialNo', 'make', 'phaseType', 'installStatus', 'installType',
  'build', 'telemetryGranularity', 'dtCode', 'dtName', 'distanceKm',
];

export const MAX_METER_PAGE_SIZE = 500;
export const MAX_TRANSFORMER_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_RADIUS_KM = 5;

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

/** Rejects query-string keys the endpoint does not understand, so typos fail loudly. */
export function assertKnownParams(params, allowed) {
  const unknown = Object.keys(params).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw badRequest(`Unknown query parameter(s): ${unknown.join(', ')}.`, {
      unknown,
      supported: allowed,
    });
  }
}

/** Parses `true` / `false` (case-insensitive). Blank means "not provided". */
export function parseBoolean(value, name) {
  if (isBlank(value)) return undefined;
  const s = String(value).trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  throw badRequest(`Query parameter "${name}" must be "true" or "false".`);
}

/**
 * For endpoints whose only inputs are boolean flags (plus optional pass-through
 * params): rejects unknown keys and returns `{ flag: boolean }` for each flag.
 */
export function parseFlags(params, flags, passThrough = []) {
  assertKnownParams(params, [...flags, ...passThrough]);
  return Object.fromEntries(flags.map((f) => [f, parseBoolean(params[f], f) === true]));
}

function parseNumber(value, name, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || n < min || n > max) {
    const range = Number.isFinite(min) || Number.isFinite(max) ? ` between ${min} and ${max}` : '';
    throw badRequest(`Query parameter "${name}" must be a number${range}.`);
  }
  return n;
}

function parsePositiveInt(value, name, fallback, max = Infinity) {
  if (isBlank(value)) return fallback;
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1) {
    throw badRequest(`Query parameter "${name}" must be a positive integer.`);
  }
  return Math.min(n, max);
}

/** Resolves `page` / `limit` into validated paging numbers. */
export function parsePagination(params, maxLimit) {
  return {
    page: parsePositiveInt(params.page, 'page', 1),
    limit: parsePositiveInt(params.limit, 'limit', DEFAULT_PAGE_SIZE, maxLimit),
  };
}

export function paginate(items, { page, limit }) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const current = Math.min(page, totalPages);
  const offset = (current - 1) * limit;
  return {
    data: items.slice(offset, offset + limit),
    pagination: {
      total,
      page: current,
      limit,
      totalPages,
      hasNextPage: current < totalPages,
      hasPrevPage: current > 1,
    },
  };
}

/**
 * Parses a comma-separated, case-insensitive enum filter against the values that
 * actually occur in the data, so a mistyped value is a 400 rather than a silent empty page.
 */
function parseEnumFilter(value, name, available) {
  if (isBlank(value)) return null;
  const requested = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  const byLower = new Map(available.map((v) => [String(v).toLowerCase(), v]));
  const unknown = requested.filter((r) => !byLower.has(r.toLowerCase()));
  if (unknown.length > 0) {
    throw badRequest(`Invalid value(s) for "${name}": ${unknown.join(', ')}.`, {
      parameter: name,
      allowed: [...available].sort(),
    });
  }
  return new Set(requested.map((r) => r.toLowerCase()));
}

const distinct = (meters, pick) => [...new Set(meters.map(pick).filter(Boolean))];

/**
 * Validates raw query-string params against the current dataset and returns a
 * normalized criteria object that `filterMeters` can apply.
 */
export function parseMeterQuery(params, meters) {
  assertKnownParams(params, METER_QUERY_PARAMS);

  const criteria = {
    q: isBlank(params.q) ? null : String(params.q).trim().toLowerCase(),
    enums: {
      make: parseEnumFilter(params.make, 'make', distinct(meters, (m) => m.make)),
      phaseType: parseEnumFilter(params.phase, 'phase', distinct(meters, (m) => m.phaseType)),
      installStatus: parseEnumFilter(params.status, 'status', distinct(meters, (m) => m.installStatus)),
      installType: parseEnumFilter(params.installType, 'installType', distinct(meters, (m) => m.installType)),
      build: parseEnumFilter(params.build, 'build', distinct(meters, (m) => m.build)),
      telemetryGranularity: parseEnumFilter(params.granularity, 'granularity', distinct(meters, (m) => m.telemetryGranularity)),
    },
    hierarchy: HIERARCHY_LEVELS
      .filter((lvl) => !isBlank(params[lvl]))
      .map((lvl) => [lvl, String(params[lvl]).trim().toLowerCase()]),
    hasAnomaly: parseBoolean(params.hasAnomaly, 'hasAnomaly'),
    serialMismatch: parseBoolean(params.serialMismatch, 'serialMismatch'),
    geo: null,
    sort: null,
    paging: parsePagination(params, MAX_METER_PAGE_SIZE),
  };

  const hasLat = !isBlank(params.nearLat);
  const hasLng = !isBlank(params.nearLng);
  if (hasLat !== hasLng) {
    throw badRequest('"nearLat" and "nearLng" must be provided together.');
  }
  if (!hasLat && !isBlank(params.radiusKm)) {
    throw badRequest('"radiusKm" requires "nearLat" and "nearLng".');
  }
  if (hasLat) {
    criteria.geo = {
      lat: parseNumber(params.nearLat, 'nearLat', { min: -90, max: 90 }),
      lng: parseNumber(params.nearLng, 'nearLng', { min: -180, max: 180 }),
      radiusKm: isBlank(params.radiusKm)
        ? DEFAULT_RADIUS_KM
        : parseNumber(params.radiusKm, 'radiusKm', { min: 0 }),
    };
  }

  if (!isBlank(params.sortBy)) {
    const key = String(params.sortBy).trim();
    if (!METER_SORT_KEYS.includes(key)) {
      throw badRequest(`Invalid "sortBy" value: ${key}.`, { allowed: METER_SORT_KEYS });
    }
    if (key === 'distanceKm' && !criteria.geo) {
      throw badRequest('"sortBy=distanceKm" requires "nearLat" and "nearLng".');
    }
    const order = isBlank(params.sortOrder) ? 'asc' : String(params.sortOrder).trim().toLowerCase();
    if (order !== 'asc' && order !== 'desc') {
      throw badRequest('"sortOrder" must be "asc" or "desc".');
    }
    criteria.sort = { key, direction: order === 'desc' ? -1 : 1 };
  } else if (!isBlank(params.sortOrder)) {
    throw badRequest('"sortOrder" requires "sortBy".');
  }

  return criteria;
}

function matchesHierarchy(meter, level, target) {
  const node = meter.hierarchy?.[level];
  if (!node) return false;
  return node.code.toLowerCase() === target || node.name.toLowerCase().includes(target);
}

function matchesText(meter, q) {
  return (
    meter.meterId.toLowerCase().includes(q) ||
    meter.serialNo.toLowerCase().includes(q) ||
    meter.dtCode.toLowerCase().includes(q) ||
    (meter.dtName && meter.dtName.toLowerCase().includes(q)) ||
    meter.make.toLowerCase().includes(q)
  );
}

/**
 * Applies validated criteria to the meter list. Geo queries attach `distanceKm`
 * and are ordered nearest-first unless an explicit sort is requested.
 */
export function filterMeters(meters, criteria) {
  let results = meters.filter((m) => {
    if (criteria.q && !matchesText(m, criteria.q)) return false;
    for (const [field, allowed] of Object.entries(criteria.enums)) {
      if (allowed && !allowed.has(String(m[field] ?? '').toLowerCase())) return false;
    }
    for (const [level, target] of criteria.hierarchy) {
      if (!matchesHierarchy(m, level, target)) return false;
    }
    if (criteria.hasAnomaly !== undefined && m.dataQuality.hasStructuralAnomaly !== criteria.hasAnomaly) {
      return false;
    }
    if (criteria.serialMismatch !== undefined &&
        !m.dataQuality.serialPrefixMatchesMake !== criteria.serialMismatch) {
      return false;
    }
    return true;
  });

  if (criteria.geo) {
    const { lat, lng, radiusKm } = criteria.geo;
    results = results
      .filter((m) => m.location && Number.isFinite(m.location.latitude))
      .map((m) => ({
        ...m,
        distanceKm: Number(haversineDistanceKm(lat, lng, m.location.latitude, m.location.longitude).toFixed(3)),
      }))
      .filter((m) => m.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }

  if (criteria.sort) {
    const { key, direction } = criteria.sort;
    results = [...results].sort((a, b) => {
      const va = a[key] ?? '';
      const vb = b[key] ?? '';
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * direction;
      return String(va).localeCompare(String(vb)) * direction;
    });
  }

  return results;
}

/** Counts per attribute over a result set, so UIs can render filter chips. */
export function computeMeterFacets(meters) {
  const facets = { byStatus: {}, byMake: {}, byPhase: {}, byInstallType: {}, byBuild: {}, byZone: {} };
  const bump = (bucket, key) => { bucket[key] = (bucket[key] || 0) + 1; };
  for (const m of meters) {
    bump(facets.byStatus, m.installStatus);
    bump(facets.byMake, m.make);
    bump(facets.byPhase, m.phaseType);
    bump(facets.byInstallType, m.installType);
    bump(facets.byBuild, m.build);
    bump(facets.byZone, m.hierarchy?.zone?.code || 'UNKNOWN');
  }
  return facets;
}

export function parseTransformerQuery(params) {
  assertKnownParams(params, TRANSFORMER_QUERY_PARAMS);
  return {
    q: isBlank(params.q) ? null : String(params.q).trim().toLowerCase(),
    feeder: isBlank(params.feeder) ? null : String(params.feeder).trim().toLowerCase(),
    zone: isBlank(params.zone) ? null : String(params.zone).trim().toLowerCase(),
    minCapacityKva: isBlank(params.minCapacityKva)
      ? null
      : parseNumber(params.minCapacityKva, 'minCapacityKva', { min: 0 }),
    paging: parsePagination(params, MAX_TRANSFORMER_PAGE_SIZE),
  };
}

export function filterTransformers(transformers, criteria) {
  return transformers.filter((t) => {
    if (criteria.q &&
        !(t.code.toLowerCase().includes(criteria.q) ||
          t.name.toLowerCase().includes(criteria.q) ||
          t.feederCode.toLowerCase().includes(criteria.q))) {
      return false;
    }
    if (criteria.feeder && t.feederCode.toLowerCase() !== criteria.feeder) return false;
    if (criteria.zone) {
      const zone = t.hierarchy?.zone;
      if (!(zone?.code?.toLowerCase() === criteria.zone || zone?.name?.toLowerCase().includes(criteria.zone))) {
        return false;
      }
    }
    if (criteria.minCapacityKva !== null && t.capacityKva < criteria.minCapacityKva) return false;
    return true;
  });
}
