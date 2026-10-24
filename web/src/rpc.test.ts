import { describe, expect, it } from "vitest";
import { Latest } from "./rpc";

/** A promise plus the handles to settle it from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Latest", () => {
  it("runs a job immediately when idle", async () => {
    const latest = new Latest<string>();
    await expect(latest.run(async () => "done")).resolves.toBe("done");
  });

  it("drops superseded jobs instead of queueing a backlog", async () => {
    const latest = new Latest<string>();
    const first = deferred<string>();
    const started: string[] = [];

    const a = latest.run(() => {
      started.push("a");
      return first.promise;
    });
    // Both queue behind `a`; `c` supersedes `b`, which must never start.
    const b = latest.run(async () => {
      started.push("b");
      return "b";
    });
    const c = latest.run(async () => {
      started.push("c");
      return "c";
    });

    first.resolve("a");
    await expect(a).resolves.toBe("a");
    // The waiter for the superseded job rides along with the newer one, which
    // is the result it actually wanted.
    await expect(b).resolves.toBe("c");
    await expect(c).resolves.toBe("c");
    expect(started).toEqual(["a", "c"]);
  });

  it("keeps running later jobs after one fails", async () => {
    const latest = new Latest<string>();
    const failing = latest.run(async () => {
      throw new Error("boom");
    });
    const next = latest.run(async () => "recovered");

    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("recovered");
  });

  it("propagates a failure to every waiter of the superseding job", async () => {
    const latest = new Latest<string>();
    const first = deferred<string>();
    const running = latest.run(() => first.promise);
    const superseded = latest.run(async () => "never");
    const winner = latest.run(async () => {
      throw new Error("late failure");
    });

    first.resolve("ok");
    await expect(running).resolves.toBe("ok");
    await expect(superseded).rejects.toThrow("late failure");
    await expect(winner).rejects.toThrow("late failure");
  });

  it("accepts a new job once the queue has drained", async () => {
    const latest = new Latest<number>();
    await latest.run(async () => 1);
    await expect(latest.run(async () => 2)).resolves.toBe(2);
  });
});
