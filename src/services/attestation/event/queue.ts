type Task = {
  enqueuedAt: number;
  run: () => Promise<void>;
  onDrop: () => void;
};

type DropReason = "capacity" | "expired" | "stopped";

type QueueState = {
  activeCount: number;
  pendingCount: number;
};

type Options = {
  concurrency: number;
  maxPending: number;
  maxAgeMs: number;
  now?: () => number;
  onError: (error: unknown) => void;
  onDrop: (reason: DropReason, state: QueueState) => void;
};

export class EventAttestationQueue {
  private readonly activeTasks = new Set<Task>();
  private readonly pendingTasks = new Map<number, Task>();
  private readonly concurrency: number;
  private readonly maxPending: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;
  private readonly onDrop: Options["onDrop"];
  private nextPendingId = 0;
  private nextTaskId = 0;
  private stopped = false;

  public constructor({
    concurrency,
    maxPending,
    maxAgeMs,
    now = Date.now,
    onError,
    onDrop,
  }: Options) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Event attestation concurrency must be a positive integer");
    }
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new Error(
        "Event attestation maximum pending count must be a positive integer",
      );
    }
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      throw new Error("Event attestation maximum age must be positive");
    }

    this.concurrency = concurrency;
    this.maxPending = maxPending;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.onError = onError;
    this.onDrop = onDrop;
  }

  public enqueue(task: Omit<Task, "enqueuedAt">): boolean {
    if (this.stopped) {
      this.dropTask(task, "stopped");
      return false;
    }
    if (this.pendingTasks.size >= this.maxPending) {
      this.dropTask(task, "capacity");
      return false;
    }

    this.pendingTasks.set(this.nextTaskId, {
      enqueuedAt: this.now(),
      ...task,
    });
    this.nextTaskId += 1;
    this.drain();
    return true;
  }

  public stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const task of this.pendingTasks.values()) {
      this.dropTask(task, "stopped");
    }
    this.pendingTasks.clear();
    for (const task of this.activeTasks) {
      this.dropTask(task, "stopped");
    }
    this.nextPendingId = 0;
    this.nextTaskId = 0;
  }

  private drain(): void {
    while (
      this.activeTasks.size < this.concurrency &&
      this.pendingTasks.size > 0
    ) {
      const task = this.dequeue();
      if (!task) {
        return;
      }
      if (this.now() - task.enqueuedAt >= this.maxAgeMs) {
        this.dropTask(task, "expired");
        continue;
      }

      this.activeTasks.add(task);
      void task
        .run()
        .catch(this.onError)
        .finally(() => {
          this.activeTasks.delete(task);
          this.drain();
      });
    }
  }

  private dequeue(): Task | undefined {
    const task = this.pendingTasks.get(this.nextPendingId);
    if (task) {
      this.pendingTasks.delete(this.nextPendingId);
      this.nextPendingId += 1;
      if (this.pendingTasks.size === 0) {
        this.nextPendingId = 0;
        this.nextTaskId = 0;
      }
    }
    return task;
  }

  private dropTask(task: Pick<Task, "onDrop">, reason: DropReason): void {
    try {
      task.onDrop();
    } catch (error) {
      this.onError(error);
    }
    this.onDrop(reason, {
      activeCount: this.activeTasks.size,
      pendingCount: this.pendingTasks.size,
    });
  }
}
