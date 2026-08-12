type Task = {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type Options = {
  concurrency: number;
  maxPending: number;
};

export const SIGNER_CONCURRENCY = 64;
export const SIGNER_MAX_PENDING = 10_000;

export class SignerCapacityError extends Error {
  public constructor() {
    super("Withdrawal attestation signing is temporarily at capacity");
    this.name = "SignerCapacityError";
  }
}

export class SignerLimiter {
  private readonly pending = new Map<number, Task>();
  private active = 0;
  private nextPendingId = 0;
  private nextTaskId = 0;

  public constructor(private readonly options: Options) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error("Signer concurrency must be a positive integer");
    }
    if (!Number.isInteger(options.maxPending) || options.maxPending < 1) {
      throw new Error("Signer maximum pending count must be a positive integer");
    }
  }

  public run<V>(run: () => Promise<V>): Promise<V> {
    if (
      this.active >= this.options.concurrency &&
      this.pending.size >= this.options.maxPending
    ) {
      return Promise.reject(new SignerCapacityError());
    }

    return new Promise<V>((resolve, reject) => {
      const task: Task = {
        run,
        resolve: (value) => resolve(value as V),
        reject,
      };
      if (this.active < this.options.concurrency && this.pending.size === 0) {
        this.start(task);
      } else {
        this.pending.set(this.nextTaskId, task);
        this.nextTaskId += 1;
      }
    });
  }

  private start(task: Task): void {
    this.active += 1;
    let result: Promise<unknown>;
    try {
      result = task.run();
    } catch (error) {
      this.finish();
      task.reject(error);
      return;
    }
    void result
      .then(task.resolve, task.reject)
      .finally(() => this.finish());
  }

  private finish(): void {
    this.active -= 1;
    const next = this.pending.get(this.nextPendingId);
    if (next) {
      this.pending.delete(this.nextPendingId);
      this.nextPendingId += 1;
      if (this.pending.size === 0) {
        this.nextPendingId = 0;
        this.nextTaskId = 0;
      }
      this.start(next);
    }
  }
}
