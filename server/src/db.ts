import mongoose from 'mongoose';

const isDev = process.env['NODE_ENV'] !== 'production';

// Persistence is treated as optional infrastructure: a missing/unreachable
// database must never take down the chat endpoint, which has nothing to do
// with it. Connect best-effort, log clearly, and let the conversations
// routes report unavailability per-request instead of crashing the process.
export function connectMongo(uri: string | undefined): void {
  if (!uri) {
    if (isDev) {
      void startLocalFallback('MONGODB_URI is not set');
      return;
    }
    console.warn(
      '[startup] MONGODB_URI is not set — conversation persistence endpoints will return 503 until it is configured.',
    );
    return;
  }

  mongoose.connect(uri).then(
    () => console.log('[startup] Connected to MongoDB.'),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[startup] Failed to connect to MongoDB:', message);
      if (isDev) {
        void startLocalFallback(message);
      }
    },
  );
}

// Dev-only escape hatch for when the configured Atlas cluster is unreachable
// (e.g. IP not whitelisted, no network access) — spins up a real MongoDB
// binary in-process via mongodb-memory-server so conversation persistence
// still works locally. Data does not survive a server restart. Never runs
// in production: mongodb-memory-server is a devDependency and this whole
// path is gated on isDev.
async function startLocalFallback(reason: string): Promise<void> {
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const memoryServer = await MongoMemoryServer.create();
    await mongoose.connect(memoryServer.getUri());
    console.log(
      `[startup] Configured MongoDB was unreachable (${reason}). ` +
        'Connected to a local in-memory MongoDB instead for development — ' +
        'saved conversations will be lost when the server restarts.',
    );
  } catch (fallbackErr) {
    console.error(
      '[startup] Also failed to start the local in-memory MongoDB fallback:',
      fallbackErr instanceof Error ? fallbackErr.message : fallbackErr,
    );
  }
}

export function isMongoConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
