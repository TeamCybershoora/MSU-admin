import mongoose from "mongoose";

/**
 * Cached Mongoose connection for Next.js.
 *
 * In development, Next.js hot-reloads modules on every request. Without
 * caching, each reload creates a new Mongoose connection, quickly exhausting
 * MongoDB's connection limit. The global variable persists across reloads.
 *
 * In production a single connection is reused for the process lifetime.
 */

function getUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not defined in the environment. " +
        "Add it to your .env.local file at the project root."
    );
  }
  return uri;
}

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  // `var` is required for global augmentation — `let`/`const` are not accepted here.
  var mongooseCache: MongooseCache | undefined;
}

const cached: MongooseCache = global.mongooseCache ?? {
  conn: null,
  promise: null,
};

if (!global.mongooseCache) {
  global.mongooseCache = cached;
}

export async function connectDB(): Promise<typeof mongoose> {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = mongoose.connect(getUri());
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

export default connectDB;
