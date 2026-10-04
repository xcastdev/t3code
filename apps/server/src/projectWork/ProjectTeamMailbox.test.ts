import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

import {
  makeProjectTeamMailbox,
  ProjectTeamMailboxError,
  type ProjectTeamMailboxInspection,
  type ProjectTeamMailboxPorts,
} from "./ProjectTeamMailbox.ts";

type Claim = { readonly deliveryId: string; readonly operationId: string; readonly fence: number };
type Receipt = { readonly operationId: string; readonly nativeConsumed: true };
class PortError {
  readonly _tag = "PortError";
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

// These ports are a controlled durable-state oracle, not actual SQL, native consumption,
// model accounting, current authorization, or evidence for the complete P9/V9 gate.
const fixture = (ids: readonly string[] = ["a"]) => {
  const rows = new Map<string, ProjectTeamMailboxInspection<Receipt>>(
    ids.map((id) => [id, { _tag: "Pending" }]),
  );
  const owners = new Set<string>();
  const registered = new WeakSet<Claim>();
  const receipts = new WeakSet<Receipt>();
  const consumed = new Map<string, number>();
  const committed = new Set<string>();
  const commits: Receipt[] = [];
  const recorded: { readonly claim: Claim; readonly cause: Cause.Cause<PortError> }[] = [];
  const reads: { readonly afterDeliveryId?: string; readonly limit: number }[] = [];
  let fence = 0;
  const requireClaim = (claim: Claim) =>
    Effect.gen(function* () {
      if (!registered.has(claim) || !owners.has(claim.deliveryId))
        return yield* Effect.fail(new PortError("claim is not owned"));
    });
  const observe = (claim: Claim) => {
    const receipt: Receipt = { operationId: claim.operationId, nativeConsumed: true };
    receipts.add(receipt);
    rows.set(claim.deliveryId, { _tag: "Consumed", receipt });
    return receipt;
  };
  const ports: {
    -readonly [
      K in keyof ProjectTeamMailboxPorts<Claim, Receipt, PortError>
    ]: ProjectTeamMailboxPorts<Claim, Receipt, PortError>[K];
  } = {
    readPage: (input) =>
      Effect.sync(() => {
        reads.push(input);
        return [...rows.keys()]
          .sort()
          .filter((id) => input.afterDeliveryId === undefined || id > input.afterDeliveryId)
          .slice(0, input.limit);
      }),
    withClaim: <A, E, R>(id: string, run: (claim: Claim) => Effect.Effect<A, E, R>) =>
      Effect.suspend((): Effect.Effect<A | { readonly _tag: "Busy" }, E, R> => {
        if (owners.has(id)) return Effect.succeed({ _tag: "Busy" as const });
        return Effect.acquireUseRelease(
          Effect.sync(() => {
            const claim: Claim = { deliveryId: id, operationId: `original:${id}`, fence: ++fence };
            owners.add(id);
            registered.add(claim);
            return claim;
          }),
          run,
          (claim) =>
            Effect.sync(() => {
              owners.delete(id);
              registered.delete(claim);
            }),
        );
      }),
    inspect: (claim) =>
      requireClaim(claim).pipe(
        Effect.map(() => rows.get(claim.deliveryId) ?? { _tag: "Unavailable" as const }),
      ),
    consume: (claim) =>
      requireClaim(claim).pipe(
        Effect.map(() => {
          consumed.set(claim.operationId, (consumed.get(claim.operationId) ?? 0) + 1);
          return { _tag: "Consumed" as const, receipt: observe(claim) };
        }),
      ),
    commitConsumed: (claim, receipt) =>
      requireClaim(claim).pipe(
        Effect.andThen(() => {
          if (!receipts.has(receipt) || receipt.operationId !== claim.operationId)
            return Effect.fail(new PortError("receipt does not prove this original operation"));
          commits.push(receipt);
          committed.add(claim.deliveryId);
          return Effect.void;
        }),
      ),
    recordUncertain: (claim, cause) =>
      requireClaim(claim).pipe(
        Effect.map(() => {
          recorded.push({ claim, cause });
          if (rows.get(claim.deliveryId)?._tag !== "Consumed")
            rows.set(claim.deliveryId, { _tag: "Uncertain" });
        }),
      ),
  };
  return { ports, rows, owners, consumed, committed, commits, recorded, reads, observe };
};

const failures = <E>(exit: Exit.Exit<unknown, E>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) throw new Error("Expected a failing mailbox sweep");
  return exit.cause;
};
const errors = <E>(cause: Cause.Cause<E>) =>
  cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);

