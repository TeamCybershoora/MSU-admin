/**
 * Simple in-memory rate limiter for Next.js Route Handlers.
 *
 * LIMITATION:
 * - In-memory store: counters reset on server restart.
 * - Not shared across multiple instances (e.g. serverless, clustering).
 * - For production at scale, consider upgrading to a Redis-backed store.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimiterOptions {
  /** Time window in milliseconds (default: 15 minutes). */
  windowMs?: number;
  /** Max requests per window per IP (default: 10). */
  limit?: number;
  /** Unique name for this limiter (used to namespace the counter). */
  name?: string;
}

// Global store that persists across hot-reloads in development.
declare global {
  // `var` is required for global augmentation — `let`/`const` are not accepted here.
  var rateLimitStore: Map<string, RateLimitEntry> | undefined;
}

function getStore(): Map<string, RateLimitEntry> {
  if (!global.rateLimitStore) {
    global.rateLimitStore = new Map();

    // Periodic cleanup every 5 minutes to prevent memory leaks.
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of global.rateLimitStore!.entries()) {
        if (now > entry.resetAt) {
          global.rateLimitStore!.delete(key);
        }
      }
    }, 5 * 60 * 1000).unref();
  }
  return global.rateLimitStore;
}

/**
 * Extract client IP from a Next.js Request.
 * Checks x-forwarded-for (reverse proxy) then falls back to a default.
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return "unknown";
}

export function createRateLimiter(options: RateLimiterOptions = {}) {
  const { windowMs = 15 * 60 * 1000, limit = 10, name = "default" } = options;
  const store = getStore();

  return {
    /**
     * Check if the request exceeds the rate limit.
     * Returns `true` if the request should be blocked (429).
     */
    check(req: Request): boolean {
      const ip = getClientIp(req);
      const now = Date.now();
      const key = `ratelimit:${name}:${ip}`;
      const entry = store.get(key);

      if (!entry || now > entry.resetAt) {
        // New window
        store.set(key, { count: 1, resetAt: now + windowMs });
        return false;
      }

      entry.count += 1;

      if (entry.count > limit) {
        return true; // blocked
      }

      return false; // allowed
    },
  };
}
