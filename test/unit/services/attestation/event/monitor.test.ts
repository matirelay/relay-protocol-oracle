import { describe, expect, it, jest } from "@jest/globals";

import { logger } from "../../../../../src/common/logger";
import { EventConnection } from "../../../../../src/services/attestation/event/connection";
import { EventAttestationMonitor } from "../../../../../src/services/attestation/event";

const allocator = "0x0000000000000000000000000000000000000001";

const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached");
};

const createConnection = (chainId: number) => {
  let onError: ((error: unknown) => void) | undefined;
  const close = jest.fn(async () => undefined);
  const getChainId = jest.fn(async () => chainId);
  const unsubscribe = jest.fn();
  const connection: EventConnection = {
    getChainId,
    close,
    subscribeLogs: async (subscription) => {
      onError = subscription.onError;
      return unsubscribe;
    },
  };
  return {
    close,
    connection,
    fail: (error: unknown) => onError?.(error),
    isSubscribed: () => onError !== undefined,
    getChainId,
    unsubscribe,
  };
};

describe("EventAttestationMonitor", () => {
  it("validates the chain, reconnects after failure, and shuts down cleanly", async () => {
    const wrongChain = createConnection(2);
    const firstConnection = createConnection(1);
    const reconnected = createConnection(1);
    const connections = [wrongChain, firstConnection, reconnected];
    const connect = jest.fn(() => {
      const next = connections.shift();
      if (!next) {
        throw new Error("Unexpected connection attempt");
      }
      return next.connection;
    });
    const monitor = new EventAttestationMonitor({
      allocatorEnabled: true,
      createConnection: connect,
      resolveConfig: async () => ({
        allocatorAddress: allocator,
        chainId: 1,
        wsUrl: "wss://relay.example",
      }),
      random: () => 0,
    });

    monitor.start();
    await waitFor(firstConnection.isSubscribed);
    expect(wrongChain.close).toHaveBeenCalledTimes(1);

    firstConnection.fail(new Error("socket closed"));
    await waitFor(reconnected.isSubscribed);
    expect(firstConnection.unsubscribe).toHaveBeenCalledTimes(1);
    expect(firstConnection.close).toHaveBeenCalledTimes(1);

    await monitor.stop();
    expect(reconnected.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reconnected.close).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("reconnects when the WebSocket heartbeat fails", async () => {
    const firstConnection = createConnection(1);
    firstConnection.getChainId
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error("heartbeat failed"));
    const reconnected = createConnection(1);
    const connections = [firstConnection, reconnected];
    const monitor = new EventAttestationMonitor({
      allocatorEnabled: true,
      heartbeatIntervalMs: 1,
      createConnection: () => connections.shift()!.connection,
      resolveConfig: async () => ({
        allocatorAddress: allocator,
        chainId: 1,
        wsUrl: "wss://relay.example",
      }),
      random: () => 0,
    });

    monitor.start();
    await waitFor(reconnected.isSubscribed);
    expect(firstConnection.unsubscribe).toHaveBeenCalledTimes(1);
    expect(firstConnection.close).toHaveBeenCalledTimes(1);

    await monitor.stop();
  });

  it("can restart after shutdown", async () => {
    const firstConnection = createConnection(1);
    const secondConnection = createConnection(1);
    const connections = [firstConnection, secondConnection];
    const connect = jest.fn(() => connections.shift()!.connection);
    const monitor = new EventAttestationMonitor({
      allocatorEnabled: true,
      createConnection: connect,
      resolveConfig: async () => ({
        allocatorAddress: allocator,
        chainId: 1,
        wsUrl: "wss://relay.example",
      }),
    });

    monitor.start();
    await waitFor(firstConnection.isSubscribed);
    await monitor.stop();

    monitor.start();
    await waitFor(secondConnection.isSubscribed);
    await monitor.stop();

    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("resets reconnect backoff only after a stable subscription", async () => {
    const connections = Array.from({ length: 4 }, () => createConnection(1));
    const remaining = [...connections];
    const error = jest.spyOn(logger, "error");
    const warn = jest.spyOn(logger, "warn");
    const monitor = new EventAttestationMonitor({
      allocatorEnabled: true,
      createConnection: () => remaining.shift()!.connection,
      resolveConfig: async () => ({
        allocatorAddress: allocator,
        chainId: 1,
        wsUrl: "wss://relay.example",
      }),
      random: () => 0,
      backoffResetMs: 20,
    });

    try {
      monitor.start();
      await waitFor(connections[0].isSubscribed);
      connections[0].fail(new Error("first flap"));
      await waitFor(connections[1].isSubscribed);
      connections[1].fail(new Error("second flap"));
      await waitFor(connections[2].isSubscribed);
      await new Promise((resolve) => setTimeout(resolve, 25));
      connections[2].fail(new Error("failure after stable connection"));
      await waitFor(connections[3].isSubscribed);

      const retryAttempts = (
        calls: Array<[component: string, message: string]>,
      ) =>
        calls
          .map(([, message]) => JSON.parse(message))
          .filter(
            ({ msg }) =>
              msg === "Allocator event attestation connection failed",
          )
          .map(({ retryAttempt }) => retryAttempt);
      expect(retryAttempts(error.mock.calls)).toEqual([1, 1]);
      expect(retryAttempts(warn.mock.calls)).toEqual([2]);
    } finally {
      await monitor.stop();
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
