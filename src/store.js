import { config } from './config.js';
import { normalizeEnergyReadings, normalizeSsrDetailPayload, reconcileDataset } from './normalizer.js';
import { badRequest, notFound } from './errors.js';
import {
  computeMeterFacets,
  filterMeters,
  filterTransformers,
  paginate,
  parseBoolean,
  parseMeterQuery,
  parseTransformerQuery,
} from './queries.js';

const DATE_PARAM = /^\d{4}-\d{2}-\d{2}$/;

/** Validates an optional `YYYY-MM-DD` parameter, rejecting impossible dates like 2026-13-45. */
function parseDateParam(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const iso = DATE_PARAM.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!iso || Number.isNaN(iso.getTime()) || iso.toISOString().slice(0, 10) !== value) {
    throw badRequest(`Invalid "${name}" parameter. Expected a real calendar date as YYYY-MM-DD (e.g. 2026-06-01).`);
  }
  return value;
}

/**
 * In-memory data store in front of the portal. It owns three concerns only:
 *  1. the reconciled bulk snapshot (meters, transformers, hierarchy) and its freshness,
 *  2. a bounded cache of per-meter telemetry,
 *  3. shaping responses (query logic lives in `queries.js`).
 */
export class UrjaDataStore {
  constructor(portalClient, options = {}) {
    this.client = portalClient;
    this.indexTtlMs = options.indexTtlMs ?? config.indexTtlMs;
    this.energyTtlMs = options.energyTtlMs ?? config.energyTtlMs;
    this.refreshCooldownMs = options.refreshCooldownMs ?? config.staleRetryCooldownMs;
    this.minForceRefreshIntervalMs = options.minForceRefreshIntervalMs ?? config.minForceRefreshIntervalMs;
    this.energyCacheMaxEntries = options.energyCacheMaxEntries ?? config.energyCacheMaxEntries;
    this.now = options.now ?? Date.now; // injectable clock for deterministic tests

    this.snapshot = null;
    this.lastSyncedAt = 0;
    this.syncPromise = null;
    this.refreshBlockedUntil = 0;
    this.lastRefreshError = null;

    this.energyCache = new Map();
    this.energyInflight = new Map();
  }

  /** Metadata about the current cache state, surfaced by `/api/v1/health`. */
  getCacheMeta() {
    const base = {
      populated: Boolean(this.snapshot),
      ttlSeconds: Math.round(this.indexTtlMs / 1000),
      lastRefreshError: this.lastRefreshError,
      nextRefreshAttemptAt:
        this.refreshBlockedUntil > this.now() ? new Date(this.refreshBlockedUntil).toISOString() : null,
    };
    if (!this.snapshot) {
      return { ...base, lastSyncedAt: null, ageSeconds: null, isStale: true };
    }
    const ageMs = this.now() - this.lastSyncedAt;
    return {
      ...base,
      lastSyncedAt: new Date(this.lastSyncedAt).toISOString(),
      ageSeconds: Math.round(ageMs / 1000),
      isStale: ageMs > this.indexTtlMs,
      meterCount: this.snapshot.meters.length,
      transformerCount: this.snapshot.transformers.length,
      energyCacheEntries: this.energyCache.size,
    };
  }

  /**
   * Returns the snapshot, refreshing it from the portal when stale.
   *  - Concurrent callers share one in-flight sync (single-flight).
   *  - If a refresh fails but a snapshot exists, that snapshot is served with
   *    `staleFallback: true` and further refresh attempts pause for `refreshCooldownMs`,
   *    so an outage does not turn every request into a portal call.
   *  - `forceRefresh` surfaces failures instead of hiding them, and is throttled to one
   *    real sync per `minForceRefreshIntervalMs` to protect the portal's rate limit.
   *
   * @returns {Promise<{snapshot: object, cacheHit: boolean, staleFallback: boolean}>}
   */
  async ensureIndex({ forceRefresh = false } = {}) {
    if (this.snapshot) {
      const now = this.now();
      const ageMs = now - this.lastSyncedAt;
      const fresh = ageMs <= this.indexTtlMs;
      const throttled = forceRefresh && ageMs < this.minForceRefreshIntervalMs;

      if ((fresh && !forceRefresh) || throttled) {
        return { snapshot: this.snapshot, cacheHit: true, staleFallback: false };
      }
      if (!forceRefresh && !this.syncPromise && now < this.refreshBlockedUntil) {
        return { snapshot: this.snapshot, cacheHit: true, staleFallback: true };
      }
    }

    if (!this.syncPromise) {
      this.syncPromise = this._sync(forceRefresh).finally(() => {
        this.syncPromise = null;
      });
    }
    return this.syncPromise;
  }

  async _sync(forceRefresh) {
    try {
      const [rawMeters, rawTransformers] = await Promise.all([
        this.client.fetchAllMetersBulk(),
        this.client.fetchAllTransformers(),
      ]);
      const reconciled = reconcileDataset(rawMeters, rawTransformers);
      this.snapshot = {
        ...reconciled,
        metersById: new Map(reconciled.meters.map((m) => [m.meterId.toUpperCase(), m])),
        transformersByCode: new Map(reconciled.transformers.map((t) => [t.code.toUpperCase(), t])),
      };
      this.lastSyncedAt = this.now();
      this.refreshBlockedUntil = 0;
      this.lastRefreshError = null;
      return { snapshot: this.snapshot, cacheHit: false, staleFallback: false };
    } catch (err) {
      this.lastRefreshError = { message: err.message, at: new Date(this.now()).toISOString() };
      if (this.snapshot && !forceRefresh) {
        this.refreshBlockedUntil = this.now() + this.refreshCooldownMs;
        return { snapshot: this.snapshot, cacheHit: true, staleFallback: true };
      }
      throw err;
    }
  }

