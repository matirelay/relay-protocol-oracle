import { RelayAllocator } from "@relay-protocol/settlement-abis";
import { describe, expect, it, jest } from "@jest/globals";
import { encodeAbiParameters, encodeEventTopics, Hex } from "viem";

import { WithdrawRequestCache } from "../../../../../src/services/attestation/cache/withdraw-request";
import { subscribeAllocatorPayloadBuilt } from "../../../../../src/services/attestation/event/allocator";
import {
  EventConnection,
  EventLog,
} from "../../../../../src/services/attestation/event/connection";
import { EventAttestationQueue } from "../../../../../src/services/attestation/event/queue";

const allocator = "0x0000000000000000000000000000000000000001";
const oracleSigner = "0x0000000000000000000000000000000000000002";
const withdrawRequestHash = `0x${"11".repeat(32)}` as Hex;
const hashToSign = `0x${"aa".repeat(32)}` as Hex;

const payloadBuiltLog = (
  removed = false,
  payload: Hex = "0x01",
  hashesToSign: Hex[] = [hashToSign],
): EventLog => ({
  address: allocator,
  blockNumber: "0x1",
  transactionHash: `0x${"22".repeat(32)}`,
  logIndex: "0x0",
  removed,
  topics: encodeEventTopics({
    abi: RelayAllocator,
    eventName: "PayloadBuilt",
    args: { withdrawRequestHash },
  }) as [Hex, ...Hex[]],
  data: encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes32[]" }],
    [payload, hashesToSign],
  ),
});

const createHarness = async () => {
  let onLog: ((log: EventLog) => void) | undefined;
  const connection: EventConnection = {
    getChainId: async () => 1,
    close: async () => undefined,
    subscribeLogs: async (subscription) => {
      onLog = subscription.onLog;
      return () => undefined;
    },
  };
  const sign = jest.fn(async () => ({
    oracleSigner,
    signature: "0x01" as Hex,
  }));
  const cache = new WithdrawRequestCache({
    ttlMs: 1000,
    maxCount: 10,
    cleanupIntervalMs: false,
    sign,
  });
  const queue = new EventAttestationQueue({
    concurrency: 1,
    maxPending: 10,
    maxAgeMs: 1000,
    onError: (error) => {
      throw error;
    },
    onDrop: () => undefined,
  });

  await subscribeAllocatorPayloadBuilt({
    allocatorAddress: allocator,
    chainId: 1,
    connection,
    queue,
    cache,
    onConnectionError: () => undefined,
  });

  return {
    cache,
    emit: (log: EventLog) => onLog?.(log),
    queue,
    sign,
  };
};

const drainQueue = () => new Promise<void>(setImmediate);

describe("RelayAllocator PayloadBuilt event attestation", () => {
  it("caches and deduplicates a live event for the matching withdrawal request", async () => {
    const { cache, emit, queue, sign } = await createHarness();

    emit(payloadBuiltLog());
    await drainQueue();
    emit(payloadBuiltLog());
    await drainQueue();
    const fetchAttestation = jest.fn(async () => {
      throw new Error("HTTP fallback should not run");
    });
    const result = await cache.resolve({
      context: { chainId: 1, allocator, withdrawRequestHash },
      hashIndexes: [0],
      fetchAttestation,
    });

    expect(result.hashesToSign).toEqual([hashToSign]);
    expect(fetchAttestation).not.toHaveBeenCalled();
    expect(sign).toHaveBeenCalledTimes(1);
    queue.stop();
  });

  it("evicts cached attestations when the event is removed", async () => {
    const { cache, emit, queue } = await createHarness();
    emit(payloadBuiltLog());
    await drainQueue();

    emit(payloadBuiltLog(true));
    const fetchAttestation = jest.fn(async () => ({
      chainId: 1,
      allocator,
      withdrawRequestHash,
      hashesToSign: [hashToSign],
    }));
    await cache.resolve({
      context: { chainId: 1, allocator, withdrawRequestHash },
      hashIndexes: [0],
      fetchAttestation,
    });

    expect(fetchAttestation).toHaveBeenCalledTimes(1);
    queue.stop();
  });

  it.each([
    ["an empty payload", payloadBuiltLog(false, "0x")],
    [
      "too many hashes",
      payloadBuiltLog(false, "0x01", Array(257).fill(hashToSign)),
    ],
  ])("ignores an event with %s", async (_description, log) => {
    const { emit, queue, sign } = await createHarness();

    emit(log);

    expect(sign).not.toHaveBeenCalled();
    queue.stop();
  });
});
