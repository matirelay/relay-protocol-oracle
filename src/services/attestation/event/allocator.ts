import { RelayAllocator } from "@relay-protocol/settlement-abis";
import {
  decodeEventLog,
  encodeEventTopics,
  Hex,
  isAddressEqual,
  zeroHash,
} from "viem";

import { logger } from "../../../common/logger";
import {
  MAX_HASH_INDEXES,
  WithdrawRequestCache,
  WithdrawRequestEventProvenance,
} from "../cache/withdraw-request";
import { EventConnection, EventLog } from "./connection";
import { EventAttestationQueue } from "./queue";

type Options = {
  allocatorAddress: `0x${string}`;
  chainId: number;
  connection: EventConnection;
  queue: EventAttestationQueue;
  cache: WithdrawRequestCache;
  onConnectionError: (error: unknown) => void;
};

type PayloadBuiltEvent = {
  withdrawRequestHash: Hex;
  payload: Hex;
  hashesToSign: readonly Hex[];
};

const COMPONENT = "allocator-event-attestation";
const PAYLOAD_BUILT_TOPICS = encodeEventTopics({
  abi: RelayAllocator,
  eventName: "PayloadBuilt",
}) as [Hex, ...Hex[]];

const eventLocation = (log: EventLog, withdrawRequestHash?: string) => ({
  withdrawRequestHash,
  transactionHash: log.transactionHash,
  blockNumber: log.blockNumber,
  logIndex: log.logIndex,
});

const eventProvenance = (log: EventLog): WithdrawRequestEventProvenance => ({
  transactionHash: log.transactionHash,
  blockNumber: log.blockNumber,
  logIndex: log.logIndex,
});

const decodePayloadBuilt = (log: EventLog): PayloadBuiltEvent => {
  const decoded = decodeEventLog({
    abi: RelayAllocator,
    eventName: "PayloadBuilt",
    data: log.data,
    topics: log.topics,
    strict: true,
  });
  return decoded.args as unknown as PayloadBuiltEvent;
};

const validatePayloadBuilt = ({
  withdrawRequestHash,
  payload,
  hashesToSign,
}: PayloadBuiltEvent): void => {
  if (withdrawRequestHash.toLowerCase() === zeroHash) {
    throw new Error("PayloadBuilt withdrawal request hash is zero");
  }
  if (payload === "0x") {
    throw new Error("PayloadBuilt payload is empty");
  }
  if (
    hashesToSign.length === 0 ||
    hashesToSign.length > MAX_HASH_INDEXES ||
    hashesToSign.some((hash) => hash.toLowerCase() === zeroHash)
  ) {
    throw new Error(
      `PayloadBuilt hashesToSign must contain between 1 and ${MAX_HASH_INDEXES} non-zero hashes`,
    );
  }
};

export const subscribeAllocatorPayloadBuilt = async ({
  allocatorAddress,
  chainId,
  connection,
  queue,
  cache,
  onConnectionError,
}: Options): Promise<() => void> => {
  return connection.subscribeLogs({
    address: allocatorAddress,
    topics: PAYLOAD_BUILT_TOPICS,
    onError: onConnectionError,
    onLog: (log) => {
      const receivedAt = Date.now();
      let event: PayloadBuiltEvent;
      try {
        if (!isAddressEqual(log.address as `0x${string}`, allocatorAddress)) {
          throw new Error("PayloadBuilt log came from an unexpected address");
        }
        event = decodePayloadBuilt(log);
        validatePayloadBuilt(event);
      } catch (error) {
        logger.warn(
          COMPONENT,
          JSON.stringify({
            msg: "Ignoring invalid PayloadBuilt event",
            error: String(error),
            ...eventLocation(log),
          }),
        );
        return;
      }

      const withdrawRequestHash = event.withdrawRequestHash.toLowerCase();
      const hashesToSign = event.hashesToSign.map((hash) =>
        hash.toLowerCase(),
      );
      const attestation = {
        chainId,
        allocator: allocatorAddress,
        withdrawRequestHash,
        hashesToSign,
      };
      const indexes = hashesToSign.map((_, index) => index);
      const provenance = eventProvenance(log);
      const location = eventLocation(log, withdrawRequestHash);
      if (log.removed) {
        const evictedCount = cache.invalidateEvent(
          attestation,
          indexes,
          provenance,
        );
        logger.warn(
          COMPONENT,
          JSON.stringify({
            msg: "Evicted withdrawal attestations for removed PayloadBuilt event",
            evictedCount,
            ...location,
          }),
        );
        return;
      }

      const observation = cache.beginObservation(
        attestation,
        indexes,
        provenance,
      );
      const hashCount = hashesToSign.length;
      queue.enqueue({
        run: async () => {
          const startedAt = Date.now();
          const queueWaitMs = startedAt - receivedAt;
          try {
            const stored = await cache.signObservation(observation);
            if (
              !stored ||
              stored.hashesToSign.length !== hashesToSign.length ||
              stored.hashesToSign.some(
                (hash, index) => hash.toLowerCase() !== hashesToSign[index],
              )
            ) {
              return;
            }
            const completedAt = Date.now();
            logger.debug(
              COMPONENT,
              JSON.stringify({
                msg: "Cached PayloadBuilt withdrawal attestation",
                latencyMs: completedAt - receivedAt,
                queueWaitMs,
                processingLatencyMs: completedAt - startedAt,
                hashCount,
                ...location,
              }),
            );
          } catch (error) {
            logger.error(
              COMPONENT,
              JSON.stringify({
                msg: "Failed to attest PayloadBuilt event",
                error: String(error),
                latencyMs: Date.now() - receivedAt,
                queueWaitMs,
                ...location,
              }),
            );
          }
        },
        onDrop: () => cache.discardObservation(observation),
      });
    },
  });
};
