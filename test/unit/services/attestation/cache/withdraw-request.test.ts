import { describe, expect, it, jest } from "@jest/globals";

import { WithdrawRequestCache } from "../../../../../src/services/attestation/cache/withdraw-request";
import {
  WithdrawRequestAttestationContext,
  WithdrawRequestAttestationMessage,
} from "../../../../../src/services/attestation";

type Signature = {
  oracleSigner: string;
  signature: `0x${string}`;
};

const allocator = "0x0000000000000000000000000000000000000001";
const oracleSigner = "0x0000000000000000000000000000000000000002";
const withdrawRequestHash = `0x${"11".repeat(32)}`;
const otherWithdrawRequestHash = `0x${"22".repeat(32)}`;
const hashes = [
  `0x${"aa".repeat(32)}`,
  `0x${"bb".repeat(32)}`,
  `0x${"cc".repeat(32)}`,
];

const context: WithdrawRequestAttestationContext = {
  chainId: 1,
  allocator,
  withdrawRequestHash,
};

const attestation = (
  indexes: number[],
  overrides: Partial<WithdrawRequestAttestationMessage> = {},
): WithdrawRequestAttestationMessage => ({
  ...context,
  hashesToSign: indexes.map((index) => hashes[index]),
  ...overrides,
});

const createDeferred = <V>() => {
  let resolve!: (value: V) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<V>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createCache = ({
  maxCount = 10,
  sign,
}: {
  maxCount?: number;
  sign?: (
    message: WithdrawRequestAttestationMessage,
  ) => Promise<Signature>;
} = {}) => {
  const resolvedSign =
    sign ??
    jest.fn(async () => ({
      oracleSigner,
      signature: "0x01" as `0x${string}`,
    }));
  return {
    cache: new WithdrawRequestCache({
      ttlMs: 1000,
      maxCount,
      cleanupIntervalMs: false,
      sign: resolvedSign,
    }),
    sign: resolvedSign,
  };
};

const resolve = (
  cache: WithdrawRequestCache,
  hashIndexes: number[],
  fetchAttestation: () => Promise<WithdrawRequestAttestationMessage> = async () =>
    attestation(hashIndexes),
) => cache.resolve({ context, hashIndexes, fetchAttestation });

describe("WithdrawRequestCache", () => {
  it("rejects requests above the index limit", async () => {
    const { cache } = createCache();

    await expect(
      resolve(
        cache,
        Array.from({ length: 257 }, (_, index) => index),
      ),
    ).rejects.toThrow("between 1 and 256");
  });

  it("returns an exact cached attestation without another HTTP read or signature", async () => {
    const { cache, sign } = createCache();
    const fetchAttestation = jest.fn(async () => attestation([0, 1]));

    const first = await resolve(cache, [0, 1], fetchAttestation);
    const second = await resolve(cache, [0, 1], fetchAttestation);

    expect(second).toBe(first);
    expect(fetchAttestation).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("derives ordered subsets with duplicates from cached components", async () => {
    const { cache, sign } = createCache();
    await resolve(cache, [0, 1]);
    const fetchAttestation = jest.fn(async () => attestation([1, 0, 1]));

    const result = await resolve(cache, [1, 0, 1], fetchAttestation);

    expect(result.hashesToSign).toEqual([hashes[1], hashes[0], hashes[1]]);
    expect(fetchAttestation).not.toHaveBeenCalled();
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it("uses HTTP when any requested component is missing", async () => {
    const { cache } = createCache();
    await resolve(cache, [0]);
    const fetchAttestation = jest.fn(async () => attestation([0, 1]));

    const result = await resolve(cache, [0, 1], fetchAttestation);

    expect(result.hashesToSign).toEqual([hashes[0], hashes[1]]);
    expect(fetchAttestation).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent HTTP fallback for the same exact request", async () => {
    const { cache } = createCache();
    const deferred = createDeferred<WithdrawRequestAttestationMessage>();
    const fetchAttestation = jest.fn(() => deferred.promise);

    const first = resolve(cache, [0], fetchAttestation);
    const second = resolve(cache, [0], fetchAttestation);
    deferred.resolve(attestation([0]));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchAttestation).toHaveBeenCalledTimes(1);
  });

  it("returns an exact cache entry that arrives before HTTP fails", async () => {
    const { cache } = createCache();
    const deferred = createDeferred<WithdrawRequestAttestationMessage>();
    const httpError = new Error("Relay RPC failed");
    const fetchAttestation = jest.fn(() => deferred.promise);
    const pending = resolve(cache, [0], fetchAttestation);

    await new Promise(setImmediate);
    expect(fetchAttestation).toHaveBeenCalledTimes(1);
    const observed = await cache.signAndStore(attestation([0]), [0]);
    deferred.reject(httpError);

    await expect(pending).resolves.toBe(observed);
  });

  it("returns an exact entry that arrives while component signing is running", async () => {
    const derivedSignature = createDeferred<Signature>();
    const sign = jest
      .fn<(message: WithdrawRequestAttestationMessage) => Promise<Signature>>()
      .mockResolvedValueOnce({ oracleSigner, signature: "0x01" })
      .mockImplementationOnce(() => derivedSignature.promise)
      .mockResolvedValueOnce({ oracleSigner, signature: "0x03" });
    const { cache } = createCache({ sign });
    await cache.signAndStore(attestation([0, 1]), [0, 1]);
    const fetchAttestation = jest.fn(async () => attestation([1, 0]));

    const pending = resolve(cache, [1, 0], fetchAttestation);
    await new Promise(setImmediate);
    const exact = await cache.signAndStore(attestation([1, 0]), [1, 0]);

    await expect(pending).resolves.toBe(exact);
    expect(fetchAttestation).not.toHaveBeenCalled();
    derivedSignature.resolve({ oracleSigner, signature: "0x02" });
    await new Promise(setImmediate);
  });

  it("keeps shared components until their final signed owner is evicted", async () => {
    const { cache } = createCache({ maxCount: 2 });
    await cache.signAndStore(attestation([0]), [0]);
    await cache.signAndStore(attestation([0, 1]), [0, 1]);
    await cache.signAndStore(
      attestation([0], { withdrawRequestHash: otherWithdrawRequestHash }),
      [0],
    );
    const fetchAttestation = jest.fn(async () => attestation([0]));

    await resolve(cache, [0], fetchAttestation);

    expect(fetchAttestation).not.toHaveBeenCalled();
    cache.evictWithdrawal(withdrawRequestHash);
    await resolve(cache, [0], fetchAttestation);
    expect(fetchAttestation).toHaveBeenCalledTimes(1);
  });

  it("does not let a delayed conflicting observation overwrite newer data", async () => {
    const signatures = [
      createDeferred<Signature>(),
      createDeferred<Signature>(),
    ];
    const sign = jest
      .fn<(message: WithdrawRequestAttestationMessage) => Promise<Signature>>()
      .mockImplementationOnce(() => signatures[0].promise)
      .mockImplementationOnce(() => signatures[1].promise);
    const { cache } = createCache({ sign });
    const oldObservation = cache.signAndStore(attestation([0]), [0]);
    const newerHash = `0x${"dd".repeat(32)}`;
    const newObservation = cache.signAndStore(
      attestation([0], { hashesToSign: [newerHash] }),
      [0],
    );

    signatures[1].resolve({
      oracleSigner,
      signature: "0x02" as `0x${string}`,
    });
    await expect(newObservation).resolves.toMatchObject({
      hashesToSign: [newerHash],
    });
    signatures[0].resolve({
      oracleSigner,
      signature: "0x01" as `0x${string}`,
    });
    await expect(oldObservation).resolves.toMatchObject({
      hashesToSign: [newerHash],
    });

    const result = await resolve(cache, [0]);
    expect(result.hashesToSign).toEqual([newerHash]);
  });

  it("does not cache an event that is removed while signing", async () => {
    const signature = createDeferred<Signature>();
    const { cache } = createCache({ sign: jest.fn(() => signature.promise) });
    const provenance = {
      transactionHash: `0x${"33".repeat(32)}`,
      blockNumber: "0x1",
      logIndex: "0x0",
    };
    const observation = cache.beginObservation(
      attestation([0]),
      [0],
      provenance,
    );
    const pending = cache.signObservation(observation);

    expect(cache.invalidateEvent(attestation([0]), [0], provenance)).toBe(0);
    signature.resolve({ oracleSigner, signature: "0x01" });
    await expect(pending).resolves.toBeUndefined();

    const fetchAttestation = jest.fn(async () => attestation([0]));
    await resolve(cache, [0], fetchAttestation);
    expect(fetchAttestation).toHaveBeenCalledTimes(1);
  });

  it("ignores removal for an observation superseded at another event location", async () => {
    const { cache } = createCache();
    const oldProvenance = {
      transactionHash: `0x${"33".repeat(32)}`,
      blockNumber: "0x1",
      logIndex: "0x0",
    };
    const newProvenance = {
      transactionHash: `0x${"44".repeat(32)}`,
      blockNumber: "0x2",
      logIndex: "0x0",
    };
    await cache.signObservation(
      cache.beginObservation(attestation([0]), [0], oldProvenance),
    );
    await cache.signObservation(
      cache.beginObservation(attestation([0]), [0], newProvenance),
    );

    expect(cache.invalidateEvent(attestation([0]), [0], oldProvenance)).toBe(
      0,
    );
    const fetchAttestation = jest.fn(async () => attestation([0]));
    await resolve(cache, [0], fetchAttestation);
    expect(fetchAttestation).not.toHaveBeenCalled();
  });

  it("keeps a failed newer observation from making an older write current", async () => {
    const oldSignature = createDeferred<Signature>();
    const newSignature = createDeferred<Signature>();
    const sign = jest
      .fn<(message: WithdrawRequestAttestationMessage) => Promise<Signature>>()
      .mockImplementationOnce(() => oldSignature.promise)
      .mockImplementationOnce(() => newSignature.promise);
    const { cache } = createCache({ sign });
    const oldObservation = cache.signAndStore(attestation([0]), [0]);
    const newerHash = `0x${"dd".repeat(32)}`;
    const newObservation = cache.signAndStore(
      attestation([0], { hashesToSign: [newerHash] }),
      [0],
    );

    newSignature.reject(new Error("signing failed"));
    await expect(newObservation).rejects.toThrow("signing failed");
    oldSignature.resolve({ oracleSigner, signature: "0x01" });
    await expect(oldObservation).resolves.toBeUndefined();
  });
});
