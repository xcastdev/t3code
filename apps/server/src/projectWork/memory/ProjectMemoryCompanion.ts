import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HostProcessUserId } from "@t3tools/shared/hostProcess";
import {
  acquirePiManagedProcess,
  preallocatePiManagedProcess,
  reconcilePiManagedProcess,
  PiManagedProcessError,
  MAX_PI_RUNTIME_FILE_BYTES,
  type PiManagedProcess,
  type PiManagedProcessOwner,
} from "../../provider/pi/PiManagedProcess.ts";
import { MEMORY_BACKEND_MAX_BYTES, MemoryBackendError } from "./MemoryBackend.ts";
import type { ProjectMemoryProcessingConfiguration } from "./ProjectMemoryPorts.ts";
import { ProjectMemoryServiceError, projectMemoryHash } from "./ProjectMemoryService.ts";
import {
  makeProjectMemoryCompanionJournal,
  type ProjectMemoryCompanionOwner,
  type ProjectMemoryCompanionForwardFence,
} from "./ProjectMemoryCompanionJournal.ts";

const deny = (reason: string) => new ProjectMemoryServiceError({ reason });
const isServiceError = Schema.is(ProjectMemoryServiceError);
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Response = Schema.Union([
  Schema.Struct({
    protocolVersion: Schema.Literal(1),
    requestId: Id,
    operation: Schema.String,
    result: Schema.Unknown,
  }),
  Schema.Struct({
    protocolVersion: Schema.Literal(1),
    requestId: Id,
    operation: Schema.String,
    error: Schema.Struct({
      code: Schema.Literals(["invalid-request", "unavailable", "fenced", "conflict"]),
      message: Schema.String.check(Schema.isMaxLength(256)),
    }),
  }),
]);

const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(Response), {
  onExcessProperty: "error",
});

