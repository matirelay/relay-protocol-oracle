import { describe, expect, it, jest } from "@jest/globals";

import {
  AttestationCache,
  CacheEviction,
} from "../../../src/common/attestation-cache";

const createCache = <V>({
  now,
  maxCount = 10,
  maxWeight,
  getWeight,
  onEvict,
}: {
  now: () => number;
  maxCount?: number;
  maxWeight?: number;
  getWeight?: (value: V) => number;
  onEvict?: (eviction: CacheEviction<V>) => void;
}) =>
  new AttestationCache<V>({
    ttlMs: 1000,
    maxCount,
    maxWeight,
    getWeight,
    cleanupIntervalMs: false,
    now,
    onEvict,
  });

const createEvictionSpy = <V>() =>
  jest.fn<(eviction: CacheEviction<V>) => void>();

describe("AttestationCache", () => {
  it("expires entries from their last write without extending TTL on read", () => {
    let time = 0;
    const onEvict = createEvictionSpy<string>();
    const cache = createCache({ now: () => time, onEvict });

    cache.set("key", "value");
    time = 900;
    expect(cache.get("key")).toBe("value");

    time = 1000;
    expect(cache.get("key")).toBeUndefined();
    expect(onEvict).toHaveBeenCalledWith({
      key: "key",
      value: "value",
      reason: "expired",
    });
  });

  it("refreshes TTL and recency without replacing the value", () => {
    let time = 0;
    const onEvict = createEvictionSpy<string>();
    const cache = createCache({ now: () => time, maxCount: 2, onEvict });

    cache.set("key", "first");
    cache.set("other", "second");
    time = 900;
    expect(cache.refresh("key")).toBe(true);
    cache.set("third", "third");

    expect(cache.get("other")).toBeUndefined();
    time = 1500;

    expect(cache.get("key")).toBe("first");
    expect(onEvict).toHaveBeenCalledWith({
      key: "other",
      value: "second",
      reason: "capacity",
    });
  });

  it("evicts the least recently used entry at capacity", () => {
    const onEvict = createEvictionSpy<number>();
    const cache = createCache({
      now: () => 0,
      maxCount: 2,
      onEvict,
    });

    cache.set("first", 1);
    cache.set("second", 2);
    cache.get("first");
    cache.set("third", 3);

    expect(cache.get("first")).toBe(1);
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("third")).toBe(3);
    expect(onEvict).toHaveBeenCalledWith({
      key: "second",
      value: 2,
      reason: "capacity",
    });
  });

  it("evicts least recently used entries when their weight exceeds capacity", () => {
    const cache = createCache<number>({
      now: () => 0,
      maxWeight: 5,
      getWeight: (value) => value,
    });

    cache.set("first", 2);
    cache.set("second", 2);
    cache.get("first");
    cache.set("third", 2);

    expect(cache.get("first")).toBe(2);
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("third")).toBe(2);
    expect(cache.weight).toBe(4);
  });

  it("reports replacements through the eviction callback", () => {
    const onEvict = createEvictionSpy<string>();
    const cache = createCache({ now: () => 0, onEvict });

    cache.set("key", "first");
    cache.set("key", "second");

    expect(cache.get("key")).toBe("second");
    expect(onEvict).toHaveBeenCalledWith({
      key: "key",
      value: "first",
      reason: "replaced",
    });
  });

  it("resolves exact-key waiters when an entry is inserted", async () => {
    const cache = createCache<string>({ now: () => 0 });
    const waiter = cache.waitFor("target");

    cache.set("other", "ignored");
    cache.set("target", "result");

    await expect(waiter.promise).resolves.toBe("result");
  });

  it("cancels a waiter without resolving it on a later write", async () => {
    const cache = createCache<string>({ now: () => 0 });
    const waiter = cache.waitFor("target");
    const resolved = jest.fn();
    void waiter.promise.then(resolved);

    waiter.cancel();
    cache.set("target", "result");
    await Promise.resolve();

    expect(resolved).not.toHaveBeenCalled();
  });

  it("periodically removes expired entries", () => {
    jest.useFakeTimers();
    const onEvict = createEvictionSpy<string>();
    const cache = new AttestationCache<string>({
      ttlMs: 1000,
      maxCount: 10,
      cleanupIntervalMs: 100,
      onEvict,
    });

    try {
      cache.set("key", "value");
      jest.advanceTimersByTime(1000);

      expect(onEvict).toHaveBeenCalledWith({
        key: "key",
        value: "value",
        reason: "expired",
      });
    } finally {
      cache.stopCleanup();
      jest.useRealTimers();
    }
  });

});
