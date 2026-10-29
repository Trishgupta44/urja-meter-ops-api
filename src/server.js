import http from 'node:http';
import { config } from './config.js';
import { PortalClient } from './portalClient.js';
import { UrjaDataStore } from './store.js';
import { createRequestHandler } from './app.js';

const client = new PortalClient();
const store = new UrjaDataStore(client);
const server = http.createServer(createRequestHandler(store));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Set PORT to a free port and retry.`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(config.port, async () => {
  console.log('==================================================================');
  console.log(`Urja Meter Ops Clean API & Modern Web Client listening on port ${config.port}`);
  console.log(`- Web Dashboard : http://localhost:${config.port}/`);
  console.log(`- Interactive UI: http://localhost:${config.port}/docs`);
  console.log(`- OpenAPI Spec  : http://localhost:${config.port}/openapi.json`);
  console.log(`- Health Check  : http://localhost:${config.port}/api/v1/health`);
  console.log('==================================================================');

  // Warm the index so the first request is fast; the server stays up if the portal is down.
  try {
    const start = Date.now();
    const { snapshot } = await store.ensureIndex({ forceRefresh: true });
    console.log(
      `[Bootstrap] Synced ${snapshot.meters.length} meters and ${snapshot.transformers.length} transformers ` +
      `(${snapshot.anomaliesSummary.totalStructuralAnomalies} structural anomalies healed) in ${Date.now() - start}ms.`,
    );
  } catch (err) {
    console.warn(`[Bootstrap] Initial portal sync deferred: ${err.message}`);
  }
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down…`);
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
