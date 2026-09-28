import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeCrypto from "node:crypto";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "./Manager.ts";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as ProjectTerminalServiceModule from "./ProjectTerminalService.ts";
import type { ProjectTerminalRuntimeEvent } from "./RuntimeTypes.ts";
import { expect } from "vite-plus/test";

const projectId = ProjectId.make(`real-pty-smoke-${NodeCrypto.randomUUID()}`);
const firstThreadId = ThreadId.make("real-pty-smoke-first-thread");
const secondThreadId = ThreadId.make("real-pty-smoke-second-thread");
const environmentId = EnvironmentId.make("real-pty-smoke-environment");
const providerInstanceId = ProviderInstanceId.make("codex");

const invocation = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  threadId,
  providerSessionId: `real-pty-smoke-${threadId}`,
  providerInstanceId,
  capabilities: new Set(["terminal"]),
  issuedAt: 1,
});

const printMarker = (platform: NodeJS.Platform, marker: string): string => {
  if (platform === "win32") {
    const chars = Array.from(marker, (character) => `[char]${character.charCodeAt(0)}`).join(",");
    return `[Console]::Write([string]::Concat(${chars}))`;
  }
  const octal = Array.from(
    marker,
    (character) => `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`,
  ).join("");
  return `printf '${octal}'`;
};

const shellCommands = (
  platform: NodeJS.Platform,
  value: string,
  marker: string,
  nextMarker: string,
) => {
  if (platform === "win32") {
    return {
      setup: `$env:T3_TERMINAL_SMOKE_VALUE = '${value}'; ${printMarker(platform, marker)}; [Console]::WriteLine(':' + $env:T3_TERMINAL_SMOKE_VALUE)\r\n`,
      use: `${printMarker(platform, nextMarker)}; [Console]::WriteLine(':' + $env:T3_TERMINAL_SMOKE_VALUE)\r\n`,
    };
  }

  return {
    setup: `export T3_TERMINAL_SMOKE_VALUE='${value}'; ${printMarker(platform, marker)}; printf ':%s\\n' "$T3_TERMINAL_SMOKE_VALUE"\n`,
    use: `${printMarker(platform, nextMarker)}; printf ':%s\\n' "$T3_TERMINAL_SMOKE_VALUE"\n`,
  };
};

