import { describe, expect, it } from "@jest/globals";

import {
  SignerCapacityError,
  SignerLimiter,
} from "../../../../../src/services/attestation/cache/signer-limiter";

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("SignerLimiter", () => {
  it("runs work in FIFO order within the concurrency limit", async () => {
    const limiter = new SignerLimiter({ concurrency: 2, maxPending: 10 });
    const first = createDeferred();
    const second = createDeferred();
    const started: number[] = [];

    const active = [
      limiter.run(() => first.promise),
      limiter.run(() => second.promise),
    ];
    const third = limiter.run(async () => {
      started.push(3);
    });
    const fourth = limiter.run(async () => {
      started.push(4);
    });

    first.resolve();
    await third;
    expect(started).toEqual([3]);
    second.resolve();
    await Promise.all([...active, fourth]);
    expect(started).toEqual([3, 4]);
  });

  it("rejects work when pending capacity is exhausted", async () => {
    const limiter = new SignerLimiter({ concurrency: 1, maxPending: 1 });
    const active = createDeferred();
    const first = limiter.run(() => active.promise);
    const pending = limiter.run(async () => undefined);

    await expect(
      limiter.run(async () => undefined),
    ).rejects.toBeInstanceOf(SignerCapacityError);
    active.resolve();
    await Promise.all([first, pending]);
  });
});
