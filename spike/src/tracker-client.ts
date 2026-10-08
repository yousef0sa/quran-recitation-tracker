// Main-thread wrapper around tracker.worker.ts: posts typed messages and lets callers await
// the next message of a given type (rejecting when the worker posts an error).
import type { MainToWorker, WorkerToMain } from "./messages";

type MessageOfType<T extends WorkerToMain["type"]> = Extract<WorkerToMain, { type: T }>;

interface Waiter {
  type: WorkerToMain["type"];
  resolve(message: never): void;
  reject(error: Error): void;
}

export class TrackerClient {
  private readonly worker: Worker;
  private waiters: Waiter[] = [];

  constructor(private readonly onMessage: (message: WorkerToMain) => void) {
    this.worker = new Worker(new URL("./tracker.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerToMain>) => this.dispatch(event.data);
    this.worker.onerror = (event) => {
      // Script-level failure (e.g. the module could not load): surface it like a load error.
      this.dispatch({ type: "error", stage: "load", message: event.message || "worker error" });
    };
  }

  private dispatch(message: WorkerToMain): void {
    // Settle the waiters first so that a throwing onMessage callback can never leave a caller hanging.
    try {
      if (message.type === "error") {
        const waiters = this.waiters;
        this.waiters = [];
        for (const waiter of waiters) waiter.reject(new Error(message.message));
      } else {
        const index = this.waiters.findIndex((waiter) => waiter.type === message.type);
        if (index >= 0) {
          const [waiter] = this.waiters.splice(index, 1);
          waiter?.resolve(message as never);
        }
      }
    } finally {
      this.onMessage(message);
    }
  }

  post(message: MainToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  /** Resolves with the next message of `type`; rejects on the next worker error. Register before posting. */
  next<T extends WorkerToMain["type"]>(type: T): Promise<MessageOfType<T>> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ type, resolve: resolve as (message: never) => void, reject });
    });
  }

  terminate(): void {
    this.worker.terminate();
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(new Error("worker terminated"));
  }
}
