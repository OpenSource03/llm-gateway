interface AuthFailureEntry {
  count: number;
  resetAt: number;
}

interface AuthFailureRateLimiterOptions {
  limit: number;
  maxKeys: number;
  windowMs: number;
  now?: () => number;
}

/**
 * A process-local fixed-window limiter with a hard memory bound. Map insertion
 * order is used as an LRU list, so lookup, refresh and eviction do not scan all
 * tracked callers. Expired entries may remain until accessed or evicted, but
 * they can never make the map exceed maxKeys.
 */
export class AuthFailureRateLimiter {
  private readonly entries = new Map<string, AuthFailureEntry>();
  private readonly limit: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(options: AuthFailureRateLimiterOptions) {
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      !Number.isSafeInteger(options.maxKeys) ||
      options.maxKeys < 1 ||
      !Number.isSafeInteger(options.windowMs) ||
      options.windowMs < 1
    ) {
      throw new TypeError(
        "Auth failure limiter options must be positive integers",
      );
    }

    this.limit = options.limit;
    this.maxKeys = options.maxKeys;
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs;
  }

  retryAt(key: string): Date | null {
    const entry = this.activeEntry(key);

    return entry && entry.count >= this.limit ? new Date(entry.resetAt) : null;
  }

  recordFailure(key: string): void {
    const now = this.now();
    const existing = this.entries.get(key);
    const entry =
      existing && existing.resetAt > now
        ? { ...existing, count: Math.min(existing.count + 1, this.limit) }
        : { count: 1, resetAt: now + this.windowMs };

    if (existing) this.entries.delete(key);
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next().value as string | undefined;

      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  private activeEntry(key: string): AuthFailureEntry | null {
    const entry = this.entries.get(key);

    if (!entry) return null;
    if (entry.resetAt <= this.now()) {
      this.entries.delete(key);

      return null;
    }

    // Refresh insertion order to make this an O(1) LRU touch.
    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry;
  }
}
