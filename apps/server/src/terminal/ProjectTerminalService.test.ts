import {
  applyProjectTerminalAttachEvent,
  initialProjectTerminalView,
} from "../../../../packages/client-runtime/src/projectTerminalView.ts";
import { ProjectTerminalRecord } from "./ProjectTerminalStore.ts";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  TerminalToolError,
  ThreadId,
  type ProjectTerminalAttachStreamEvent,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type { PtyExitEvent, PtyProcess, PtySpawnInput } from "@t3tools/shared/PtyAdapter";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Exit from "effect/Exit";
import { projectTerminalMigration } from "../persistence/ProjectTerminalMigration.ts";
import { makeProjectTerminalManager } from "./ProjectTerminalManager.ts";
import { makeSqlPersistence } from "./ProjectTerminalStore.ts";

class FakeProcess implements PtyProcess {
  readonly pid = 9100;
  readonly writes: string[] = [];
  readonly resizes: number[][] = [];
  kills = 0;
  uncertain = false;
  private readonly data = new Set<(data: string) => void>();
  private readonly exits = new Set<(event: PtyExitEvent) => void>();
  write(data: string) {
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows]);
  }
  kill() {
    this.kills++;
    if (this.uncertain) throw new Error("stop outcome unavailable");
  }
  onData(listener: (data: string) => void) {
    this.data.add(listener);
    return () => {
      this.data.delete(listener);
    };
  }
  onExit(listener: (event: PtyExitEvent) => void) {
    this.exits.add(listener);
    return () => {
      this.exits.delete(listener);
    };
  }
  output(text: string) {
    for (const listener of this.data) listener(text);
  }
  exit() {
    for (const listener of this.exits) listener({ exitCode: 0, signal: null });
  }
}
const decodePersistedRecord = Schema.decodeEffect(Schema.fromJsonString(ProjectTerminalRecord));
const projectId = ProjectId.make("project-owned");
const handle = { projectId, terminalId: "shared" };
const input = { ...handle, creatingThreadId: ThreadId.make("creator"), cwd: "/tmp" };
const setup = Effect.fn("projectTerminalTest.setup")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of projectTerminalMigration.statements) yield* sql.unsafe(statement);
  const persistence = yield* makeSqlPersistence();
  const testPersistence = {
    load: persistence.load,
    save: persistence.save,
    loadExits: persistence.loadExits,
    saveExit: persistence.saveExit,
    remove: persistence.remove,
  };
  const process = new FakeProcess();
  const spawns: PtySpawnInput[] = [];
  const processes: FakeProcess[] = [];
  const options = {
    ptyAdapter: {
      spawn: (input: PtySpawnInput) =>
        Effect.sync(() => {
          const child = spawns.length === 0 ? process : new FakeProcess();
          processes.push(child);
          spawns.push(input);
          return child;
        }),
    },
    persistence: testPersistence,
    shell: () => "/bin/bash",
    environment: () => Effect.succeed({}),
  };
  const manager = yield* makeProjectTerminalManager(options);
  return { manager, process, processes, spawns, options, sql };
});
const layer = Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layer({ filename: ":memory:" }));

