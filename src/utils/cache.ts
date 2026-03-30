/**
 * Simple in-memory TTL cache.
 *
 * Entries expire after `ttlMs` milliseconds and are lazily evicted on read.
 */
export class TTLCache<T> {
  private cache = new Map<string, { value: T; expiresAt: number }>();

  constructor(private ttlMs: number = 30_000) {}

  /** Return cached value or `undefined` if missing / expired. */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Store a value with the configured TTL. */
  set(key: string, value: T): void {
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Drop all entries. */
  clear(): void {
    this.cache.clear();
  }
}
