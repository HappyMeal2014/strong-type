import mongoose from 'mongoose';

// Persistence is treated as optional infrastructure: a missing/unreachable
// database must never take down the chat endpoint, which has nothing to do
// with it. Connect best-effort, log clearly, and let the conversations
// routes report unavailability per-request instead of crashing the process.
export function connectMongo(uri: string | undefined): void {
  if (!uri) {
    console.warn(
      '[startup] MONGODB_URI is not set — conversation persistence endpoints will return 503 until it is configured.',
    );
    return;
  }

  mongoose.connect(uri).then(
    () => console.log('[startup] Connected to MongoDB.'),
    (err: unknown) => {
      console.error(
        '[startup] Failed to connect to MongoDB:',
        err instanceof Error ? err.message : err,
      );
    },
  );
}

export function isMongoConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
