import { projectTerminalOwnerMatches } from "./ProjectTerminalStore.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Cursor MACs and process generations are synchronous at the callback boundary.
import * as NodeCrypto from "node:crypto";
import {
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  TerminalToolError,
  ProjectTerminalReadCursorClaims,
  type TerminalProviderInstanceNotFoundError,
  type TerminalProviderEnvironmentError,
  type ProjectId,
  type ProjectTerminalAttachStreamEvent,
  type ProjectTerminalCreateInput,
  type ProjectTerminalDockListInput,
  type ProjectTerminalDockSummary,
  type ProjectTerminalHandle,
  type ProjectTerminalKillInput,
  type ProjectTerminalMetadataStreamEvent,
  type ProjectTerminalResizeInput,
  type ProjectTerminalStopResult,
  type ProjectTerminalSummary,
  type ProjectTerminalWriteInput,
  type TerminalReadInput,
  type TerminalReadResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import type {
  ProjectTerminalPersistence,
  ProjectTerminalRecord,
  ProjectTerminalOwnership,
} from "./ProjectTerminalStore.ts";

const decodeCursor = Schema.decodeEffect(Schema.fromJsonString(ProjectTerminalReadCursorClaims));
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(ProjectTerminalReadCursorClaims));

export type ProjectTerminalEvent = {
  readonly type: "exited";
  readonly terminal: ProjectTerminalSummary;
};
interface Session {
  record: ProjectTerminalRecord;
  changed: Deferred.Deferred<void>;
  cleanupRequested: boolean;
  worker?: Fiber.Fiber<void, never>;
  process: PtyAdapter.PtyProcess | null;
  unsubscribe: Array<() => void>;
  listeners: Set<(event: ProjectTerminalAttachStreamEvent) => Effect.Effect<void>>;
}
const exitKey = (terminal: ProjectTerminalSummary) =>
  JSON.stringify([terminal.projectId, terminal.terminalId, terminal.generation]);
const key = (handle: ProjectTerminalHandle) =>
  JSON.stringify([handle.projectId, handle.terminalId]);
