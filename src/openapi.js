import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PAGE_SIZE, MAX_METER_PAGE_SIZE, MAX_TRANSFORMER_PAGE_SIZE, METER_SORT_KEYS } from './queries.js';

const jsonContent = (schema) => ({ 'application/json': { schema } });
const errorResponse = (description) => ({
  description,
  content: jsonContent({ $ref: '#/components/schemas/ErrorResponse' }),
});

/** Error responses every upstream-backed operation can return. */
const upstreamErrors = {
  '429': errorResponse('The upstream portal is rate limiting requests (`upstream_rate_limited`).'),
  '502': errorResponse('The upstream portal request failed (`upstream_error`, `upstream_unauthorized`).'),
  '504': errorResponse('The upstream portal timed out (`upstream_timeout`).'),
};

const badRequest = errorResponse(
  'Unknown query parameter, malformed value, or a value outside the allowed set. `error.details` lists the supported parameters or allowed values.',
);

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Urja Meter Ops Clean API Service',
    version: '1.0.0',
    summary: 'Clean, normalized, and resilient REST API over the legacy Urja Meter Ops utility portal.',
    description:
      'Provides programmatic access to smart-meter inventory, distribution transformers, reconstructed 7-level network hierarchy, geospatial proximity search, normalized interval consumption telemetry, and automated data-quality anomaly detection.',
    contact: {
      name: 'Flock Energy Engineering Take-Home',
    },
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Local API server',
    },
  ],
  tags: [
    { name: 'Meters', description: 'Smart-meter inventory, multi-attribute search, geospatial lookup, and consumption telemetry.' },
    { name: 'Transformers', description: 'Distribution Transformers (DT-001..DT-040), capacities, and attached meters.' },
    { name: 'Network Hierarchy', description: 'Reconciled 7-level distribution network hierarchy (Zone › Circle › Division › Subdivision › Substation › Feeder › DT).' },
    { name: 'Data Quality & System', description: 'Automated anomaly audit catalog, cache sync control, and upstream portal health telemetry.' },
  ],
  paths: {
    '/api/v1/health': {
      get: {
        tags: ['Data Quality & System'],
        summary: 'Service & upstream portal health check',
        description: 'Returns service uptime, local index cache freshness, and upstream portal client statistics (login count, 401 re-authentications, 429 rate-limit retries).',
        responses: {
          '200': {
            description: 'Health and cache telemetry',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
              },
            },
          },
        },
      },
    },
    '/api/v1/meters': {
      get: {
        tags: ['Meters'],
        summary: 'List, filter, and geospatially search meters',
        description:
          'Queries the normalized 403-meter index. Supports multi-attribute filtering (make, phase, status, installType, build, granularity), 7-level hierarchy filtering, URL-safe text search (`L&` serials), and Haversine geospatial radius search (`nearLat`, `nearLng`, `radiusKm`).',
        parameters: [
          { name: 'q', in: 'query', description: 'Case-insensitive substring search across meterId, serialNo (including L& serials), dtCode, dtName, or make.', schema: { type: 'string' } },
          { name: 'make', in: 'query', description: 'Filter by manufacturer. Comma-separated, case-insensitive (HPL, L&T, Genus, Allied, Secure).', schema: { type: 'string' } },
          { name: 'phase', in: 'query', description: 'Filter by phase type. Comma-separated, case-insensitive (single, three).', schema: { type: 'string' } },
          { name: 'status', in: 'query', description: 'Filter by installation status. Comma-separated, case-insensitive (Installed, Decommissioned, Faulty).', schema: { type: 'string' } },
          { name: 'installType', in: 'query', description: 'Filter by installation type. Comma-separated, case-insensitive (Whole Current, CT Operated).', schema: { type: 'string' } },
          { name: 'build', in: 'query', description: 'Filter by portal schema build version. Comma-separated (legacy, v2).', schema: { type: 'string' } },
          { name: 'granularity', in: 'query', description: 'Filter by telemetry reporting interval. Comma-separated (30m, daily).', schema: { type: 'string' } },
          { name: 'zone', in: 'query', description: 'Filter by Zone code (e.g. Z-01) or name.', schema: { type: 'string' } },
          { name: 'circle', in: 'query', description: 'Filter by Circle code (e.g. C-01) or name.', schema: { type: 'string' } },
          { name: 'division', in: 'query', description: 'Filter by Division code (e.g. D-01) or name.', schema: { type: 'string' } },
          { name: 'subdivision', in: 'query', description: 'Filter by Subdivision code (e.g. SD-01) or name.', schema: { type: 'string' } },
          { name: 'substation', in: 'query', description: 'Filter by Substation code (e.g. SS-01) or name.', schema: { type: 'string' } },
          { name: 'feeder', in: 'query', description: 'Filter by Feeder code (e.g. F-001) or name.', schema: { type: 'string' } },
          { name: 'dt', in: 'query', description: 'Filter by Distribution Transformer code (e.g. DT-007) or name.', schema: { type: 'string' } },
          { name: 'hasAnomaly', in: 'query', description: 'Filter meters that had structural anomalies healed during ingestion.', schema: { type: 'boolean' } },
          { name: 'serialMismatch', in: 'query', description: 'Filter meters where serialNo prefix contradicts make.', schema: { type: 'boolean' } },
          { name: 'nearLat', in: 'query', description: 'Center latitude for geospatial radius search (e.g. 26.9124). Requires `nearLng`.', schema: { type: 'number', minimum: -90, maximum: 90 } },
          { name: 'nearLng', in: 'query', description: 'Center longitude for geospatial radius search (e.g. 75.7873). Requires `nearLat`.', schema: { type: 'number', minimum: -180, maximum: 180 } },
          { name: 'radiusKm', in: 'query', description: 'Search radius in kilometers when nearLat & nearLng are provided (default: 5).', schema: { type: 'number', minimum: 0, default: 5 } },
          { name: 'page', in: 'query', description: '1-based page number. A page beyond the last is clamped to the last page.', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', description: `Items per page (1–${MAX_METER_PAGE_SIZE}). Larger values are clamped. Pass ${MAX_METER_PAGE_SIZE} to retrieve all 403 meters at once.`, schema: { type: 'integer', minimum: 1, maximum: MAX_METER_PAGE_SIZE, default: DEFAULT_PAGE_SIZE } },
          { name: 'sortBy', in: 'query', description: 'Field to sort by. `distanceKm` requires a geospatial search. Default order is meterId (nearest-first for geospatial searches).', schema: { type: 'string', enum: METER_SORT_KEYS } },
          { name: 'sortOrder', in: 'query', description: 'Sort direction. Requires `sortBy`.', schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' } },
          { name: 'refresh', in: 'query', description: 'Set true to bypass the cache and force an upstream portal sync (throttled to one real sync every few seconds).', schema: { type: 'boolean', default: false } },
        ],
        responses: {
          '200': {
            description: 'Paginated list of normalized meters with facet breakdowns',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MeterListResponse' },
              },
            },
          },
          '400': badRequest,
        },
      },
    },
    '/api/v1/meters/{meterId}': {
      get: {
        tags: ['Meters'],
        summary: 'Get normalized meter details, hierarchy path, and data-quality audit',
        parameters: [
          { name: 'meterId', in: 'path', required: true, description: 'Meter identifier (e.g. J100000 to J100402).', schema: { type: 'string' } },
          { name: 'includeSsrDetail', in: 'query', description: 'Set true to also fetch and decode the raw SvelteKit SSR nameplate payload (/meters/:id/__data.json).', schema: { type: 'boolean', default: false } },
          { name: 'refresh', in: 'query', description: 'Bypass cache and re-sync from upstream portal.', schema: { type: 'boolean', default: false } },
        ],
        responses: {
          '200': {
            description: 'Detailed meter record with parent transformer and hierarchy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MeterDetailResponse' },
              },
            },
          },
          '400': badRequest,
          '404': errorResponse('Meter not found'),
        },
      },
    },
    '/api/v1/meters/{meterId}/consumption': {
      get: {
        tags: ['Meters'],
        summary: 'Get normalized energy consumption & voltage telemetry for a meter',
        description:
          'Fetches interval readings from `/portal/meters/:id/energy`, converts string fields to numbers, parses timestamps to ISO-8601 (`+05:30`), removes corrupted duplicate rows (e.g. J100089), and computes interval deltas (`deltaKwh`), apparent power factor (`kwh/kvah`), and summary statistics. Pass `from=2026-06-01&to=2026-06-30` to retrieve the full 30-day dataset instead of the portal default 7-day window.',
        parameters: [
          { name: 'meterId', in: 'path', required: true, description: 'Meter identifier (e.g. J100000).', schema: { type: 'string' } },
          { name: 'from', in: 'query', description: 'Start date as a real calendar date in YYYY-MM-DD format (e.g. 2026-06-01). Must not be later than `to`.', schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
          { name: 'to', in: 'query', description: 'End date in YYYY-MM-DD format (e.g. 2026-06-30).', schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
          { name: 'refresh', in: 'query', description: 'Bypass telemetry cache and fetch fresh readings.', schema: { type: 'boolean', default: false } },
        ],
        responses: {
          '200': {
            description: 'Normalized consumption time series and summary statistics',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MeterConsumptionResponse' },
              },
            },
          },
          '400': badRequest,
          '404': errorResponse('Meter not found'),
        },
      },
    },
    '/api/v1/transformers': {
      get: {
        tags: ['Transformers'],
        summary: 'List Distribution Transformers (DT-001..DT-040) with attached meter statistics',
        parameters: [
          { name: 'q', in: 'query', description: 'Search by transformer code, name, or feeder code.', schema: { type: 'string' } },
          { name: 'feeder', in: 'query', description: 'Filter by Feeder code (e.g. F-007).', schema: { type: 'string' } },
          { name: 'zone', in: 'query', description: 'Filter by Zone code (e.g. Z-01) or name.', schema: { type: 'string' } },
          { name: 'minCapacityKva', in: 'query', description: 'Minimum transformer capacity in kVA (e.g. 100, 250, 400).', schema: { type: 'number', minimum: 0 } },
          { name: 'page', in: 'query', description: '1-based page number.', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', description: `Items per page (1–${MAX_TRANSFORMER_PAGE_SIZE}).`, schema: { type: 'integer', minimum: 1, maximum: MAX_TRANSFORMER_PAGE_SIZE, default: DEFAULT_PAGE_SIZE } },
          { name: 'refresh', in: 'query', description: 'Bypass the cache and force an upstream portal sync.', schema: { type: 'boolean', default: false } },
        ],
        responses: {
          '200': {
            description: 'List of enriched distribution transformers',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TransformerListResponse' },
              },
            },
          },
          '400': badRequest,
        },
      },
    },
    '/api/v1/transformers/{code}': {
      get: {
        tags: ['Transformers'],
        summary: 'Get a single Distribution Transformer and all meters connected to it',
        parameters: [
          { name: 'code', in: 'path', required: true, description: 'Transformer code (e.g. DT-001 to DT-040).', schema: { type: 'string' } },
          { name: 'refresh', in: 'query', description: 'Bypass the cache and force an upstream portal sync.', schema: { type: 'boolean', default: false } },
        ],
        responses: {
          '200': {
            description: 'Transformer details, upstream hierarchy path, and connected meters',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TransformerDetailResponse' },
              },
            },
          },
          '400': badRequest,
          '404': errorResponse('Transformer not found'),
        },
      },
    },
    '/api/v1/hierarchy': {
      get: {
        tags: ['Network Hierarchy'],
        summary: 'Get reconstructed 7-level network hierarchy tree, DT paths, and DAG multi-parent report',
        description:
          'Returns the healed 7-level hierarchy (Zone › Circle › Division › Subdivision › Substation › Feeder › DT) both as a nested Zone tree and as 40 deterministic DT paths, plus an analysis of intermediate codes that appear under multiple upstream parents.',
        parameters: [
          { name: 'refresh', in: 'query', description: 'Bypass the cache and force an upstream portal sync.', schema: { type: 'boolean', default: false } },
        ],
        responses: {
          '200': {
            description: 'Reconstructed network hierarchy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HierarchyResponse' },
              },
            },
          },
          '400': badRequest,
        },
      },
    },
    '/api/v1/anomalies': {
      get: {
        tags: ['Data Quality & System'],
        summary: 'Get catalog of all upstream portal data anomalies and how they were healed',
        description:
          'Lists all structural anomalies discovered in the portal dataset: 22 missing hierarchy codes/names, 3 conflicting DT-007 names ("Old Malviya Nagar Xfmr" vs "Sanganer DT 7"), 3 non-standard "GN" serial prefixes, 323 serial-prefix/make mismatches, 77 URL-unsafe ampersand serials, and corrupted duplicate telemetry rows.',
        parameters: [
          { name: 'refresh', in: 'query', description: 'Bypass the cache and force an upstream portal sync.', schema: { type: 'boolean', default: false } },
        ],
        responses: {
          '200': {
            description: 'Comprehensive data quality and anomaly report',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AnomaliesResponse' },
              },
            },
          },
          '400': badRequest,
        },
      },
    },
    '/api/v1/sync': {
      post: {
        tags: ['Data Quality & System'],
        summary: 'Force an immediate bulk synchronization with the Urja Meter Ops portal',
        description:
          'Re-fetches the bulk export and transformer registry. To protect the rate limit of the upstream portal, a sync requested within a few seconds of the previous one is not repeated and returns `status: "throttled"`. If the portal is unreachable the call fails (502/504) rather than reporting success with stale data.',
        responses: {
          '200': {
            description: 'Sync completed (`synced`) or skipped because one just ran (`throttled`)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['synced', 'throttled'], example: 'synced' },
                    cache: { type: 'object' },
                  },
                },
              },
            },
          },
          '400': badRequest,
        },
      },
    },
  },
  components: {
    schemas: {
      ResponseMeta: {
        type: 'object',
        description: 'Cache provenance for the response. Also sent as the `X-Cache` header: HIT, MISS or STALE.',
        properties: {
          cacheHit: { type: 'boolean', description: 'True when served from the local index without a fresh portal sync.' },
          staleFallback: { type: 'boolean', description: 'True when a refresh failed and the last good snapshot was served instead.' },
          lastSyncedAt: { type: 'string', format: 'date-time' },
          lastRefreshError: {
            type: ['object', 'null'],
            description: 'Present only when `staleFallback` is true.',
            properties: { message: { type: 'string' }, at: { type: 'string', format: 'date-time' } },
          },
        },
      },
      ConsumptionMeta: {
        type: 'object',
        properties: {
          cacheHit: { type: 'boolean' },
          fetchedAt: { type: 'string', format: 'date-time' },
          window: {
            type: 'object',
            description: 'The requested date window. `isPortalDefault` is true when neither bound was given (the portal returns its default 7-day window).',
            properties: {
              from: { type: ['string', 'null'], example: '2026-06-01' },
              to: { type: ['string', 'null'], example: '2026-06-30' },
              isPortalDefault: { type: 'boolean' },
            },
          },
        },
      },
      HierarchyNode: {
        type: 'object',
        required: ['code', 'name'],
        properties: {
          code: { type: 'string', example: 'Z-01' },
          name: { type: 'string', example: 'Jaipur Zone 1' },
        },
      },
      HierarchyMap: {
        type: 'object',
        properties: {
          zone: { $ref: '#/components/schemas/HierarchyNode' },
          circle: { $ref: '#/components/schemas/HierarchyNode' },
          division: { $ref: '#/components/schemas/HierarchyNode' },
          subdivision: { $ref: '#/components/schemas/HierarchyNode' },
          substation: { $ref: '#/components/schemas/HierarchyNode' },
          feeder: { $ref: '#/components/schemas/HierarchyNode' },
          dt: { $ref: '#/components/schemas/HierarchyNode' },
        },
      },
      Meter: {
        type: 'object',
        required: ['meterId', 'serialNo', 'make', 'phaseType', 'installStatus', 'dtCode'],
        properties: {
          meterId: { type: 'string', example: 'J100000' },
          serialNo: { type: 'string', example: 'SE33962' },
          make: { type: 'string', enum: ['HPL', 'L&T', 'Genus', 'Allied', 'Secure'] },
          phaseType: { type: 'string', enum: ['single', 'three'] },
          installStatus: { type: 'string', enum: ['Installed', 'Decommissioned', 'Faulty'] },
          installType: { type: ['string', 'null'], enum: ['Whole Current', 'CT Operated', null] },
          build: { type: 'string', enum: ['legacy', 'v2'] },
          telemetryGranularity: { type: 'string', enum: ['30m', 'daily'] },
          dtCode: { type: 'string', example: 'DT-001' },
          dtName: { type: ['string', 'null'], example: 'Malviya Nagar DT 1' },
          dtCapacityKva: { type: ['number', 'null'], example: 100 },
          feederCode: { type: ['string', 'null'], example: 'F-001' },
          location: {
            type: ['object', 'null'],
            properties: {
              latitude: { type: 'number', example: 26.938961 },
              longitude: { type: 'number', example: 75.830957 },
            },
          },
          distanceKm: { type: 'number', description: 'Present when geospatial proximity search is used.' },
          hierarchy: { $ref: '#/components/schemas/HierarchyMap' },
          dataQuality: {
            type: 'object',
            properties: {
              hasStructuralAnomaly: { type: 'boolean' },
              serialPrefixMatchesMake: { type: 'boolean' },
              containsUrlUnsafeSerialChar: { type: 'boolean' },
              anomalies: { type: 'array', items: { type: 'object' } },
            },
          },
        },
      },
      Pagination: {
        type: 'object',
        properties: {
          total: { type: 'integer', example: 403 },
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: 20 },
          totalPages: { type: 'integer', example: 21 },
          hasNextPage: { type: 'boolean' },
          hasPrevPage: { type: 'boolean' },
        },
      },
      MeterListResponse: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/Meter' } },
          pagination: { $ref: '#/components/schemas/Pagination' },
          facets: { type: 'object' },
          meta: { $ref: '#/components/schemas/ResponseMeta' },
        },
      },
      MeterDetailResponse: {
        type: 'object',
        properties: {
          data: { $ref: '#/components/schemas/Meter' },
          meta: { $ref: '#/components/schemas/ResponseMeta' },
        },
      },
      ConsumptionReading: {
        type: 'object',
        properties: {
          timestamp: { type: 'string', format: 'date-time', example: '2026-06-23T23:30:00+05:30' },
          rawTimestamp: { type: 'string', example: '23/06/2026 23:30' },
          kwh: { type: 'number', example: 48438.74 },
          kvah: { type: 'number', example: 52313.84 },
          voltR: { type: 'number', example: 226 },
          deltaKwh: { type: ['number', 'null'], example: 0.42 },
          deltaKvah: { type: ['number', 'null'], example: 0.45 },
          powerFactor: { type: ['number', 'null'], example: 0.9259 },
        },
      },
      MeterConsumptionResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              meterId: { type: 'string', example: 'J100000' },
              granularity: { type: 'string', enum: ['30m', 'daily', 'unknown'] },
              count: { type: 'integer', example: 337 },
              rawCount: { type: 'integer', example: 337 },
              summary: {
                type: 'object',
                properties: {
                  startTimestamp: { type: ['string', 'null'] },
                  endTimestamp: { type: ['string', 'null'] },
                  startCumulativeKwh: { type: ['number', 'null'] },
                  endCumulativeKwh: { type: ['number', 'null'] },
                  totalConsumptionKwh: { type: 'number' },
                  totalConsumptionKvah: { type: 'number' },
                  minVoltageR: { type: ['number', 'null'] },
                  maxVoltageR: { type: ['number', 'null'] },
                  avgVoltageR: { type: ['number', 'null'] },
                },
              },
              anomalies: { type: 'array', items: { type: 'object' } },
              readings: { type: 'array', items: { $ref: '#/components/schemas/ConsumptionReading' } },
            },
          },
          meta: { $ref: '#/components/schemas/ConsumptionMeta' },
        },
      },
      Transformer: {
        type: 'object',
        properties: {
          code: { type: 'string', example: 'DT-001' },
          name: { type: 'string', example: 'Malviya Nagar DT 1' },
          aliases: { type: 'array', items: { type: 'string' } },
          feederCode: { type: 'string', example: 'F-001' },
          capacityKva: { type: 'number', example: 100 },
          meterCount: { type: 'integer', example: 10 },
          statusBreakdown: { type: 'object' },
          phaseBreakdown: { type: 'object' },
          hierarchy: { $ref: '#/components/schemas/HierarchyMap' },
          meterIds: { type: 'array', items: { type: 'string' } },
        },
      },
      TransformerListResponse: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/Transformer' } },
          pagination: { $ref: '#/components/schemas/Pagination' },
          meta: { $ref: '#/components/schemas/ResponseMeta' },
        },
      },
      TransformerDetailResponse: {
        type: 'object',
        properties: {
          data: { $ref: '#/components/schemas/Transformer' },
          meta: { $ref: '#/components/schemas/ResponseMeta' },
        },
      },
      HierarchyResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              levels: { type: 'array', items: { type: 'string' } },
              topologyNote: { type: 'string' },
              multiParentNodesCount: { type: 'integer' },
              multiParentNodes: { type: 'array', items: { type: 'object' } },
              zones: { type: 'array', items: { type: 'object' } },
              dtPaths: { type: 'array', items: { type: 'object' } },
            },
          },
          meta: { $ref: '#/components/schemas/ResponseMeta' },
        },
      },
      AnomaliesResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              totalStructuralAnomalies: { type: 'integer' },
              missingHierarchyCodes: { type: 'integer' },
              missingHierarchyNames: { type: 'integer' },
              dtNameConflicts: { type: 'integer' },
              nonStandardSerialPrefixes: { type: 'integer' },
              serialMakeMismatches: { type: 'integer' },
              urlUnsafeSerialsCount: { type: 'integer' },
              knownCorruptedTelemetryMeters: { type: 'array', items: { type: 'string' } },
              records: { type: 'array', items: { type: 'object' } },
            },
          },
          meta: { $ref: '#/components/schemas/ResponseMeta' },
        },
      },
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'degraded'], description: '`degraded` when the last portal refresh failed and stale data is being served.', example: 'ok' },
          uptimeSeconds: { type: 'number' },
          cache: { type: 'object' },
          upstreamPortal: { type: 'object' },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              status: { type: 'integer' },
              details: { type: 'object', description: 'Optional structured context, e.g. `allowed` values or `supported` parameters.' },
            },
          },
        },
      },
    },
  },
};

// Every operation that talks to the portal can fail upstream; document that once, here.
for (const [route, operations] of Object.entries(openApiSpec.paths)) {
  if (route === '/api/v1/health') continue;
  for (const operation of Object.values(operations)) {
    operation.responses = { ...operation.responses, ...upstreamErrors };
  }
}

if (process.argv.includes('--write')) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.resolve(__dirname, '..', 'openapi.json');
  fs.writeFileSync(outPath, JSON.stringify(openApiSpec, null, 2) + '\n', 'utf8');
  console.log(`Wrote OpenAPI spec to ${outPath}`);
}
