export type CacheEvictionReason =
  | "capacity"
  | "cleared"
  | "deleted"
  | "expired"
  | "replaced";

export type CacheEviction<V> = {
  key: string;
  value: V;
  reason: CacheEvictionReason;
};

type CacheEntry<V> = {
  value: V;
  expiresAt: number;
  weight: number;
};

type CacheOptions<V> = {
  ttlMs: number;
  maxCount: number;
  maxWeight?: number;
  getWeight?: (value: V) => number;
  cleanupIntervalMs?: number | false;
  now?: () => number;
  onEvict?: (eviction: CacheEviction<V>) => void;
};

export type CacheWaiter<V> = {
  promise: Promise<V>;
  cancel: () => void;
};

export class AttestationCache<V> {
  private readonly entries = new Map<string, CacheEntry<V>>();
  private readonly waiters = new Map<string, Set<(value: V) => void>>();
  private readonly ttlMs: number;
  private readonly maxCount: number;
  private readonly maxWeight: number;
  private readonly getWeight: (value: V) => number;
  private readonly now: () => number;
  private readonly onEvict?: (eviction: CacheEviction<V>) => void;
  private readonly cleanupTimer?: ReturnType<typeof setInterval>;
  private totalWeight = 0;

  public constructor({
    ttlMs,
    maxCount,
    maxWeight = Number.POSITIVE_INFINITY,
    getWeight = () => 1,
    cleanupIntervalMs = Math.min(ttlMs, 60_000),
    now = Date.now,
    onEvict,
  }: CacheOptions<V>) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Attestation cache TTL must be a positive number");
    }
    if (!Number.isInteger(maxCount) || maxCount < 1) {
      throw new Error(
        "Attestation cache maximum count must be a positive integer",
      );
    }
    if (maxWeight <= 0 || Number.isNaN(maxWeight)) {
      throw new Error("Attestation cache maximum weight must be positive");
    }
    if (
      cleanupIntervalMs !== false &&
      (!Number.isFinite(cleanupIntervalMs) || cleanupIntervalMs <= 0)
    ) {
      throw new Error(
        "Attestation cache cleanup interval must be a positive number",
      );
    }

    this.ttlMs = ttlMs;
    this.maxCount = maxCount;
    this.maxWeight = maxWeight;
    this.getWeight = getWeight;
    this.now = now;
    this.onEvict = onEvict;

    if (cleanupIntervalMs !== false) {
      this.cleanupTimer = setInterval(
        () => this.purgeExpired(),
        cleanupIntervalMs,
      );
      this.cleanupTimer.unref();
    }
  }

  public get size(): number {
    return this.entries.size;
  }

  public get weight(): number {
    return this.totalWeight;
  }

  public get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.remove(key, "expired");
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  public set(key: string, value: V): void {
    const currentTime = this.now();
    const weight = this.getWeight(value);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error("Attestation cache entry weight must be positive");
    }
    const existing = this.entries.get(key);
    if (existing) {
      this.remove(
        key,
        existing.expiresAt <= currentTime ? "expired" : "replaced",
      );
    }

    this.entries.set(key, {
      value,
      expiresAt: currentTime + this.ttlMs,
      weight,
    });
    this.totalWeight += weight;
    this.enforceCapacity();
    this.resolveWaiters(key, value);
  }

  public refresh(key: string): boolean {
    const currentTime = this.now();
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt <= currentTime) {
      this.remove(key, "expired");
      return false;
    }

    entry.expiresAt = currentTime + this.ttlMs;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return true;
  }

  public delete(key: string): boolean {
    return this.remove(key, "deleted");
  }

  public deleteWhere(
    predicate: (key: string, value: V) => boolean,
  ): number {
    let deleted = 0;
    for (const [key, entry] of this.entries) {
      if (predicate(key, entry.value)) {
        this.remove(key, "deleted");
        deleted += 1;
      }
    }
    return deleted;
  }

  public clear(): void {
    for (const key of this.entries.keys()) {
      this.remove(key, "cleared");
    }
  }

  public purgeExpired(): number {
    const currentTime = this.now();
    let deleted = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= currentTime) {
        this.remove(key, "expired");
        deleted += 1;
      }
    }
    return deleted;
  }

  public waitFor(key: string): CacheWaiter<V> {
    const existing = this.get(key);
    if (existing !== undefined) {
      return {
        promise: Promise.resolve(existing),
        cancel: () => undefined,
      };
    }

    let active = true;
    let resolvePromise!: (value: V) => void;
    const promise = new Promise<V>((resolve) => {
      resolvePromise = resolve;
    });
    const resolve = (value: V) => {
      if (!active) {
        return;
      }
      active = false;
      resolvePromise(value);
    };
    const keyWaiters = this.waiters.get(key) ?? new Set();
    keyWaiters.add(resolve);
    this.waiters.set(key, keyWaiters);

    return {
      promise,
      cancel: () => {
        if (!active) {
          return;
        }
        active = false;
        keyWaiters.delete(resolve);
        if (keyWaiters.size === 0) {
          this.waiters.delete(key);
        }
      },
    };
  }

  public stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  private enforceCapacity(): void {
    while (
      this.entries.size > this.maxCount ||
      this.totalWeight > this.maxWeight
    ) {
      const oldest = this.entries.entries().next().value as
        | [string, CacheEntry<V>]
        | undefined;
      if (!oldest) {
        return;
      }
      const [key, entry] = oldest;
      this.remove(
        key,
        entry.expiresAt <= this.now() ? "expired" : "capacity",
      );
    }
  }

  private remove(
    key: string,
    reason: CacheEvictionReason,
  ): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }

    this.entries.delete(key);
    this.totalWeight -= entry.weight;
    this.onEvict?.({ key, value: entry.value, reason });
    return true;
  }

  private resolveWaiters(key: string, value: V): void {
    const keyWaiters = this.waiters.get(key);
    if (!keyWaiters) {
      return;
    }

    this.waiters.delete(key);
    for (const resolve of keyWaiters) {
      resolve(value);
    }
  }
}
