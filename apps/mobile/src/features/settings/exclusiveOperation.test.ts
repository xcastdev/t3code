import { describe, expect, it } from "vite-plus/test";

import { createExclusiveOperation } from "./exclusiveOperation";

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createExclusiveOperation", () => {
  it("refuses Save while a Test is in flight, so the Test's completion cannot unlock a Save", async () => {
    const changes: Array<string | null> = [];
    const operation = createExclusiveOperation((active) => changes.push(active));
    const testCall = deferred<string>();
    let saveCalls = 0;

    const test = operation.run("destination-1", () => testCall.promise);
    const refusedSave = await operation.run("save", async () => {
      saveCalls += 1;
      return "saved";
    });
    expect(refusedSave).toEqual({ started: false });
    expect(saveCalls).toBe(0);
    expect(operation.active()).toBe("destination-1");

    testCall.resolve("delivered");
    expect(await test).toEqual({ started: true, value: "delivered" });
    expect(operation.active()).toBeNull();

    const saveCall = deferred<string>();
    const save = operation.run("save", () => saveCall.promise);
    expect(operation.active()).toBe("save");
    expect(await operation.run("destination-1", async () => "delivered")).toEqual({
      started: false,
    });
    // The refused Test settled first and left Save's lock in place.
    expect(operation.active()).toBe("save");
    saveCall.resolve("saved");
    expect(await save).toEqual({ started: true, value: "saved" });
    expect(changes).toEqual(["destination-1", null, "save", null]);
  });

  it("releases the lock when the operation fails", async () => {
    const operation = createExclusiveOperation(() => undefined);
    const failing = deferred<never>();
    const run = operation.run("save", () => failing.promise);
    failing.reject(new Error("offline"));
    await expect(run).rejects.toThrow("offline");
    expect(operation.active()).toBeNull();
    expect(await operation.run("save", async () => 1)).toEqual({ started: true, value: 1 });
  });
});
