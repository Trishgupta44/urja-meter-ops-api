import { PortalClient } from '../src/portalClient.js';
import { UrjaDataStore } from '../src/store.js';
import { createRequestHandler } from '../src/app.js';

// Serverless entry point (Vercel). The store lives for the lifetime of a warm instance,
// so the portal is synced once per cold start and then served from memory.
const store = new UrjaDataStore(new PortalClient());

export default createRequestHandler(store);
