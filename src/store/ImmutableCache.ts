/**
 * Small LRU cache for immutable store records (commits, trees, revision pages): they never change once
 * written, so a cached copy is always valid. Bounded by the total size of the cached bytes.
 */
export class ImmutableCache<T> {
  private readonly entries = new Map<string, { value: T; size: number }>();
  private total = 0;

  constructor(private readonly maxBytes = 8 * 1024 * 1024) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, size: number): void {
    if (size > this.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous) {
      this.total -= previous.size;
      this.entries.delete(key);
    }
    this.entries.set(key, { value, size });
    this.total += size;
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.total -= entry.size;
    }
  }
}
