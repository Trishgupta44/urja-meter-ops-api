import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '..', '.env');

// Load .env if present (zero-dependency)
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

export const config = {
  port: Number(process.env.PORT || 3000),
  portalBaseUrl: (process.env.PORTAL_BASE_URL || 'https://urja-ops.flockenergy.tech').replace(/\/+$/, ''),
  portalEmail: process.env.PORTAL_EMAIL || 'operator@urja.local',
  portalPassword: process.env.PORTAL_PASSWORD || 'urja-ops-2026',
  indexTtlMs: Number(process.env.INDEX_TTL_MS || 5 * 60 * 1000),       // 5 minutes default TTL for bulk index
  energyTtlMs: Number(process.env.ENERGY_TTL_MS || 2 * 60 * 1000),     // 2 minutes default TTL for per-meter telemetry
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 15000),   // 15s upstream request timeout
  maxRetries: Number(process.env.MAX_RETRIES || 3),                    // Retries for 429 / 5xx / transient errors
  staleRetryCooldownMs: Number(process.env.STALE_RETRY_COOLDOWN_MS || 30_000),        // Pause between refresh attempts while serving stale data
  minForceRefreshIntervalMs: Number(process.env.MIN_FORCE_REFRESH_INTERVAL_MS || 5_000), // Throttle for ?refresh=true / POST /sync
  energyCacheMaxEntries: Number(process.env.ENERGY_CACHE_MAX_ENTRIES || 500),         // Cap on cached telemetry windows
};