describe("ProjectTeamMailbox bounded discovery", () => {
  for (const [name, page, pageSize] of [
    ["duplicate IDs", ["a", "a"], 2],
    ["nonmonotonic IDs", ["b", "a"], 2],
    ["oversized page", ["a", "b"], 1],
    ["empty ID", ["a", ""], 2],
    ["normalized identity", ["a", " b"], 2],
    ["oversized ID", ["a", "b".repeat(257)], 2],
  ] as const) {
    it.effect(`rejects ${name} before any delivery is consumed`, () =>
      Effect.gen(function* () {
        const h = fixture(["a", "b"]);
        const mailbox = makeProjectTeamMailbox(
          { ...h.ports, readPage: () => Effect.succeed(page) },
          { pageSize },
        );
        const cause = failures(yield* mailbox.sweep().pipe(Effect.exit));
        expect(errors(cause)[0]).toBeInstanceOf(ProjectTeamMailboxError);
        expect(h.consumed.size).toBe(0);
        expect(h.committed.size).toBe(0);
        expect(h.owners.size).toBe(0);
      }),
    );
  }

  for (const pageSize of [0, 129, 1.5, Number.NaN]) {
    it.effect(`rejects invalid page size ${pageSize} before reading`, () =>
      Effect.gen(function* () {
        const h = fixture();
        const cause = failures(
          yield* makeProjectTeamMailbox(h.ports, { pageSize }).sweep().pipe(Effect.exit),
        );
        expect(Cause.hasFails(cause)).toBe(true);
        expect(h.reads).toEqual([]);
      }),
    );
  }

  it.effect("keeps opaque original IDs without treating them as filesystem paths", () =>
    Effect.gen(function* () {
      const h = fixture(["../delivery", "a\\delivery", "original:identity"]);
      yield* makeProjectTeamMailbox(h.ports).sweep();
      expect([...h.consumed.keys()]).toEqual([
        "original:../delivery",
        "original:a\\delivery",
        "original:original:identity",
      ]);
      expect(h.committed.size).toBe(3);
    }),
  );

  it.effect("rejects a page behind the cursor and leaves the valid continuation intact", () =>
    Effect.gen(function* () {
      const h = fixture(["a", "b"]);
      const read = h.ports.readPage;
      let stale = false;
      h.ports.readPage = (input) => (stale ? Effect.succeed(["a"]) : read(input));
      const mailbox = makeProjectTeamMailbox(h.ports, { pageSize: 1 });
      yield* mailbox.sweep();
      stale = true;
      failures(yield* mailbox.sweep().pipe(Effect.exit));
      expect(h.consumed.size).toBe(1);
      stale = false;
      yield* mailbox.sweep();
      expect([...h.committed]).toEqual(["a", "b"]);
      expect(h.reads[1]).toEqual({ afterDeliveryId: "a", limit: 1 });
    }),
  );

  it.effect(
    "visits later healthy rows and eventually revisits deferred rows in fixed small pages",
    () =>
      Effect.gen(function* () {
        const h = fixture(["a", "b", "c", "d"]);
        h.rows.set("a", { _tag: "Uncertain" });
        h.rows.set("b", { _tag: "Unavailable" });
        h.owners.add("c");
        const mailbox = makeProjectTeamMailbox(h.ports, { pageSize: 2 });
        expect((yield* mailbox.sweep()).outcomes.map((row) => row.status)).toEqual([
          "Uncertain",
          "Unavailable",
        ]);
        expect((yield* mailbox.sweep()).outcomes.map((row) => row.status)).toEqual([
          "Busy",
          "Committed",
        ]);
        expect([...h.committed]).toEqual(["d"]);
        expect((yield* mailbox.sweep()).outcomes).toEqual([]);
        h.rows.set("b", { _tag: "Pending" });
        h.owners.delete("c");
        yield* mailbox.sweep();
        yield* mailbox.sweep();
        expect([...h.committed]).toEqual(["d", "b", "c"]);
        expect(h.consumed.get("original:d")).toBe(1);
        expect(h.consumed.has("original:a")).toBe(false);
        expect(h.reads.map((read) => read.afterDeliveryId)).toEqual([
          undefined,
          "b",
          "d",
          undefined,
          "b",
        ]);
      }),
  );

  it.effect(
    "a failed first row does not starve later delivery and is revisited after end-wrap",
    () =>
      Effect.gen(function* () {
        const h = fixture(["a", "b", "c"]);
        const inspect = h.ports.inspect;
        h.ports.inspect = (claim) =>
          claim.deliveryId === "a"
            ? Effect.fail(new PortError("Root denied stale target"))
            : inspect(claim);
        const mailbox = makeProjectTeamMailbox(h.ports, { pageSize: 1 });
        failures(yield* mailbox.sweep().pipe(Effect.exit));
        yield* mailbox.sweep();
        yield* mailbox.sweep();
        yield* mailbox.sweep();
        failures(yield* mailbox.sweep().pipe(Effect.exit));
        expect([...h.committed]).toEqual(["b", "c"]);
        expect(h.reads.map((read) => read.afterDeliveryId)).toEqual([
          undefined,
          "a",
          "b",
          "c",
          undefined,
        ]);
        expect(h.consumed.has("original:a")).toBe(false);
      }),
  );

  it.effect(
    "uses the validated page snapshot when the producer's array changes during consumption",
    () =>
      Effect.gen(function* () {
        const h = fixture(["a", "b", "unauthorized"]);
        const page = ["a", "b"];
        const consume = h.ports.consume;
        h.ports.readPage = () => Effect.succeed(page);
        h.ports.consume = (claim) =>
          Effect.sync(() => {
            page[1] = "unauthorized";
          }).pipe(Effect.andThen(consume(claim)));
        yield* makeProjectTeamMailbox(h.ports).sweep();
        expect([...h.committed]).toEqual(["a", "b"]);
        expect(h.consumed.has("original:unauthorized")).toBe(false);
      }),
  );

  it.effect("a failed page read retains the exact continuation without skipping delivery", () =>
    Effect.gen(function* () {
      const h = fixture(["a", "b"]);
      const mailbox = makeProjectTeamMailbox(h.ports, { pageSize: 1 });
      yield* mailbox.sweep();
      const read = h.ports.readPage;
      h.ports.readPage = () => Effect.fail(new PortError("read failed"));
      failures(yield* mailbox.sweep().pipe(Effect.exit));
      h.ports.readPage = read;
      yield* mailbox.sweep();
      expect(h.reads[1]).toEqual({ afterDeliveryId: "a", limit: 1 });
      expect([...h.committed]).toEqual(["a", "b"]);
      expect([...h.consumed.values()]).toEqual([1, 1]);
    }),
  );
});