/** Constructors do not inspect native controls, launch, or recover anything. */
export const makeProjectMemoryCompanion = Effect.fn("makeProjectMemoryCompanion")(
  function* (options: {
    readonly environmentId: string;
    readonly protectedRoots: ReadonlyArray<string>;
    readonly assertAdmission: Effect.Effect<void, ProjectMemoryServiceError>;
    readonly allocate?: typeof preallocatePiManagedProcess;
    readonly launch?: typeof acquirePiManagedProcess;
    readonly reconcile?: typeof reconcilePiManagedProcess;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const uid = yield* HostProcessUserId;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const provideNative = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
    const journal = yield* makeProjectMemoryCompanionJournal(options.environmentId);
    const protectedRoots = [...options.protectedRoots];
    const overlaps = (a: string, b: string) =>
      a === "/" || b === "/" || a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
    const paths = Effect.fn("ProjectMemoryCompanion.paths")(function* (
      owner: ProjectMemoryCompanionOwner,
      configuration: ProjectMemoryProcessingConfiguration,
    ) {
      const root = configuration.companion.storeRoot;
      if (root === "/" || path.resolve(root) !== root || (yield* fs.realPath(root)) !== root)
        return yield* deny("Companion store root must be canonical and pre-provisioned");
      const roots = yield* Effect.forEach(
        [
          ...new Set([
            ...protectedRoots,
            ...owner.operation.allocation.launch.protectedRoots,
            owner.operation.allocation.launch.workspace.path,
            ...(owner.operation.allocation.launch.nativeState
              ? [owner.operation.allocation.launch.nativeState.path]
              : []),
          ]),
        ],
        (root) => fs.realPath(root),
      );
      if (roots.some((protectedRoot) => overlaps(root, protectedRoot)))
        return yield* deny("Companion store overlaps protected data");
      const key = projectMemoryHash([
        owner.operation.environmentId,
        owner.version === 2
          ? (owner.sharedSource?.ownerProjectId ?? owner.operation.projectId)
          : owner.operation.projectId,
      ]);
      const workspaceRoot = path.join(root, "cwd", key);
      const nativeStateRoot = path.join(root, "projects", key);
      for (const directory of [
        root,
        path.join(root, "cwd"),
        path.join(root, "projects"),
        workspaceRoot,
        nativeStateRoot,
      ]) {
        if (directory !== root)
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        const info = yield* fs.stat(directory);
        if (
          info.type !== "Directory" ||
          (yield* fs.realPath(directory)) !== directory ||
          Option.isNone(info.ino) ||
          Option.isNone(info.uid) ||
          info.uid.value !== uid ||
          (info.mode & 0o077) !== 0
        )
          return yield* deny("Companion directories require private exact owned inodes");
      }
      const entries = yield* fs.readDirectory(workspaceRoot);
      if (entries.length !== 0) return yield* deny("Companion readonly cwd must be empty");
      const script = yield* fs.realPath(
        yield* path.fromFileUrl(new URL("./companion/mem0_backend.py", import.meta.url)),
      );
      const scriptEntry = configuration.companion.runtimeFiles.find(
        (file) => file.target === configuration.companion.scriptTarget,
      );
      if (!scriptEntry || (yield* fs.realPath(scriptEntry.source)) !== script)
        return yield* deny("Companion requires the owned prepared-vector dispatcher");
      if (
        !configuration.companion.runtimeFiles.some(
          (file) => file.target === configuration.companion.executable,
        )
      )
        return yield* deny("Companion executable must belong to its supplied closure");
      let runtimeBytes = 0;
      for (const file of configuration.companion.runtimeFiles) {
        const info = yield* fs.stat(file.source);
        runtimeBytes += Number(info.size);
        if (
          info.type !== "File" ||
          !Number.isSafeInteger(runtimeBytes) ||
          runtimeBytes > MAX_PI_RUNTIME_FILE_BYTES
        )
          return yield* deny("Companion supplied runtime closure exceeds its physical byte bound");
      }
      return { workspaceRoot, nativeStateRoot, protectedRoots: roots };
    });
    const collect = Effect.fn("ProjectMemoryCompanion.collect")(function* (
      stream: PiManagedProcess["stdout"],
      maximum: number,
    ) {
      let count = 0;
      const chunks: Uint8Array[] = [];
      yield* Stream.runForEach(stream, (bytes) =>
        Effect.gen(function* () {
          count += bytes.byteLength;
          if (count > maximum) return yield* deny("Companion output exceeds its byte bound");
          chunks.push(bytes);
        }),
      );
      return new Uint8Array(Buffer.concat(chunks));
    });
    const exchange = Effect.fn("ProjectMemoryCompanion.exchange")(function* (
      owner: ProjectMemoryCompanionOwner,
      configuration: ProjectMemoryProcessingConfiguration,
      bytes: Uint8Array,
      fence: ProjectMemoryCompanionForwardFence,
    ) {
      yield* options.assertAdmission;
      const inspected = yield* journal.inspect(owner, configuration, bytes, fence);
      if (inspected.original) {
        const response = yield* journal.replay(inspected.original.intent);
        if (response !== undefined) return response;
        return yield* deny(
          "Original companion invocation waits for matched drain; it cannot relaunch",
        );
      }
      const deadline = inspected.authority.deadlineAtMs;
      const runtimeSeconds = Math.min(
        owner.operation.allocation.policy.runtimeSeconds,
        3600,
        Math.floor((deadline - (yield* Clock.currentTimeMillis)) / 1000),
      );
      if (runtimeSeconds < 1)
        return yield* deny("Original companion deadline cannot accommodate launch");
      const launch = {
        ...(yield* paths(owner, configuration)),
        workspaceAccess: "readonly",
        runtimeFiles: configuration.companion.runtimeFiles,
        argv: [
          configuration.companion.executable,
          "-I",
          configuration.companion.scriptTarget,
          "--store-dir",
          "/state",
        ],
        memoryBytes: configuration.companion.memoryBytes,
        runtimeSeconds,
      } satisfies Parameters<typeof preallocatePiManagedProcess>[0];
      const allocation = yield* provideNative(
        (options.allocate ?? preallocatePiManagedProcess)(launch),
      );
      const prepared = yield* journal.prepare(owner, configuration, bytes, allocation, fence);
      const intent = prepared.intent;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          let capturedOwner: PiManagedProcessOwner | undefined;
          const process = yield* provideNative(
            (options.launch ?? acquirePiManagedProcess)(launch, {
              allocation,
              deadlineAtMs: intent.deadlineAtMs,
              claimActivation: (actual) =>
                canonicalProjectWorkPayload(actual) === canonicalProjectWorkPayload(allocation)
                  ? journal
                      .claim(intent, fence)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new PiManagedProcessError({ phase: "startup", message: error.reason }),
                        ),
                      )
                  : Effect.fail(
                      new PiManagedProcessError({
                        phase: "startup",
                        message: "Companion launch allocation changed",
                      }),
                    ),
              beforeStart: (physical) =>
                Effect.gen(function* () {
                  capturedOwner = structuredClone(physical);
                  yield* journal.beforeStart(intent, physical, fence);
                }).pipe(
                  Effect.mapError(
                    (error) =>
                      new PiManagedProcessError({ phase: "startup", message: error.reason }),
                  ),
                ),
              afterDrain: (receipt) =>
                journal
                  .drain(intent, receipt, capturedOwner)
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new PiManagedProcessError({ phase: "quarantine", message: error.reason }),
                    ),
                  ),
            }),
          );
          const [output, stderr, receipt] = yield* Effect.all(
            [
              collect(process.stdout, MEMORY_BACKEND_MAX_BYTES + 1),
              collect(process.stderr, 8192),
              Effect.gen(function* () {
                yield* process.start;
                for (let offset = 0; offset < bytes.byteLength; offset += 8192)
                  yield* process.send(bytes.subarray(offset, offset + 8192));
                yield* process.endInput;
                return yield* process.awaitExit;
              }),
            ],
            { concurrency: "unbounded" },
          );
          yield* journal.drain(intent, receipt);
          if (
            receipt.childExitCode !== 0 ||
            stderr.byteLength !== 0 ||
            output.byteLength < 2 ||
            output[output.byteLength - 1] !== 10
          )
            return yield* deny("Companion response requires one successful drained invocation");
          const response = output.subarray(0, output.byteLength - 1);
          const text = yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(response),
            catch: () => deny("Companion response is not UTF-8"),
          });
          const decoded = yield* decodeResponse(text);
          if (
            decoded.requestId !== intent.requestId ||
            decoded.operation !== intent.operation ||
            text.includes("\n") ||
            text.includes("\r")
          )
            return yield* deny("Companion response changed its matching single-line envelope");
          yield* journal.response(intent, response);
          return response;
        }),
      ).pipe(Effect.tapError(() => journal.uncertain(intent)));
    });
    const cleanup = Effect.fn("ProjectMemoryCompanion.cleanup")(function* (effectId: string) {
      const rows = yield* journal.retained(effectId);
      for (const row of rows) {
        if (row.drain !== null) continue;
        if (row.owner === undefined)
          return yield* deny(
            "Uncaptured companion retains capacity until genuine owner evidence exists",
          );
        // Retained allocation and captured ownership authorize stopping the original
        // process even when forward admission has been revoked.
        const receipt = yield* provideNative(
          (options.reconcile ?? reconcilePiManagedProcess)(
            { allocation: row.intent.allocation, activation: "owned", owner: row.owner },
            { stop: true },
          ),
        );
        yield* journal.drain(row.intent, receipt);
      }
    });
    const confirmSearchDrain = Effect.fn("ProjectMemoryCompanion.confirmSearchDrain")(function* (
      requestId: string,
    ) {
      if (!requestId.endsWith(":search"))
        return yield* deny("Query drain requires its exact original request ID");
      const effectId = requestId.slice(0, -7);
      const rows = yield* journal.retained(effectId);
      if (
        rows.length !== 1 ||
        rows[0]!.intent.owner.version !== 2 ||
        rows[0]!.intent.requestId !== requestId
      )
        return yield* deny("Original query companion drain is unavailable");
      yield* cleanup(effectId);
    });
    return {
      companion: (...args: Parameters<typeof exchange>) =>
        exchange(...args).pipe(
          Effect.mapError(
            (error) =>
              new MemoryBackendError({
                code: "unavailable",
                message: isServiceError(error) ? error.reason : "Owned memory companion failed",
              }),
          ),
        ),
      cleanup: (effectId: string) =>
        cleanup(effectId).pipe(
          Effect.mapError((error) =>
            isServiceError(error) ? error : deny("Original companion cleanup is unavailable"),
          ),
        ),
      confirmSearchDrain: (requestId: string) =>
        confirmSearchDrain(requestId).pipe(
          Effect.mapError((error) =>
            isServiceError(error) ? error : deny("Original query companion drain is unavailable"),
          ),
        ),
    };
  },
);