it.effect("two attachments share one captured process; detaching does not stop it", () =>
  Effect.gen(function* () {
    const { manager, process, spawns } = yield* setup();
    const terminal = yield* manager.createProject(input);
    const first: ProjectTerminalAttachStreamEvent[] = [];
    const second: ProjectTerminalAttachStreamEvent[] = [];
    const seen = yield* Deferred.make<void>();
    const detach = yield* manager.attachProjectStream(handle, (event) =>
      Effect.sync(() => {
        first.push(event);
      }),
    );
    yield* manager.attachProjectStream(handle, (event) =>
      Effect.gen(function* () {
        second.push(event);
        if (event.type === "output") yield* Deferred.succeed(seen, undefined);
      }),
    );
    detach();
    process.output("hello shared world\n");
    yield* Deferred.await(seen);
    assert.equal(spawns.length, 1);
    assert.equal(process.kills, 0);
    assert.equal(first.length, 1);
    assert.equal(second.at(-1)?.type, "output");
    yield* manager.writeProject({
      ...handle,
      data: "input",
      expectedGeneration: terminal.generation,
    });
    yield* manager.resizeProject({
      ...handle,
      cols: 80,
      rows: 24,
      expectedGeneration: terminal.generation,
    });
    assert.deepStrictEqual(process.writes, ["input"]);
    assert.deepStrictEqual(process.resizes, [[80, 24]]);
    assert.equal(
      (yield* Effect.result(
        manager.writeProject({ ...handle, data: "bad", expectedGeneration: "stale" }),
      ))._tag,
      "Failure",
    );
    assert.equal(process.writes.length, 1);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("read cursors are reader-bound, authenticated and expire", () =>
  Effect.gen(function* () {
    const { manager, process } = yield* setup();
    yield* manager.createProject(input);
    const seen = yield* Deferred.make<void>();
    yield* manager.attachProjectStream(handle, (event) =>
      event.type === "output" ? Deferred.succeed(seen, undefined).pipe(Effect.asVoid) : Effect.void,
    );
    process.output("abcdef");
    yield* Deferred.await(seen);
    const first = yield* manager.readProject({ ...handle, readerId: "reader-one", maxBytes: 3 });
    assert.equal(first.kind, "stream");
    if (first.kind !== "stream") return;
    assert.equal(first.output, "abc");
    const other = yield* Effect.result(
      manager.readProject({ ...handle, readerId: "reader-two", cursor: first.nextCursor }),
    );
    assert.equal(other._tag, "Failure");
    const next = yield* manager.readProject({
      ...handle,
      readerId: "reader-one",
      cursor: first.nextCursor,
    });
    assert.equal(next.kind === "stream" ? next.output : "", "def");
    yield* TestClock.adjust("16 minutes");
    const expired = yield* Effect.result(
      manager.readProject({ ...handle, readerId: "reader-one", cursor: first.nextCursor }),
    );
    assert.equal(expired._tag, "Failure");
    if (expired._tag === "Failure") assert.equal(expired.failure.reason, "cursor-expired");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "restart retains project ownership and unknown status without rediscovering or killing saved PIDs",
  () =>
    Effect.gen(function* () {
      const { manager, process, options, spawns, sql } = yield* setup();
      yield* manager.createProject(input);
      const seen = yield* Deferred.make<void>();
      yield* manager.attachProjectStream(handle, (event) =>
        event.type === "output"
          ? Deferred.succeed(seen, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.output("retained output");
      yield* Deferred.await(seen);
      // Resize is serialized behind output and persists the completed history.
      yield* manager.resizeProject({ ...handle, cols: 90, rows: 25 });
      const scope = yield* Scope.make();
      const restarted = yield* makeProjectTerminalManager(options).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const terminals = yield* restarted.listProject(projectId);
      assert.equal(terminals[0]?.creatingThreadId, input.creatingThreadId);
      assert.equal(terminals[0]?.status, "unknown");
      assert.equal(spawns.length, 1);
      assert.equal(process.kills, 0);
      const rows = yield* sql`SELECT project_id FROM t3_workflow_v2_project_terminals`;
      assert.deepStrictEqual(rows, [{ project_id: projectId }]);
      const read = yield* restarted.readProject({ ...handle, readerId: "new-reader" });
      assert.equal(read.kind === "stream" ? read.output : "", "retained output");
      assert.equal((yield* restarted.killProjectTerminal(handle)).status, "unknown");
      assert.equal(process.kills, 0);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("stop uncertainty retains ownership until an observed captured-process exit", () =>
  Effect.gen(function* () {
    const { manager, process } = yield* setup();
    const terminal = yield* manager.createProject(input);
    process.uncertain = true;
    const stopped = yield* manager.killProjectTerminal({
      ...handle,
      expectedGeneration: terminal.generation,
    });
    assert.equal(stopped.status, "unknown");
    assert.equal((yield* manager.listProject(projectId))[0]?.status, "unknown");
    const exited = yield* Deferred.make<void>();
    yield* manager.subscribeProjectEvents(() =>
      Deferred.succeed(exited, undefined).pipe(Effect.asVoid),
    );
    process.exit();
    yield* Deferred.await(exited);
    assert.equal((yield* manager.listProject(projectId))[0]?.status, "exited");
    assert.equal((yield* manager.killProjectTerminal(handle)).status, "exited");
    assert.equal(process.kills, 1);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "drains several output callbacks before the captured exit and ignores late callbacks",
  () =>
    Effect.gen(function* () {
      const { manager, process } = yield* setup();
      yield* manager.createProject(input);
      const exited = yield* Deferred.make<void>();
      yield* manager.subscribeProjectEvents(() =>
        Deferred.succeed(exited, undefined).pipe(Effect.asVoid),
      );
      process.output("one ");
      process.output("two ");
      process.output("three");
      process.exit();
      process.output("late output");
      yield* Deferred.await(exited);
      const result = yield* manager.readProject({ ...handle, readerId: "reader" });
      assert.equal(result.kind === "stream" ? result.output : "", "one two three");
      assert.equal((yield* manager.listProject(projectId))[0]?.status, "exited");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "assignment cleanup matches exact captured ownership and retains all uncertain stops",
  () =>
    Effect.gen(function* () {
      const { manager, process } = yield* setup();
      const owner = {
        projectId,
        rootId: "root",
        bindingId: "binding",
        generation: 2,
        fence: 4,
        expiresAt: "2026-01-01T00:00:00.000Z",
        threadId: "creator",
        runId: "run",
        runAttemptId: "attempt",
        providerThreadId: "provider-thread",
        providerSessionId: "session",
      };
      yield* manager.createProject(input, Effect.void, owner);
      yield* manager.createProject({ ...input, terminalId: "ordinary" });
      yield* manager.closeProjectOwner({ ...owner, fence: 3 });
      assert.equal(process.kills, 0);
      process.uncertain = true;
      assert.equal((yield* Effect.result(manager.closeProjectOwner(owner)))._tag, "Failure");
      assert.equal(process.kills, 1);
      const terminals = yield* manager.listProject(projectId);
      assert.equal(
        terminals.find((terminal) => terminal.terminalId === "ordinary")?.status,
        "running",
      );
      assert.equal(
        terminals.find((terminal) => terminal.terminalId === handle.terminalId)?.status,
        "unknown",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "final project-lock guard rejects a revoked caller before native input, resize or spawn",
  () =>
    Effect.gen(function* () {
      const { manager, process, spawns } = yield* setup();
      yield* manager.createProject(input);
      const denied = Effect.fail(
        new TerminalToolError({ operation: "write", reason: "unavailable", ...handle }),
      );
      assert.equal(
        (yield* Effect.result(manager.writeProject({ ...handle, data: "denied" }, denied)))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(manager.resizeProject({ ...handle, cols: 90, rows: 20 }, denied)))
          ._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(manager.createProject({ ...input, terminalId: "denied" }, denied)))
          ._tag,
        "Failure",
      );
      assert.deepStrictEqual(process.writes, []);
      assert.deepStrictEqual(process.resizes, []);
      assert.equal(spawns.length, 1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "project deletion attempts every captured process despite an earlier uncertain stop",
  () =>
    Effect.gen(function* () {
      const { manager, processes } = yield* setup();
      yield* manager.createProject(input);
      yield* manager.createProject({ ...input, terminalId: "second" });
      processes[0]!.uncertain = true;
      assert.equal((yield* Effect.result(manager.closeProject(projectId)))._tag, "Failure");
      assert.deepStrictEqual(
        processes.map((process) => process.kills),
        [1, 1],
      );
      assert.equal(
        (yield* manager.listProject(projectId)).find(
          (terminal) => terminal.terminalId === handle.terminalId,
        )?.status,
        "unknown",
      );
      assert.equal(
        (yield* Effect.result(manager.createProject({ ...input, terminalId: "after-delete" })))
          ._tag,
        "Failure",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "bounded producer overflow reports cursor discontinuity and UTF-8 reads cannot stall",
  () =>
    Effect.gen(function* () {
      const { manager, process, processes } = yield* setup();
      yield* manager.createProject(input);
      const seeded = yield* Deferred.make<void>();
      yield* manager.attachProjectStream(handle, (event) =>
        event.type === "output"
          ? Deferred.succeed(seeded, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.output("seed");
      yield* Deferred.await(seeded);
      const before = yield* manager.readProject({ ...handle, readerId: "reader" });
      yield* manager.resizeProject(
        { ...handle, cols: 80, rows: 24 },
        Effect.sync(() => {
          for (let index = 0; index < 1025; index++) process.output("x");
        }),
      );
      const exited = yield* Deferred.make<void>();
      yield* manager.subscribeProjectEvents(() =>
        Deferred.succeed(exited, undefined).pipe(Effect.asVoid),
      );
      process.exit();
      yield* Deferred.await(exited);
      const after = yield* manager.readProject({
        ...handle,
        readerId: "reader",
        cursor: before.nextCursor,
      });
      assert.equal(after.truncated, true);
      assert.equal(after.kind === "stream" ? after.output : "", "x");
      yield* manager.createProject({ ...input, terminalId: "unicode" });
      const unicodeHandle = { ...handle, terminalId: "unicode" };
      const unicodeSeen = yield* Deferred.make<void>();
      yield* manager.attachProjectStream(unicodeHandle, (event) =>
        event.type === "output"
          ? Deferred.succeed(unicodeSeen, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      processes[1]!.output("€tail");
      yield* Deferred.await(unicodeSeen);
      const stream = yield* Effect.result(
        manager.readProject({ ...unicodeHandle, readerId: "reader", maxBytes: 1 }),
      );
      assert.equal(stream._tag, "Failure");
      const search = yield* Effect.result(
        manager.readProject({
          ...unicodeHandle,
          readerId: "reader",
          maxBytes: 1,
          search: { text: "€" },
        }),
      );
      assert.equal(search._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("read wait ends on output, exit or its bounded TestClock deadline", () =>
  Effect.gen(function* () {
    const { manager, process } = yield* setup();
    yield* manager.createProject(input);
    const waiting = yield* manager
      .readProject({ ...handle, readerId: "reader", waitMs: 30_000 })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(0);
    assert.equal(waiting.pollUnsafe() === undefined, true);
    process.output("arrived");
    const result = yield* Fiber.join(waiting);
    assert.equal(result.kind === "stream" ? result.output : "", "arrived");
    const timeout = yield* manager
      .readProject({ ...handle, readerId: "reader", cursor: result.nextCursor, waitMs: 100 })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(100);
    const timed = yield* Fiber.join(timeout);
    assert.equal(timed.kind === "stream" ? timed.output : "", "");
    const exitWait = yield* manager
      .readProject({ ...handle, readerId: "reader", cursor: result.nextCursor, waitMs: 30_000 })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(0);
    assert.equal(exitWait.pollUnsafe() === undefined, true);
    process.exit();
    const ended = yield* Fiber.join(exitWait);
    assert.equal(ended.terminal.status, "exited");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "cleanup removes history only after observed exit and retains durable completion evidence",
  () =>
    Effect.gen(function* () {
      const { manager, process, sql, options } = yield* setup();
      const terminal = yield* manager.createProject(input);
      const stopped = yield* manager.killProjectTerminal({ ...handle, cleanup: true });
      assert.equal(stopped.status, "requested");
      assert.equal((yield* manager.listProject(projectId)).length, 1);
      const closed = yield* Deferred.make<void>();
      yield* manager.attachProjectStream(handle, (event) =>
        event.type === "closed"
          ? Deferred.succeed(closed, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.exit();
      yield* Deferred.await(closed);
      assert.equal((yield* manager.listProject(projectId)).length, 0);
      assert.equal(
        (yield* Effect.result(manager.readProject({ ...handle, readerId: "reader" })))._tag,
        "Failure",
      );
      assert.deepStrictEqual(
        yield* sql`SELECT terminal_id FROM t3_workflow_v2_project_terminals`,
        [],
      );
      const restarted = yield* makeProjectTerminalManager(options);
      assert.equal((yield* restarted.listProject(projectId)).length, 0);
      assert.equal(
        (yield* restarted.listProjectCompletionSnapshots(projectId))[0]?.generation,
        terminal.generation,
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("managed mutations cannot borrow ordinary or unrelated assignment processes", () =>
  Effect.gen(function* () {
    const { manager, process, processes } = yield* setup();
    yield* manager.createProject(input);
    const owner = {
      projectId,
      rootId: "root",
      bindingId: "binding",
      generation: 1,
      fence: 2,
      expiresAt: "2026-01-01T00:00:00.000Z",
      threadId: "creator",
      runId: "run",
      runAttemptId: "attempt",
      providerThreadId: "provider-thread",
      providerSessionId: "session",
    };
    const unrelated = { ...owner, bindingId: "other-binding" };
    yield* manager.createProject({ ...input, terminalId: "unrelated" }, Effect.void, unrelated);
    for (const terminalId of [handle.terminalId, "unrelated"]) {
      const target = { ...handle, terminalId };
      assert.equal(
        (yield* Effect.result(manager.writeProject({ ...target, data: "bad" }, Effect.void, owner)))
          ._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          manager.resizeProject({ ...target, cols: 80, rows: 24 }, Effect.void, owner),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(manager.killProjectTerminal(target, Effect.void, owner)))._tag,
        "Failure",
      );
    }
    assert.deepStrictEqual(process.writes, []);
    assert.deepStrictEqual(process.resizes, []);
    assert.deepStrictEqual(
      processes.map((process) => process.kills),
      [0, 0],
    );
    yield* manager.createProject({ ...input, terminalId: "owned" }, Effect.void, owner);
    yield* manager.writeProject(
      { ...handle, terminalId: "owned", data: "allowed" },
      Effect.void,
      owner,
    );
    assert.deepStrictEqual(processes[2]!.writes, ["allowed"]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "Unicode search preserves original byte ranges and returns partial pages before UTF-8 limits",
  () =>
    Effect.gen(function* () {
      const { manager, process } = yield* setup();
      yield* manager.createProject(input);
      const seen = yield* Deferred.make<void>();
      yield* manager.attachProjectStream(handle, (event) =>
        event.type === "output"
          ? Deferred.succeed(seen, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.output("İ€foo.€");
      yield* Deferred.await(seen);
      const found = yield* manager.readProject({
        ...handle,
        readerId: "reader",
        search: { text: "€", ignoreCase: true },
      });
      assert.equal(found.kind, "search");
      if (found.kind !== "search") return;
      assert.equal(found.matches[0]?.start, 2);
      assert.equal(found.matches[0]?.end, 5);
      assert.equal(found.matches[0]?.excerpt.startsWith("€"), true);
      const literal = yield* manager.readProject({
        ...handle,
        readerId: "reader",
        search: { text: "." },
      });
      assert.equal(literal.kind === "search" ? literal.matches.length : 0, 1);
      const page = yield* manager.readProject({
        ...handle,
        readerId: "reader",
        maxBytes: 4,
        search: { text: "€" },
      });
      assert.equal(page.kind, "search");
      if (page.kind !== "search") return;
      assert.equal(page.matches.length, 1);
      assert.equal(page.hasMore, true);
      const next = yield* manager.readProject({
        ...handle,
        readerId: "reader",
        cursor: page.nextCursor,
        maxBytes: 4,
        search: { text: "€" },
      });
      assert.equal(next.kind === "search" ? next.matches[0]?.start : undefined, 9);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("tail byte budgets preserve the newest output and expose truncation", () =>
  Effect.gen(function* () {
    const { manager, process } = yield* setup();
    yield* manager.createProject(input);
    const seen = yield* Deferred.make<void>();
    yield* manager.attachProjectStream(handle, (event) =>
      event.type === "output" ? Deferred.succeed(seen, undefined).pipe(Effect.asVoid) : Effect.void,
    );
    process.output("old\nLATEST-ERROR");
    yield* Deferred.await(seen);
    const tail = yield* manager.readProject({
      ...handle,
      readerId: "reader",
      tailLines: 1,
      maxBytes: 6,
    });
    assert.equal(tail.kind === "stream" ? tail.output : "", "-ERROR");
    assert.equal(tail.truncated, true);
    assert.equal(tail.hasMore, false);
    const next = yield* manager.readProject({
      ...handle,
      readerId: "reader",
      cursor: tail.nextCursor,
    });
    assert.equal(next.kind === "stream" ? next.output : "", "");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "an insufficient remaining UTF-8 search budget returns its collected match and continuation",
  () =>
    Effect.gen(function* () {
      const { manager, process } = yield* setup();
      yield* manager.createProject(input);
      const seen = yield* Deferred.make<void>();
      yield* manager.attachProjectStream(handle, (event) =>
        event.type === "output"
          ? Deferred.succeed(seen, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.output("€€");
      yield* Deferred.await(seen);
      const first = yield* manager.readProject({
        ...handle,
        readerId: "reader",
        maxBytes: 4,
        search: { text: "€" },
      });
      assert.equal(first.kind, "search");
      if (first.kind !== "search") return;
      assert.equal(first.matches.length, 1);
      assert.equal(first.matches[0]?.start, 0);
      assert.equal(first.hasMore, true);
      const next = yield* manager.readProject({
        ...handle,
        readerId: "reader",
        cursor: first.nextCursor,
        maxBytes: 4,
        search: { text: "€" },
      });
      assert.equal(next.kind === "search" ? next.matches[0]?.start : undefined, 3);
      assert.equal(next.hasMore, false);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each([
  { kind: "ASCII", data: "x".repeat(70_000) },
  { kind: "UTF-8", data: "€".repeat(24_000) },
])(
  "large $kind output fragments reach the shared reducer exactly once and preserve durable exit state",
  ({ data }) =>
    Effect.gen(function* () {
      const { manager, process, spawns, sql, options } = yield* setup();
      const terminal = yield* manager.createProject(input);
      const seeded = yield* Deferred.make<void>();
      const stopSeed = yield* manager.attachProjectStream(handle, (event) =>
        event.type === "output"
          ? Deferred.succeed(seeded, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.output("base");
      yield* Deferred.await(seeded);
      stopSeed();
      let state = initialProjectTerminalView(handle);
      const emitted: ProjectTerminalAttachStreamEvent[] = [];
      const exited = yield* Deferred.make<void>();
      yield* manager.attachProjectStream(handle, (event) =>
        Effect.gen(function* () {
          emitted.push(event);
          state = applyProjectTerminalAttachEvent(state, event);
          if (event.type === "exited") yield* Deferred.succeed(exited, undefined);
        }),
      );
      process.output(data);
      process.exit();
      yield* Deferred.await(exited);
      assert.equal(state.history.length, 4 + data.length);
      assert.equal(state.history, "base" + data);
      assert.equal(state.phase, "exited");
      const fragments = emitted.filter((event) => event.type === "output");
      assert.equal(fragments.length, 2);
      assert.equal(fragments.map((event) => event.data).join(""), data);
      for (const event of fragments) assert.isAtMost(Buffer.byteLength(event.data), 65_536);
      const sequenced = emitted.map((event) =>
        event.type === "snapshot" ? event.snapshot.sequence : event.sequence,
      );
      assert.equal(new Set(sequenced).size, sequenced.length);
      for (let index = 1; index < sequenced.length; index++)
        assert.isAbove(sequenced[index]!, sequenced[index - 1]!);
      const beforeReplay = state;
      for (const event of fragments)
        assert.equal(applyProjectTerminalAttachEvent(state, event), beforeReplay);
      const persisted = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM t3_workflow_v2_project_terminals WHERE project_id=${projectId} AND terminal_id=${handle.terminalId}`;
      const record = yield* decodePersistedRecord(persisted[0]!.payload_json);
      assert.equal(record.sequence, state.sequence);
      assert.equal(record.history, state.history);
      assert.equal(record.terminal.status, "exited");
      const tombstones = yield* manager.listProjectCompletionSnapshots(projectId);
      assert.equal(tombstones[0]?.generation, terminal.generation);
      assert.equal(tombstones[0]?.updatedAt, record.terminal.updatedAt);
      assert.equal(tombstones[0]?.status, "exited");
      const restarted = yield* makeProjectTerminalManager(options);
      let restored = initialProjectTerminalView(handle);
      yield* restarted.attachProjectStream(handle, (event) =>
        Effect.sync(() => {
          restored = applyProjectTerminalAttachEvent(restored, event);
        }),
      );
      assert.equal(restored.sequence, state.sequence);
      assert.equal(restored.history, state.history);
      assert.equal(restored.phase, "exited");
      assert.equal(spawns.length, 1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
