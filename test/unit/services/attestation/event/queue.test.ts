import { describe, expect, it, jest } from "@jest/globals";

import { EventAttestationQueue } from "../../../../../src/services/attestation/event/queue";

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("EventAttestationQueue", () => {
  it("bounds concurrency and drops work beyond pending capacity", async () => {
    const first = createDeferred();
    const second = createDeferred();
    const started: number[] = [];
    const onDrop = jest.fn();
    const droppedTask = jest.fn();
    const queue = new EventAttestationQueue({
      concurrency: 1,
      maxPending: 1,
      maxAgeMs: 1000,
      onError: jest.fn(),
      onDrop,
    });

    expect(
      queue.enqueue({
        run: async () => {
          started.push(1);
          await first.promise;
        },
        onDrop: jest.fn(),
      }),
    ).toBe(true);
    expect(
      queue.enqueue({
        run: async () => {
          started.push(2);
          await second.promise;
        },
        onDrop: jest.fn(),
      }),
    ).toBe(true);
    expect(
      queue.enqueue({ run: async () => undefined, onDrop: droppedTask }),
    ).toBe(false);
    expect(started).toEqual([1]);
    expect(onDrop).toHaveBeenCalledWith("capacity", {
      activeCount: 1,
      pendingCount: 1,
    });
    expect(droppedTask).toHaveBeenCalledTimes(1);

    first.resolve();
    await new Promise(setImmediate);
    expect(started).toEqual([1, 2]);

    second.resolve();
    queue.stop();
  });

  it("drops queued work that has exceeded the attestation TTL", async () => {
    let now = 0;
    const first = createDeferred();
    const expiredTask = jest.fn(async () => undefined);
    const droppedTask = jest.fn();
    const onDrop = jest.fn();
    const queue = new EventAttestationQueue({
      concurrency: 1,
      maxPending: 1,
      maxAgeMs: 100,
      now: () => now,
      onError: jest.fn(),
      onDrop,
    });

    queue.enqueue({ run: () => first.promise, onDrop: jest.fn() });
    queue.enqueue({ run: expiredTask, onDrop: droppedTask });
    now = 100;
    first.resolve();
    await new Promise(setImmediate);

    expect(expiredTask).not.toHaveBeenCalled();
    expect(droppedTask).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith("expired", {
      activeCount: 0,
      pendingCount: 0,
    });
    queue.stop();
  });

  it("invalidates active and pending work when stopped", async () => {
    const active = createDeferred();
    const activeDrop = jest.fn();
    const pendingDrop = jest.fn();
    const onDrop = jest.fn();
    const queue = new EventAttestationQueue({
      concurrency: 1,
      maxPending: 1,
      maxAgeMs: 1000,
      onError: jest.fn(),
      onDrop,
    });

    queue.enqueue({ run: () => active.promise, onDrop: activeDrop });
    queue.enqueue({ run: async () => undefined, onDrop: pendingDrop });
    queue.stop();

    expect(activeDrop).toHaveBeenCalledTimes(1);
    expect(pendingDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls.map(([reason]) => reason)).toEqual([
      "stopped",
      "stopped",
    ]);

    queue.stop();
    active.resolve();
    await new Promise(setImmediate);
    expect(activeDrop).toHaveBeenCalledTimes(1);
  });
});