  _meta({ cacheHit, staleFallback }) {
    return {
      cacheHit,
      staleFallback,
      lastSyncedAt: new Date(this.lastSyncedAt).toISOString(),
      ...(staleFallback ? { lastRefreshError: this.lastRefreshError } : {}),
    };
  }

  /** Resolves the snapshot plus the response `meta` block for a request. */
  async _index(refreshParam) {
    const refresh = parseBoolean(refreshParam, 'refresh') === true;
    const result = await this.ensureIndex({ forceRefresh: refresh });
    return { snapshot: result.snapshot, meta: this._meta(result) };
  }

  _requireMeter(snapshot, meterId) {
    const meter = snapshot.metersById.get(String(meterId || '').toUpperCase());
    if (!meter) throw notFound(`Meter "${meterId}" not found`);
    return meter;
  }

  /** Multi-attribute filter, text search and geospatial proximity query over all meters. */
  async queryMeters(params = {}) {
    const { snapshot, meta } = await this._index(params.refresh);
    const criteria = parseMeterQuery(params, snapshot.meters);
    const results = filterMeters(snapshot.meters, criteria);
    return {
      ...paginate(results, criteria.paging),
      facets: computeMeterFacets(results),
      meta,
    };
  }

  /** A single meter, optionally verified against the portal's server-rendered detail page. */
  async getMeterById(meterId, { refresh = false, includeSsrDetail = false } = {}) {
    const { snapshot, meta } = await this._index(refresh);
    const meter = this._requireMeter(snapshot, meterId);

    let ssrNameplate;
    if (includeSsrDetail) {
      const rawSsr = await this.client.fetchMeterSsrDetail(meter.meterId);
      if (rawSsr?.detail) ssrNameplate = normalizeSsrDetailPayload(rawSsr.detail);
    }

    const transformer = snapshot.transformersByCode.get(meter.dtCode.toUpperCase());
    return {
      data: {
        ...meter,
        transformer: transformer
          ? {
              code: transformer.code,
              name: transformer.name,
              feederCode: transformer.feederCode,
              capacityKva: transformer.capacityKva,
              peerMeterCount: transformer.meterCount,
            }
          : null,
        ...(ssrNameplate ? { ssrNameplate } : {}),
      },
      meta,
    };
  }

  /** Normalized interval telemetry for a meter, cached per `(meter, from, to)`. */
  async getMeterConsumption(meterId, { from, to, refresh = false } = {}) {
    const { snapshot } = await this._index();
    const meter = this._requireMeter(snapshot, meterId);
    const start = parseDateParam(from, 'from');
    const end = parseDateParam(to, 'to');
    if (start && end && start > end) {
      throw badRequest('"from" must not be later than "to".');
    }

    const { payload, cacheHit, fetchedAt } = await this._loadEnergy(meter, start, end, refresh);
    return {
      data: payload,
      meta: {
        cacheHit,
        fetchedAt: new Date(fetchedAt).toISOString(),
        window: { from: start ?? null, to: end ?? null, isPortalDefault: !start && !end },
      },
    };
  }

  async _loadEnergy(meter, from, to, refresh) {
    const key = `${meter.meterId}:${from ?? 'default'}:${to ?? 'default'}`;
    const cached = this.energyCache.get(key);
    if (!refresh && cached && this.now() - cached.fetchedAt <= this.energyTtlMs) {
      return { payload: cached.payload, cacheHit: true, fetchedAt: cached.fetchedAt };
    }

    // Single-flight: identical concurrent requests share one portal call.
    if (!this.energyInflight.has(key)) {
      const load = (async () => {
        const raw = await this.client.fetchMeterEnergy(meter.meterId, { from, to });
        const payload = {
          ...normalizeEnergyReadings(meter.meterId, raw),
          meter: {
            meterId: meter.meterId,
            serialNo: meter.serialNo,
            make: meter.make,
            phaseType: meter.phaseType,
            installStatus: meter.installStatus,
            installType: meter.installType,
            dtCode: meter.dtCode,
          },
        };
        this._rememberEnergy(key, { fetchedAt: this.now(), payload });
        return { payload, cacheHit: false, fetchedAt: this.now() };
      })().finally(() => this.energyInflight.delete(key));
      this.energyInflight.set(key, load);
    }
    const result = await this.energyInflight.get(key);
    return { ...result };
  }

  /** Inserts into the telemetry cache, evicting the oldest entries beyond the cap. */
  _rememberEnergy(key, entry) {
    this.energyCache.delete(key);
    this.energyCache.set(key, entry);
    while (this.energyCache.size > this.energyCacheMaxEntries) {
      this.energyCache.delete(this.energyCache.keys().next().value);
    }
  }

  async queryTransformers(params = {}) {
    const { snapshot, meta } = await this._index(params.refresh);
    const criteria = parseTransformerQuery(params);
    const results = filterTransformers(snapshot.transformers, criteria);
    return { ...paginate(results, criteria.paging), meta };
  }

  async getTransformerByCode(code, { refresh = false } = {}) {
    const { snapshot, meta } = await this._index(refresh);
    const dt = snapshot.transformersByCode.get(String(code || '').toUpperCase());
    if (!dt) throw notFound(`Transformer "${code}" not found`);
    const meters = snapshot.meters.filter((m) => m.dtCode === dt.code);
    return { data: { ...dt, meters }, meta };
  }

  async getHierarchy({ refresh = false } = {}) {
    const { snapshot, meta } = await this._index(refresh);
    return { data: snapshot.hierarchy, meta };
  }

  async getAnomalies({ refresh = false } = {}) {
    const { snapshot, meta } = await this._index(refresh);
    return { data: snapshot.anomaliesSummary, meta };
  }
}
