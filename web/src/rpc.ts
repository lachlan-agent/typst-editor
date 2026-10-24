/**
 * A typed request/response channel to the compile worker.
 *
 * Requests are answered by id, so replies can arrive out of order. On top of
 * that, `compile` is *superseded*: while a compile is running, a newer compile
 * request replaces any queued one instead of joining a backlog. Fast typing
 * therefore produces at most one in-flight compile plus one pending compile,
 * no matter how many keystrokes land.
 */

import type { Envelope, Reply, Request, ResponseMap } from "./protocol";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class Rpc {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;

  constructor(worker: Worker) {
    this.#worker = worker;
    this.#worker.addEventListener("message", (event: MessageEvent<Reply>) => {
      const reply = event.data;
      const pending = this.#pending.get(reply.id);
      if (!pending) return;
      this.#pending.delete(reply.id);
      if (reply.ok) {
        pending.resolve(reply.value);
      } else {
        pending.reject(new Error(reply.error));
      }
    });
    this.#worker.addEventListener("error", (event) => {
      this.#failAll(new Error(event.message || "the compiler worker crashed"));
    });
  }

  send<K extends keyof ResponseMap>(
    request: Extract<Request, { kind: K }>,
  ): Promise<ResponseMap[K]> {
    const id = this.#nextId++;
    return new Promise<ResponseMap[K]>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      const envelope: Envelope = { id, request };
      this.#worker.postMessage(envelope);
    });
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

/**
 * Serializes work so that at most one job runs at a time and at most one is
 * queued. A job queued while another is pending replaces it — the newer
 * request is strictly better, since it reflects newer editor state.
 */
export class Latest<T> {
  #running: Promise<T> | null = null;
  #queued: (() => Promise<T>) | null = null;
  #queuedWaiters: Array<{
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  }> = [];

  run(job: () => Promise<T>): Promise<T> {
    if (!this.#running) {
      return this.#start(job);
    }

    // Supersede whatever was queued; its waiters ride along with the new job,
    // which is what they actually wanted.
    this.#queued = job;
    return new Promise<T>((resolve, reject) => {
      this.#queuedWaiters.push({ resolve, reject });
    });
  }

  #start(job: () => Promise<T>): Promise<T> {
    const promise = job();
    this.#running = promise;
    promise.then(
      () => this.#drain(),
      () => this.#drain(),
    );
    return promise;
  }

  #drain(): void {
    this.#running = null;
    const next = this.#queued;
    const waiters = this.#queuedWaiters;
    this.#queued = null;
    this.#queuedWaiters = [];
    if (!next) return;

    this.#start(next).then(
      (value) => waiters.forEach((w) => w.resolve(value)),
      (error) => waiters.forEach((w) => w.reject(error)),
    );
  }
}