const fail = (
  operation: TerminalToolError["operation"],
  reason: TerminalToolError["reason"],
  handle: ProjectTerminalHandle,
) => new TerminalToolError({ operation, reason, ...handle });
const dock = (record: ProjectTerminalRecord): ProjectTerminalDockSummary => ({
  generation: record.terminal.generation,
  projectId: record.terminal.projectId,
  terminalId: record.terminal.terminalId,
  creatingThreadId: record.terminal.creatingThreadId,
  label: record.terminal.label,
  status: record.terminal.status,
  cols: record.cols,
  rows: record.rows,
  exitCode: record.terminal.exitCode,
  exitSignal: record.terminal.exitSignal,
  updatedAt: record.terminal.updatedAt,
});
const terminalHandle = (session: Session): ProjectTerminalHandle => ({
  projectId: session.record.terminal.projectId,
  terminalId: session.record.terminal.terminalId,
});
const boundedText = (text: string, bytes: number) => {
  const buffer = Buffer.from(text);
  if (buffer.byteLength <= bytes) return text;
  let start = buffer.byteLength - bytes;
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
};
const prefix = (text: string, bytes: number) => {
  const buffer = Buffer.from(text);
  if (buffer.byteLength <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
};

export const makeProjectTerminalManager = Effect.fn("ProjectTerminalManager.make")(
  function* (options: {
    readonly ptyAdapter: PtyAdapter.PtyAdapter["Service"];
    readonly persistence?: ProjectTerminalPersistence;
    readonly shell: () => string;
    readonly environment: (
      input: ProjectTerminalCreateInput,
    ) => Effect.Effect<
      NodeJS.ProcessEnv,
      TerminalProviderInstanceNotFoundError | TerminalProviderEnvironmentError
    >;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const agentScope = yield* AgentScope;
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);
    const sessions = new Map<string, Session>();
    const exits = new Map<string, ProjectTerminalSummary>();
    const locks = yield* KeyedLock.make<string>();
    const secret = NodeCrypto.randomUUID();
    const closingProjects = new Set<ProjectId>();
    const metadata = new Set<{
      projectId: ProjectId;
      listener: (event: ProjectTerminalMetadataStreamEvent) => Effect.Effect<void>;
    }>();
    const events = new Set<(event: ProjectTerminalEvent) => Effect.Effect<void>>();
    const persist = (session: Session) =>
      options.persistence
        ?.save(session.record)
        .pipe(Effect.mapError(() => fail("close", "cleanup-failed", terminalHandle(session)))) ??
      Effect.void;
    const publishMetadata = (session: Session) =>
      Effect.forEach(
        metadata,
        (entry) =>
          entry.projectId === session.record.terminal.projectId
            ? entry.listener({ type: "upsert", terminal: dock(session.record) })
            : Effect.void,
        { discard: true },
      );
    const publish = (session: Session, event: ProjectTerminalAttachStreamEvent) =>
      Effect.forEach(session.listeners, (listener) => listener(event), { discard: true });
    const requireSession = (
      handle: ProjectTerminalHandle,
      operation: TerminalToolError["operation"],
    ) =>
      Effect.suspend(() => {
        const session = sessions.get(key(handle));
        return session === undefined
          ? Effect.fail(fail(operation, "unavailable", handle))
          : Effect.succeed(session);
      });
    const stamp = (session: Session, now: number) => {
      session.record = {
        ...session.record,
        sequence: session.record.sequence + 1,
        terminal: {
          ...session.record.terminal,
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        },
      };
    };
    if (options.persistence) {
      const records = yield* options.persistence.load.pipe(Effect.orDie);
      for (const record of records) {
        // A saved PID is evidence, never authority to signal a process after restart.
        const active = ["running", "starting", "stopping"].includes(record.terminal.status);
        const session: Session = {
          record: active
            ? { ...record, terminal: { ...record.terminal, status: "unknown" } }
            : record,
          changed: yield* Deferred.make<void>(),
          cleanupRequested: false,
          process: null,
          unsubscribe: [],
          listeners: new Set(),
        };
        sessions.set(key(record.terminal), session);
        if (active) yield* persist(session).pipe(Effect.orDie);
      }
    }
    const removeStoppedSession = Effect.fn("ProjectTerminalManager.removeStopped")(function* (
      session: Session,
    ) {
      if (session.process || session.record.terminal.status !== "exited") return;
      const handle = terminalHandle(session);
      if (options.persistence?.remove)
        yield* options.persistence
          .remove({ ...handle, generation: session.record.terminal.generation })
          .pipe(Effect.mapError(() => fail("kill", "cleanup-failed", handle)));
      if (sessions.get(key(handle)) !== session) return;
      sessions.delete(key(handle));
      yield* publish(session, { type: "closed", handle, sequence: session.record.sequence });
      yield* Effect.forEach(
        metadata,
        (entry) =>
          entry.projectId === handle.projectId
            ? entry.listener({ type: "remove", ...handle })
            : Effect.void,
        { discard: true },
      );
    });
    if (options.persistence?.loadExits)
      for (const terminal of yield* options.persistence.loadExits.pipe(Effect.orDie))
        exits.set(exitKey(terminal), terminal);
    const listProjectCompletionSnapshots = (projectId: ProjectId) =>
      Effect.sync(() => [...exits.values()].filter((terminal) => terminal.projectId === projectId));
    const listProject = (projectId: ProjectId) =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((session) => session.record.terminal.projectId === projectId)
          .map((session) => session.record.terminal)
          .sort((a, b) => a.terminalId.localeCompare(b.terminalId)),
      );
    const listProjectDockSummaries = (input: ProjectTerminalDockListInput) =>
      Effect.sync(() => {
        const records = [...sessions.values()]
          .filter(
            (session) =>
              session.record.terminal.projectId === input.projectId &&
              (input.after === undefined || session.record.terminal.terminalId > input.after),
          )
          .sort((a, b) => a.record.terminal.terminalId.localeCompare(b.record.terminal.terminalId));
        const page = records.slice(0, input.limit ?? 100);
        return {
          terminals: page.map((session) => dock(session.record)),
          nextCursor: records.length > page.length ? page.at(-1)!.record.terminal.terminalId : null,
        };
      });
    const createProject = (
      input: ProjectTerminalCreateInput,
      guard: Effect.Effect<void, TerminalToolError> = Effect.void,
      ownership?: ProjectTerminalOwnership,
    ) =>
      locks
        .withLock(
          input.projectId,
          Effect.gen(function* () {
            if (closingProjects.has(input.projectId))
              return yield* fail("spawn", "unavailable", input);
            if (options.persistence?.assertProjectActive)
              yield* options.persistence
                .assertProjectActive(input.projectId)
                .pipe(Effect.mapError(() => fail("spawn", "unavailable", input)));
            if (sessions.has(key(input))) return yield* fail("spawn", "launch-failed", input);
            const stat = yield* fs
              .stat(input.cwd)
              .pipe(Effect.mapError(() => fail("spawn", "invalid-cwd", input)));
            if (stat.type !== "Directory") return yield* fail("spawn", "invalid-cwd", input);
            const env = yield* options
              .environment(input)
              .pipe(Effect.mapError(() => fail("spawn", "launch-failed", input)));
            const now = yield* Clock.currentTimeMillis;
            const session: Session = {
              record: {
                ...(ownership ? { ownership } : {}),
                terminal: {
                  generation: NodeCrypto.randomUUID(),
                  projectId: input.projectId,
                  terminalId: input.terminalId,
                  creatingThreadId: input.creatingThreadId,
                  title: input.title ?? null,
                  command: input.command ?? null,
                  args: input.args ?? [],
                  cwd: input.cwd,
                  label: (input.title ?? input.command ?? "Terminal").slice(0, 128),
                  status: "starting",
                  pid: null,
                  exitCode: null,
                  exitSignal: null,
                  updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
                },
                cols: input.cols ?? 120,
                rows: input.rows ?? 30,
                history: "",
                offset: 0,
                sequence: 0,
              },
              changed: yield* Deferred.make<void>(),
              cleanupRequested: false,
              process: null,
              unsubscribe: [],
              listeners: new Set(),
            };
            // Commit ownership before spawning; creator deletion cannot remove this record.
            yield* persist(session);
            sessions.set(key(input), session);
            const launch = yield* agentScope.wrap({
              command: input.command ?? options.shell(),
              args: input.args ?? [],
              name: `t3-project-terminal-${session.record.terminal.generation}`,
              survivesRestart: true,
              shared: true,
              env,
            });
            yield* guard.pipe(
              Effect.tapError(() => {
                session.record = {
                  ...session.record,
                  terminal: { ...session.record.terminal, status: "error" },
                };
                return persist(session);
              }),
            );
            const process = yield* options.ptyAdapter
              .spawn({
                shell: launch.command,
                args: [...launch.args],
                cwd: input.cwd,
                cols: session.record.cols,
                rows: session.record.rows,
                env,
              })
              .pipe(
                Effect.tapError(() => {
                  session.record = {
                    ...session.record,
                    terminal: { ...session.record.terminal, status: "error" },
                  };
                  return persist(session);
                }),
                Effect.mapError(() => fail("spawn", "launch-failed", input)),
              );
            session.process = process;
            session.record = {
              ...session.record,
              terminal: { ...session.record.terminal, status: "running", pid: process.pid },
            };
            type Pending =
              | { type: "output"; data: string; droppedBytes?: number }
              | { type: "exit"; event: PtyAdapter.PtyExitEvent };
            const pending: Pending[] = [];
            let queuedBytes = 0;
            let draining = false;
            let exitQueued = false;
            const drain = Effect.fn("ProjectTerminalManager.drain")(function* () {
              while (pending.length > 0) {
                const item = pending.shift()!;
                if (session.process !== process) continue;
                if (item.type === "output") {
                  queuedBytes -= Buffer.byteLength(item.data);
                  if (item.droppedBytes !== undefined) {
                    session.record = {
                      ...session.record,
                      history: "",
                      offset:
                        session.record.offset +
                        Buffer.byteLength(session.record.history) +
                        item.droppedBytes,
                    };
                  }
                  const combined = session.record.history + item.data;
                  const history = boundedText(combined, DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
                  session.record = {
                    ...session.record,
                    history,
                    offset:
                      session.record.offset +
                      Buffer.byteLength(combined) -
                      Buffer.byteLength(history),
                  };
                  for (let rest = item.data; rest.length > 0;) {
                    const data = prefix(rest, 65_536);
                    rest = rest.slice(data.length);
                    stamp(session, yield* Clock.currentTimeMillis);
                    yield* publish(session, {
                      type: "output",
                      handle: input,
                      data,
                      sequence: session.record.sequence,
                    });
                  }
                } else {
                  stamp(session, yield* Clock.currentTimeMillis);
                  session.process = null;
                  session.unsubscribe.splice(0).forEach((unsubscribe) => unsubscribe());
                  session.record = {
                    ...session.record,
                    terminal: {
                      ...session.record.terminal,
                      status: "exited",
                      pid: null,
                      exitCode: item.event.exitCode,
                      exitSignal: item.event.signal,
                    },
                  };
                  exits.set(exitKey(session.record.terminal), session.record.terminal);
                  if (options.persistence?.saveExit)
                    yield* options.persistence
                      .saveExit(session.record.terminal)
                      .pipe(Effect.mapError(() => fail("close", "cleanup-failed", input)));
                  yield* persist(session);
                  yield* publish(session, {
                    type: "exited",
                    handle: input,
                    sequence: session.record.sequence,
                    status: "exited",
                    exitCode: item.event.exitCode,
                    exitSignal: item.event.signal,
                  });
                  yield* publishMetadata(session);
                  yield* Effect.forEach(
                    events,
                    (listener) => listener({ type: "exited", terminal: session.record.terminal }),
                    { discard: true },
                  );
                }
                const previous = session.changed;
                session.changed = yield* Deferred.make<void>();
                yield* Deferred.succeed(previous, undefined);
                if (session.cleanupRequested && session.record.terminal.status === "exited")
                  yield* removeStoppedSession(session);
              }
              if (sessions.get(key(input)) === session) yield* persist(session);
            });
            const enqueue = (item: Pending) => {
              if (session.process !== process || exitQueued) return;
              if (item.type === "output") {
                queuedBytes += Buffer.byteLength(item.data);
                if (queuedBytes > 8 * 1024 * 1024 || pending.length >= 1024) {
                  // Retain a bounded snapshot and tell attached readers to resynchronize.
                  const data = boundedText(item.data, DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
                  const droppedBytes =
                    queuedBytes -
                    Buffer.byteLength(data) +
                    pending.reduce(
                      (bytes, item) =>
                        bytes + (item.type === "output" ? (item.droppedBytes ?? 0) : 0),
                      0,
                    );
                  pending.push({ type: "output", data, droppedBytes });
                  queuedBytes = Buffer.byteLength(data);
                  pending.splice(0, pending.length - 1);
                  runFork(
                    publish(session, {
                      type: "reconnect",
                      handle: input,
                      sequence: session.record.sequence,
                    }),
                  );
                } else {
                  pending.push(item);
                }
              } else {
                exitQueued = true;
                pending.push(item);
              }
              if (draining) return;
              draining = true;
              session.worker = runFork(
                locks.withLock(input.projectId, drain()).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      draining = false;
                    }),
                  ),
                  Effect.catchCause(Effect.logError),
                ),
              );
            };
            session.unsubscribe.push(
              process.onData((data) => enqueue({ type: "output", data })),
              process.onExit((event) => enqueue({ type: "exit", event })),
            );
            yield* persist(session);
            yield* publishMetadata(session);
            return session.record.terminal;
          }),
        )
        .pipe(Effect.uninterruptible);
    const attachProjectStream = (
      input: ProjectTerminalHandle,
      listener: (event: ProjectTerminalAttachStreamEvent) => Effect.Effect<void>,
      registerCleanup?: (stop: () => void) => void,
    ) =>
      locks.withLock(
        input.projectId,
        Effect.gen(function* () {
          const session = yield* requireSession(input, "attach");
          const stop = () => {
            session.listeners.delete(listener);
          };
          session.listeners.add(listener);
          registerCleanup?.(stop);
          yield* listener({
            type: "snapshot",
            snapshot: {
              terminal: dock(session.record),
              history: session.record.history,
              cols: session.record.cols,
              rows: session.record.rows,
              sequence: session.record.sequence,
            },
          }).pipe(Effect.onError(() => Effect.sync(stop)));
          return stop;
        }),
      );
    const subscribeProjectMetadata = (
      projectId: ProjectId,
      listener: (event: ProjectTerminalMetadataStreamEvent) => Effect.Effect<void>,
    ) =>
      locks.withLock(
        projectId,
        Effect.gen(function* () {
          const entry = { projectId, listener };
          metadata.add(entry);
          const stop = () => {
            metadata.delete(entry);
          };
          const page = yield* listProjectDockSummaries({ projectId });
          yield* listener({ type: "snapshot", projectId, ...page }).pipe(
            Effect.onError(() => Effect.sync(stop)),
          );
          return stop;
        }),
      );
    const writeProject = (
      input: ProjectTerminalWriteInput,
      guard: Effect.Effect<void, TerminalToolError> = Effect.void,
      ownership?: ProjectTerminalOwnership,
    ) =>
      locks.withLock(
        input.projectId,
        Effect.gen(function* () {
          const session = yield* requireSession(input, "write");
          if (ownership && !projectTerminalOwnerMatches(session.record.ownership, ownership))
            return yield* fail("write", "unavailable", input);
          const process = session.process;
          if (
            input.expectedGeneration !== undefined &&
            input.expectedGeneration !== session.record.terminal.generation
          )
            return yield* fail("write", "stale-generation", input);
          if (!process) return yield* fail("write", "not-running", input);
          yield* guard;
          yield* Effect.try({
            try: () => process.write(input.data),
            catch: () => fail("write", "write-failed", input),
          });
        }),
      );
    const resizeProject = (
      input: ProjectTerminalResizeInput,
      guard: Effect.Effect<void, TerminalToolError> = Effect.void,
      ownership?: ProjectTerminalOwnership,
    ) =>
      locks.withLock(
        input.projectId,
        Effect.gen(function* () {
          const session = yield* requireSession(input, "resize");
          if (ownership && !projectTerminalOwnerMatches(session.record.ownership, ownership))
            return yield* fail("resize", "unavailable", input);
          const process = session.process;
          if (
            input.expectedGeneration !== undefined &&
            input.expectedGeneration !== session.record.terminal.generation
          )
            return yield* fail("resize", "stale-generation", input);
          if (!process) return yield* fail("resize", "not-running", input);
          yield* guard;
          yield* Effect.try({
            try: () => process.resize(input.cols, input.rows),
            catch: () => fail("resize", "resize-failed", input),
          });
          session.record = { ...session.record, cols: input.cols, rows: input.rows };
          stamp(session, yield* Clock.currentTimeMillis);
          yield* persist(session);
          yield* publishMetadata(session);
          yield* publish(session, {
            type: "resized",
            handle: input,
            cols: input.cols,
            rows: input.rows,
            sequence: session.record.sequence,
          });
        }),
      );
    const stopSession = Effect.fn("ProjectTerminalManager.stop")(function* (
      session: Session,
    ): Effect.fn.Return<ProjectTerminalStopResult, TerminalToolError> {
      const handle = terminalHandle(session);
      const process = session.process;
      if (!process)
        return {
          ...handle,
          generation: session.record.terminal.generation,
          status: session.record.terminal.status === "exited" ? "exited" : "unknown",
        };
      session.record = {
        ...session.record,
        terminal: { ...session.record.terminal, status: "stopping" },
      };
      yield* persist(session);
      const result = yield* Effect.try({
        try: () => process.kill(),
        catch: () => fail("kill", "stop-uncertain", handle),
      }).pipe(Effect.result);
      if (result._tag === "Failure") {
        session.record = {
          ...session.record,
          terminal: { ...session.record.terminal, status: "unknown" },
        };
        yield* persist(session);
        yield* publishMetadata(session);
        return { ...handle, generation: session.record.terminal.generation, status: "unknown" };
      }
      yield* publishMetadata(session);
      return { ...handle, generation: session.record.terminal.generation, status: "requested" };
    });
    const killProjectTerminal = (
      input: ProjectTerminalKillInput,
      guard: Effect.Effect<void, TerminalToolError> = Effect.void,
      ownership?: ProjectTerminalOwnership,
    ) =>
      locks.withLock(
        input.projectId,
        Effect.gen(function* () {
          const session = yield* requireSession(input, "kill");
          if (ownership && !projectTerminalOwnerMatches(session.record.ownership, ownership))
            return yield* fail("kill", "unavailable", input);
          if (
            input.expectedGeneration !== undefined &&
            input.expectedGeneration !== session.record.terminal.generation
          )
            return yield* fail("kill", "stale-generation", input);
          yield* guard;
          if (input.cleanup) session.cleanupRequested = true;
          const result = yield* stopSession(session);
          if (session.cleanupRequested && result.status === "exited")
            yield* removeStoppedSession(session);
          return result;
        }),
      );
    const closeProject = (projectId: ProjectId): Effect.Effect<void, TerminalToolError> =>
      locks.withLock(
        projectId,
        Effect.gen(function* () {
          closingProjects.add(projectId);
          // Capture objects and generations before requesting stop; no name/PID rediscovery.
          const owned = [...sessions.values()].filter(
            (session) => session.record.terminal.projectId === projectId,
          );
          let uncertain: ProjectTerminalHandle | undefined;
          for (const session of owned) {
            const result = yield* stopSession(session).pipe(Effect.result);
            if (result._tag === "Failure" || result.success.status === "unknown")
              uncertain = terminalHandle(session);
          }
          if (uncertain) return yield* fail("close", "stop-uncertain", uncertain);
        }),
      );
    const closeProjectOwner = (
      owner: Pick<
        ProjectTerminalOwnership,
        "projectId" | "rootId" | "bindingId" | "generation" | "fence"
      >,
    ): Effect.Effect<void, TerminalToolError> =>
      locks.withLock(
        owner.projectId,
        Effect.gen(function* () {
          const captured = [...sessions.values()].filter((session) => {
            const owned = session.record.ownership;
            return (
              session.record.terminal.projectId === owner.projectId &&
              owned?.rootId === owner.rootId &&
              owned.bindingId === owner.bindingId &&
              owned.generation === owner.generation &&
              owned.fence === owner.fence
            );
          });
          let uncertain: ProjectTerminalHandle | undefined;
          for (const session of captured) {
            const result = yield* stopSession(session).pipe(Effect.result);
            if (result._tag === "Failure" || result.success.status === "unknown")
              uncertain = terminalHandle(session);
          }
          if (uncertain) return yield* fail("close", "stop-uncertain", uncertain);
        }),
      );
    const readProject = Effect.fn("ProjectTerminalManager.readProject")(function* (
      input: TerminalReadInput & { readonly readerId: string },
    ) {
      const session = yield* requireSession(input, "read");
      let record = session.record;
      const now = yield* Clock.currentTimeMillis;
      const mode = input.search ? "search" : "stream";
      const searchBinding = input.search
        ? `${input.search.ignoreCase === true ? "i" : "s"}:${input.search.text}`
        : "";
      let offset = record.offset;
      if (input.cursor) {
        const claimsJson = yield* Effect.try({
          try: () => {
            if (input.cursor!.length > 4096) throw new Error();
            const [encoded, signature] = input.cursor!.split(".");
            const expected = NodeCrypto.createHmac("sha256", secret)
              .update(encoded!)
              .update(searchBinding)
              .digest();
            const actual = Buffer.from(signature!, "base64url");
            if (actual.length !== expected.length || !NodeCrypto.timingSafeEqual(actual, expected))
              throw new Error();
            return Buffer.from(encoded!, "base64url").toString();
          },
          catch: () => fail("read", "invalid-cursor", input),
        });
        const claims = yield* decodeCursor(claimsJson).pipe(
          Effect.mapError(() => fail("read", "invalid-cursor", input)),
        );
        if (
          claims.readerId !== input.readerId ||
          claims.projectId !== input.projectId ||
          claims.terminalId !== input.terminalId ||
          claims.mode !== mode ||
          !Number.isSafeInteger(claims.offset) ||
          claims.offset < 0
        )
          return yield* fail("read", "invalid-cursor", input);
        if (claims.generation !== record.terminal.generation)
          return yield* fail("read", "stale-generation", input);
        if (!(Date.parse(claims.expiresAt) > now))
          return yield* fail("read", "cursor-expired", input);
        offset = claims.offset;
      }
      const budget = input.maxBytes ?? 65_536;
      if (!Number.isInteger(budget) || budget < 1 || budget > 65_536)
        return yield* fail("read", "invalid-budget", input);
      if (
        input.waitMs !== undefined &&
        (!Number.isInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > 30_000)
      )
        return yield* fail("read", "invalid-budget", input);
      if (
        (input.waitMs ?? 0) > 0 &&
        !input.search &&
        !input.tailLines &&
        offset === record.offset + Buffer.byteLength(record.history) &&
        session.process
      ) {
        const changed = session.changed;
        yield* Deferred.await(changed).pipe(Effect.timeoutOption(input.waitMs!));
        record = session.record;
      }
      const end = record.offset + Buffer.byteLength(record.history);
      if (offset > end) return yield* fail("read", "invalid-cursor", input);
      const truncated = offset < record.offset;
      offset = Math.max(offset, record.offset);
      const encode = (next: number) => {
        const claims: ProjectTerminalReadCursorClaims = {
          version: 1,
          readerId: input.readerId,
          projectId: input.projectId,
          terminalId: input.terminalId,
          generation: record.terminal.generation,
          mode,
          offset: next,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 15 * 60_000)),
        };
        const encoded = Buffer.from(encodeCursor(claims)).toString("base64url");
        return `${encoded}.${NodeCrypto.createHmac("sha256", secret).update(encoded).update(searchBinding).digest("base64url")}`;
      };
      let text = Buffer.from(record.history)
        .subarray(offset - record.offset)
        .toString("utf8");
      if (input.tailLines) text = record.history.split("\n").slice(-input.tailLines).join("\n");
      if (input.search) {
        const literal = input.search.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const expression = new RegExp(literal, input.search.ignoreCase ? "giu" : "gu");
        const matches = [];
        let consumed = 0;
        let used = 0;
        for (const match of text.matchAll(expression)) {
          const index = match.index;
          const matchEnd = index + match[0].length;
          const excerpt = prefix(text.slice(index, matchEnd + 80), budget - used);
          if (excerpt.length === 0) {
            if (matches.length > 0) break;
            return yield* fail("read", "invalid-budget", input);
          }
          const start = offset + Buffer.byteLength(text.slice(0, index));
          const end = start + Buffer.byteLength(match[0]);
          matches.push({ start, end, excerpt });
          consumed = matchEnd;
          used += Buffer.byteLength(excerpt);
          if (matches.length >= 256 || used >= budget) break;
        }
        const next = consumed > 0 ? offset + Buffer.byteLength(text.slice(0, consumed)) : end;
        return {
          kind: "search",
          terminal: record.terminal,
          matches,
          nextCursor: encode(next),
          hasMore: next < end,
          truncated,
        } satisfies TerminalReadResult;
      }
      const output = input.tailLines ? boundedText(text, budget) : prefix(text, budget);
      if (text.length > 0 && output.length === 0)
        return yield* fail("read", "invalid-budget", input);
      const next = input.tailLines ? end : offset + Buffer.byteLength(output);
      return {
        kind: "stream",
        terminal: record.terminal,
        output,
        nextCursor: encode(next),
        hasMore: next < end,
        truncated:
          truncated ||
          (input.tailLines !== undefined && Buffer.byteLength(output) < Buffer.byteLength(text)),
      } satisfies TerminalReadResult;
    });
    const getProjectOwnership = (handle: ProjectTerminalHandle) =>
      requireSession(handle, "subscribeCompletion").pipe(
        Effect.map((session) => session.record.ownership),
      );
    const subscribeProjectEvents = (
      listener: (event: ProjectTerminalEvent) => Effect.Effect<void>,
    ) =>
      Effect.sync(() => {
        events.add(listener);
        return () => {
          events.delete(listener);
        };
      });
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...sessions.values()],
        (session) =>
          Effect.gen(function* () {
            if (session.worker) yield* Fiber.await(session.worker);
            if (!session.process) return;
            const result = yield* stopSession(session).pipe(Effect.result);
            if (session.worker) yield* Fiber.await(session.worker);
            // A missing exit callback remains uncertain even when kill() returned normally.
            if (session.process || result._tag === "Failure") {
              session.record = {
                ...session.record,
                terminal: { ...session.record.terminal, status: "unknown" },
              };
              yield* persist(session).pipe(Effect.ignore);
            }
            session.unsubscribe.splice(0).forEach((unsubscribe) => unsubscribe());
          }),
        { discard: true },
      ),
    );
    return {
      createProject,
      listProject,
      listProjectCompletionSnapshots,
      listProjectDockSummaries,
      attachProjectStream,
      subscribeProjectMetadata,
      readProject,
      writeProject,
      resizeProject,
      killProjectTerminal,
      closeProject,
      closeProjectOwner,
      subscribeProjectEvents,
      getProjectOwnership,
    };
  },
);
export type ProjectTerminalManagerMethods = Effect.Success<
  ReturnType<typeof makeProjectTerminalManager>
>;