describe("ProjectTeamMailbox consumption and reconciliation", () => {
  for (const committedBeforeFailure of [false, true]) {
    it.effect(
      `retries only the actual consumed receipt after ${committedBeforeFailure ? "lost commit response" : "SQL commit failure"}`,
      () =>
        Effect.gen(function* () {
          const h = fixture();
          const commit = h.ports.commitConsumed;
          let failed = false;
          let original: Receipt | undefined;
          h.ports.commitConsumed = (claim, receipt) =>
            Effect.gen(function* () {
              original ??= receipt;
              if (!failed) {
                failed = true;
                if (committedBeforeFailure) yield* commit(claim, receipt);
                return yield* Effect.fail(new PortError("lost SQL response"));
              }
              expect(receipt).toBe(original);
              yield* commit(claim, receipt);
            });
          const first = makeProjectTeamMailbox(h.ports);
          const cause = failures(yield* first.sweep().pipe(Effect.exit));
          expect(errors(h.recorded[0]!.cause)).toEqual(errors(cause));
          expect(h.rows.get("a")?._tag).toBe("Consumed");
          // A new consumer simulates process restart, with only Root's durable oracle retained.
          yield* makeProjectTeamMailbox(h.ports).sweep();
          yield* first.sweep();
          yield* first.sweep();
          expect(h.consumed.get("original:a")).toBe(1);
          expect(h.committed.size).toBe(1);
          expect(h.commits.every((receipt) => receipt === original)).toBe(true);
          expect(h.recorded[0]?.claim.operationId).toBe(original?.operationId);
          expect(h.owners.size).toBe(0);
        }),
    );
  }

  it.effect("historical uncertain delivery never starts another native operation", () =>
    Effect.gen(function* () {
      const h = fixture();
      const initialCause = Cause.fail(new PortError("native consumption is uncertain"));
      h.ports.consume = (claim) =>
        Effect.sync(() => {
          h.consumed.set(claim.operationId, 1);
          return { _tag: "Uncertain" as const, cause: initialCause };
        });
      const mailbox = makeProjectTeamMailbox(h.ports);
      const cause = failures(yield* mailbox.sweep().pipe(Effect.exit));
      expect(errors(cause)[0]).toBe(errors(initialCause)[0]);
      yield* mailbox.sweep();
      const revisit = yield* mailbox.sweep();
      yield* makeProjectTeamMailbox(h.ports).sweep();
      expect(revisit.outcomes).toEqual([{ deliveryId: "a", status: "Uncertain" }]);
      expect(h.consumed.get("original:a")).toBe(1);
      expect(h.committed.size).toBe(0);
      expect(h.recorded).toHaveLength(1);
    }),
  );

  for (const reason of [
    "sender canceled",
    "recipient replaced",
    "gate revoked",
    "budget exhausted",
  ]) {
    it.effect(`Root denial of ${reason} starts zero consumption`, () =>
      Effect.gen(function* () {
        const h = fixture();
        h.ports.inspect = () => Effect.fail(new PortError(reason));
        const cause = failures(yield* makeProjectTeamMailbox(h.ports).sweep().pipe(Effect.exit));
        expect(Cause.hasFails(cause)).toBe(true);
        expect(h.consumed.size).toBe(0);
        expect(h.recorded).toEqual([]);
        expect(h.owners.size).toBe(0);
      }),
    );
  }

  for (const mode of ["typed", "defect"] as const) {
    it.effect(`retains equal ${mode} failures from native entry and uncertainty persistence`, () =>
      Effect.gen(function* () {
        const h = fixture();
        const error = new PortError("both operations failed with this same error");
        const failed = mode === "typed" ? Cause.fail(error) : Cause.die(error);
        h.ports.consume = (claim) =>
          Effect.sync(() => h.consumed.set(claim.operationId, 1)).pipe(
            Effect.andThen(Effect.failCause(failed)),
          );
        const record = h.ports.recordUncertain;
        h.ports.recordUncertain = (claim, cause) =>
          record(claim, cause).pipe(Effect.andThen(Effect.failCause(failed)));
        const cause = failures(yield* makeProjectTeamMailbox(h.ports).sweep().pipe(Effect.exit));
        expect(cause.reasons).toHaveLength(2);
        for (const reason of cause.reasons) {
          expect(reason._tag).toBe(failed.reasons[0]?._tag);
          if (Cause.isFailReason(reason)) expect(reason.error).toBe(error);
          if (Cause.isDieReason(reason)) expect(reason.defect).toBe(error);
        }
        expect(h.recorded[0]?.cause.reasons).toHaveLength(1);
        expect(h.consumed.get("original:a")).toBe(1);
        expect(h.rows.get("a")?._tag).toBe("Uncertain");
        expect(h.owners.size).toBe(0);
      }),
    );
  }

  it.effect("retains repeated annotated reasons in native then persistence occurrence order", () =>
    Effect.gen(function* () {
      const h = fixture();
      const native = Cause.makeFailReason(new PortError("native failure")).annotate(
        Context.make(Context.Service<object>("t3/projectWork/ProjectTeamMailbox.test/Native"), {
          operationId: "original:a",
        }),
      );
      const defect = Cause.makeDieReason(new PortError("native defect")).annotate(
        Context.make(Context.Service<object>("t3/projectWork/ProjectTeamMailbox.test/Defect"), {
          originalTarget: "a",
        }),
      );
      const persistence = Cause.makeFailReason(new PortError("persistence failure")).annotate(
        Context.make(
          Context.Service<object>("t3/projectWork/ProjectTeamMailbox.test/Persistence"),
          {
            retainedOperationId: "original:a",
          },
        ),
      );
      const nativeReasons = [native, defect, native];
      const persistenceReasons = [defect, native, persistence];
      h.ports.consume = (claim) =>
        Effect.sync(() => h.consumed.set(claim.operationId, 1)).pipe(
          Effect.andThen(Effect.failCause(Cause.fromReasons(nativeReasons))),
        );
      const record = h.ports.recordUncertain;
      h.ports.recordUncertain = (claim, cause) =>
        record(claim, cause).pipe(
          Effect.andThen(Effect.failCause(Cause.fromReasons(persistenceReasons))),
        );
      const cause = failures(yield* makeProjectTeamMailbox(h.ports).sweep().pipe(Effect.exit));
      const expected = [...nativeReasons, ...persistenceReasons];
      expect(cause.reasons).toHaveLength(expected.length);
      for (const [index, reason] of expected.entries()) {
        // Effect adds tracing annotations; the original error and annotation values stay intact.
        expect(cause.reasons[index]?._tag).toBe(reason._tag);
        const propagated = cause.reasons[index];
        if (propagated && Cause.isFailReason(reason) && Cause.isFailReason(propagated))
          expect(propagated.error).toBe(reason.error);
        if (propagated && Cause.isDieReason(reason) && Cause.isDieReason(propagated))
          expect(propagated.defect).toBe(reason.defect);
        for (const [key, value] of reason.annotations)
          expect(propagated?.annotations.get(key)).toBe(value);
      }
      expect(h.recorded[0]?.cause.reasons).toHaveLength(nativeReasons.length);
      for (const [index, reason] of nativeReasons.entries())
        for (const [key, value] of reason.annotations)
          expect(h.recorded[0]?.cause.reasons[index]?.annotations.get(key)).toBe(value);
      expect(h.consumed.get("original:a")).toBe(1);
      expect(h.rows.get("a")?._tag).toBe("Uncertain");
      expect(h.committed.size).toBe(0);
      expect(h.owners.size).toBe(0);
    }),
  );

  for (const mode of ["typed", "defect", "synchronous"] as const) {
    it.effect(
      `retains ${mode} native failure and failed uncertainty persistence in the Cause`,
      () =>
        Effect.gen(function* () {
          const h = fixture();
          const nativeError = new PortError("original native failure");
          const cleanupError = new PortError("uncertainty persistence failed");
          h.ports.consume = () => {
            if (mode === "synchronous") throw nativeError;
            return mode === "typed" ? Effect.fail(nativeError) : Effect.die(nativeError);
          };
          const record = h.ports.recordUncertain;
          h.ports.recordUncertain = (claim, cause) =>
            record(claim, cause).pipe(Effect.andThen(Effect.fail(cleanupError)));
          const cause = failures(yield* makeProjectTeamMailbox(h.ports).sweep().pipe(Effect.exit));
          expect(cause.reasons).toHaveLength(2);
          expect(
            cause.reasons.some((reason) => reason._tag === "Fail" && reason.error === cleanupError),
          ).toBe(true);
          expect(h.recorded[0]?.cause.reasons).toHaveLength(1);
          expect(h.rows.get("a")?._tag).toBe("Uncertain");
          expect(h.owners.size).toBe(0);
          expect(h.committed.size).toBe(0);
          expect(
            mode === "typed"
              ? Cause.hasFails(h.recorded[0]!.cause)
              : Cause.hasDies(h.recorded[0]!.cause),
          ).toBe(true);
        }),
    );
  }
});