const platformServices = Layer.merge(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

effectIt.live("shares a real project PTY across callers and retains logs after kill", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const executablePath = yield* HostProcessExecutablePath;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-real-pty-smoke-" });
      const workspaceRoot = path.join(baseDir, "workspace");
      const logsDir = path.join(baseDir, "logs", "terminals");
      yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true });

      const ptyAdapter = yield* NodePtyAdapter.make();
      const manager = yield* TerminalManager.makeWithOptions({
        logsDir,
        ptyAdapter,
        env: {
          ...process.env,
          ...(platform === "win32" ? {} : { SHELL: "/bin/sh" }),
        },
        processKillGraceMs: 100,
        subprocessPollIntervalMs: 60_000,
        subprocessInspector: () =>
          Effect.succeed({
            hasRunningSubprocess: false,
            childCommand: null,
            processIds: [],
          }),
        resolveProviderInstanceEnvironment: (_instanceId, env) => Effect.succeed(env ?? {}),
      });

      const threads = new Map([
        [firstThreadId, { id: firstThreadId, projectId }],
        [secondThreadId, { id: secondThreadId, projectId }],
      ]);
      const snapshots = {
        getThreadShellById: (threadId: ThreadId) =>
          Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
        getProjectShellById: (id: ProjectId) =>
          Effect.succeed(id === projectId ? Option.some({ id, workspaceRoot }) : Option.none()),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
      let randomByte = 0;
      const crypto = Crypto.make({
        randomBytes: (size) =>
          Uint8Array.from({ length: size }, () => {
            randomByte = (randomByte + 37) & 0xff;
            return randomByte;
          }),
        digest: (_algorithm, data) => Effect.succeed(data),
      });
      const projectServiceLayer = ProjectTerminalServiceModule.ProjectTerminalServiceLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(TerminalManager.TerminalManager, manager),
            Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshots),
            Layer.succeed(Crypto.Crypto, crypto),
          ),
        ),
      );

      yield* Effect.addFinalizer(() => manager.closeProject(projectId).pipe(Effect.ignore));

      yield* Effect.gen(function* () {
        const service = yield* ProjectTerminalServiceModule.ProjectTerminalService;
        const marker = `T3_REAL_PTY_MARKER_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
        const nextMarker = `T3_REAL_PTY_VALUE_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
        const value = `retained_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
        const commands = shellCommands(platform, value, marker, nextMarker);

        const terminal = yield* Effect.scoped(
          service
            .spawn({ title: "real PTY smoke shell" })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(firstThreadId),
              ),
            ),
        );
        expect(terminal.command).toBeNull();
        expect(terminal.cwd).toBe(workspaceRoot);

        const exitObserved =
          yield* Deferred.make<Extract<ProjectTerminalRuntimeEvent, { readonly type: "exited" }>>();
        const unsubscribe = yield* manager.subscribeProjectTerminal(
          { projectId, terminalId: terminal.terminalId },
          (event) =>
            event.type === "exited"
              ? Deferred.succeed(exitObserved, event).pipe(Effect.asVoid)
              : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

        const readAs = (threadId: ThreadId, cursor: string | undefined, waitMs: number) =>
          Effect.scoped(
            service
              .read({
                projectId,
                terminalId: terminal.terminalId,
                ...(cursor === undefined ? {} : { cursor }),
                maxBytes: 16_384,
                waitMs,
              })
              .pipe(
                Effect.provideService(
                  McpInvocationContext.McpInvocationContext,
                  invocation(threadId),
                ),
              ),
          );

        const readUntilOutput = (
          threadId: ThreadId,
          cursor: string | undefined,
          expected: string,
        ) =>
          Effect.gen(function* () {
            let nextCursor = cursor;
            let output = "";
            for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
              const page = yield* readAs(threadId, nextCursor, 10_000);
              if (page.kind !== "stream") throw new Error("Expected a stream read");
              output += page.output;
              nextCursor = page.nextCursor;
              if (output.includes(expected)) return { output, nextCursor };
              if (page.output.length === 0) {
                throw new Error(
                  `Timed out waiting for ${expected}; recent PTY output: ${output.slice(-2_048)}`,
                );
              }
            }
            throw new Error(
              `Output did not contain ${expected}; recent PTY output: ${output.slice(-2_048)}`,
            );
          });

        const startingOutput = yield* readAs(firstThreadId, undefined, 0);
        if (startingOutput.kind !== "stream") throw new Error("Expected a stream read");

        // Each caller scope ends after its request returns; the server-owned PTY stays in Manager.
        yield* Effect.scoped(
          service
            .write({ terminalId: terminal.terminalId, data: commands.setup })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(firstThreadId),
              ),
            ),
        );
        const firstRead = yield* readUntilOutput(
          secondThreadId,
          startingOutput.nextCursor,
          `${marker}:${value}`,
        );

        yield* Effect.scoped(
          service
            .write({ terminalId: terminal.terminalId, data: commands.use })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(secondThreadId),
              ),
            ),
        );
        const secondRead = yield* readUntilOutput(
          secondThreadId,
          firstRead.nextCursor,
          `${nextMarker}:${value}`,
        );
        expect(secondRead.output).toContain(`${nextMarker}:${value}`);

        yield* Effect.scoped(
          service
            .kill({ terminalId: terminal.terminalId })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(secondThreadId),
              ),
            ),
        );
        const exitReceipt = yield* Deferred.await(exitObserved).pipe(
          Effect.timeoutOption("10 seconds"),
        );
        if (Option.isNone(exitReceipt)) throw new Error("Timed out waiting for shell exit event");
        expect(exitReceipt.value.status).toBe("killed");

        const retained = yield* readAs(secondThreadId, undefined, 0);
        if (retained.kind !== "stream") throw new Error("Expected a stream read");
        expect(retained.terminal.status).toBe("killed");
        expect(retained.output).toContain(`${marker}:${value}`);
        expect(retained.output).toContain(`${nextMarker}:${value}`);

        yield* Effect.scoped(
          service
            .kill({ terminalId: terminal.terminalId, cleanup: true })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(secondThreadId),
              ),
            ),
        );
        const afterCleanup = yield* Effect.scoped(
          service
            .list({})
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(secondThreadId),
              ),
            ),
        );
        expect(afterCleanup.terminals).toEqual([]);

        const direct = yield* Effect.scoped(
          service
            .spawn({
              title: "direct executable exit code smoke",
              command: executablePath,
              args: ["-e", "process.exit(23)"],
            })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(firstThreadId),
              ),
            ),
        );
        const directExit = yield* Effect.scoped(
          service
            .read({ projectId, terminalId: direct.terminalId, waitMs: 10_000 })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(secondThreadId),
              ),
            ),
        );
        expect(directExit.terminal.status).toBe("exited");
        expect(directExit.terminal.exitCode).toBe(23);
        expect(direct.command).toBe(executablePath);

        yield* Effect.scoped(
          service
            .kill({ terminalId: direct.terminalId, cleanup: true })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(secondThreadId),
              ),
            ),
        );
      }).pipe(Effect.provide(projectServiceLayer));
    }).pipe(Effect.provide(platformServices)),
  ),
);