describe("ProjectTeamMailbox owned concurrency and cancellation", () => {
  it.effect(
    "propagates native, failed uncertainty persistence and Root claim-cleanup causes together",
    () =>
      Effect.gen(function* () {
        const h = fixture();
        const native = new PortError("native failed");
        const persistence = new PortError("uncertainty persistence failed");
        const cleanup = new PortError("Root cleanup failed");
        h.ports.consume = () => Effect.fail(native);
        const record = h.ports.recordUncertain;
        h.ports.recordUncertain = (claim, cause) =>
          record(claim, cause).pipe(Effect.andThen(Effect.fail(persistence)));
        const withClaim = h.ports.withClaim;
        h.ports.withClaim = (id, run) =>
          withClaim(id, run).pipe(Effect.onExit(() => Effect.fail(cleanup)));
        const cause = failures(yield* makeProjectTeamMailbox(h.ports).sweep().pipe(Effect.exit));
        expect(errors(cause)).toEqual([native, persistence, cleanup]);
        expect(h.rows.get("a")?._tag).toBe("Uncertain");
        expect(h.consumed.size).toBe(0);
      }),
  );

  it.effect("cancellation during commit retains the consumed receipt for commit-only restart", () =>
    Effect.gen(function* () {
      const h = fixture(["a", "b", "c"]);
      const entered = yield* Deferred.make<void>();
      const commit = h.ports.commitConsumed;
      h.ports.commitConsumed = (claim, receipt) =>
        claim.deliveryId === "b"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
          : commit(claim, receipt);
      const mailbox = makeProjectTeamMailbox(h.ports, { pageSize: 3 });
      const running = yield* mailbox.sweep().pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(running);
      const cause = failures(yield* Fiber.await(running));
      expect(Cause.hasInterrupts(cause)).toBe(true);
      expect(h.recorded[0]?.claim.operationId).toBe("original:b");
      const inspected = h.rows.get("b");
      expect(inspected?._tag).toBe("Consumed");
      h.ports.commitConsumed = commit;
      yield* mailbox.sweep();
      expect(h.reads[1]).toEqual({ afterDeliveryId: "a", limit: 3 });
      expect([...h.committed]).toEqual(["a", "b", "c"]);
      expect(h.consumed.get("original:b")).toBe(1);
      if (inspected?._tag === "Consumed") expect(h.commits).toContain(inspected.receipt);
      expect(h.owners.size).toBe(0);
    }),
  );
  it.effect("serializes simultaneous local sweeps without consuming an operation twice", () =>
    Effect.gen(function* () {
      const h = fixture(["a", "b"]);
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const consume = h.ports.consume;
      h.ports.consume = (claim) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.andThen(consume(claim)),
        );
      const mailbox = makeProjectTeamMailbox(h.ports, { pageSize: 1 });
      const first = yield* mailbox.sweep().pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const secondStarted = yield* Deferred.make<void>();
      const second = yield* Deferred.succeed(secondStarted, undefined).pipe(
        Effect.andThen(mailbox.sweep()),
        Effect.forkChild,
      );
      yield* Deferred.await(secondStarted);
      expect(h.reads).toHaveLength(1);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect([...h.committed]).toEqual(["a", "b"]);
      expect([...h.consumed.values()]).toEqual([1, 1]);
      expect(h.owners.size).toBe(0);
    }),
  );

  it.effect("Root's durable Busy fence excludes a second consumer instance", () =>
    Effect.gen(function* () {
      const h = fixture();
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const consume = h.ports.consume;
      h.ports.consume = (claim) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.andThen(consume(claim)),
        );
      const first = yield* makeProjectTeamMailbox(h.ports).sweep().pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const second = makeProjectTeamMailbox(h.ports);
      expect((yield* second.sweep()).outcomes).toEqual([{ deliveryId: "a", status: "Busy" }]);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(first);
      yield* second.sweep();
      expect(h.consumed.get("original:a")).toBe(1);
      expect(h.owners.size).toBe(0);
    }),
  );

  it.effect(
    "cancellation joins masked uncertainty persistence before releasing the original claim",
    () =>
      Effect.gen(function* () {
        const h = fixture();
        const entered = yield* Deferred.make<void>();
        const recording = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        h.ports.consume = (claim) =>
          Effect.sync(() => h.consumed.set(claim.operationId, 1)).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Effect.never),
          );
        const record = h.ports.recordUncertain;
        h.ports.recordUncertain = (claim, cause) =>
          Deferred.succeed(recording, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.andThen(record(claim, cause)),
          );
        const running = yield* makeProjectTeamMailbox(h.ports).sweep().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const canceled = yield* Fiber.interrupt(running).pipe(Effect.forkChild);
        yield* Deferred.await(recording);
        expect(h.owners.has("a")).toBe(true);
        expect(h.recorded).toEqual([]);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(canceled);
        const cause = failures(yield* Fiber.await(running));
        expect(Cause.hasInterrupts(cause)).toBe(true);
        expect(Cause.hasInterrupts(h.recorded[0]!.cause)).toBe(true);
        expect(h.recorded[0]?.claim.operationId).toBe("original:a");
        expect(h.rows.get("a")?._tag).toBe("Uncertain");
        expect(h.owners.size).toBe(0);
        yield* makeProjectTeamMailbox(h.ports).sweep();
        expect(h.consumed.get("original:a")).toBe(1);
      }),
  );

  it.effect("caller cancellation before consumption does not manufacture uncertainty", () =>
    Effect.gen(function* () {
      const h = fixture();
      const inspected = yield* Deferred.make<void>();
      h.ports.inspect = () =>
        Deferred.succeed(inspected, undefined).pipe(Effect.andThen(Effect.never));
      const mailbox = makeProjectTeamMailbox(h.ports);
      const running = yield* mailbox.sweep().pipe(Effect.forkChild);
      yield* Deferred.await(inspected);
      yield* Fiber.interrupt(running);
      expect(h.recorded).toEqual([]);
      expect(h.consumed.size).toBe(0);
      expect(h.owners.size).toBe(0);
      h.ports.inspect = () => Effect.succeed({ _tag: "Pending" });
      yield* mailbox.sweep();
      expect(h.committed.size).toBe(1);
    }),
  );

  it.effect("keeps caller Scope and service dependencies until the caller closes them", () =>
    Effect.gen(function* () {
      class Dependency extends Context.Service<Dependency, { readonly marker: string }>()(
        "t3/projectWork/ProjectTeamMailbox.test/Dependency",
      ) {}
      const h = fixture();
      let closed = false;
      const ports: ProjectTeamMailboxPorts<Claim, Receipt, PortError, Scope.Scope | Dependency> = {
        ...h.ports,
        consume: (claim) =>
          Effect.gen(function* () {
            expect((yield* Dependency).marker).toBe("caller");
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed = true;
              }),
            );
            return yield* h.ports.consume(claim);
          }),
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* makeProjectTeamMailbox(ports).sweep();
          expect(closed).toBe(false);
        }).pipe(Effect.provideService(Dependency, { marker: "caller" })),
      );
      expect(closed).toBe(true);
      expect(h.committed.size).toBe(1);
    }),
  );
});
