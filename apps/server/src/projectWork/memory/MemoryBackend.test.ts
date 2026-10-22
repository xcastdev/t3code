import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../../processRunner.ts";
import * as Backend from "./MemoryBackend.ts";

const destination: Backend.MemoryCompanionDestination = {
  owner: { kind: "project", projectId: ProjectId.make("project") },
  environmentId: "env",
  enabled: true,
  embeddingEnabled: true,
  command: "/usr/bin/companion",
  args: [],
  cwd: "/tmp",
};
it.effect(
  "does not start a companion on construction even when environment credentials exist",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      yield* Backend.MemoryBackend.pipe(
        Effect.provide(Backend.layer),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => {
            calls++;
            return Effect.die("unexpected process");
          },
        }),
      );
      assert.equal(calls, 0);
    }),
);
it.effect("binds responses to exact operation receipts and strips inherited environment", () =>
  Effect.gen(function* () {
    const backend = yield* Backend.MemoryBackend;
    yield* backend.execute({
      destination,
      operationKey: "exact",
      operation: "cleanup",
      payload: { sourceId: "source" },
    });
  }).pipe(
    Effect.provide(Backend.layer),
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) => {
        assert.equal(input.extendEnv, false);
        assert.deepStrictEqual(input.env, {});
        assert.equal(input.timeout, "60 seconds");
        const request = JSON.parse(input.stdin ?? "{}");
        assert.deepStrictEqual(request.namespace, {
          environmentId: "env",
          owner: destination.owner,
        });
        return Effect.succeed({
          stdout: JSON.stringify({ operationKey: "exact", operation: "cleanup", complete: true }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        });
      },
    }),
  ),
);
it.effect("rejects a success belonging to another operation", () =>
  Effect.gen(function* () {
    const backend = yield* Backend.MemoryBackend;
    const result = yield* backend
      .execute({ destination, operationKey: "exact", operation: "index", payload: {} })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
  }).pipe(
    Effect.provide(Backend.layer),
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: () =>
        Effect.succeed({
          stdout: JSON.stringify({ operationKey: "foreign", operation: "index", complete: true }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
    }),
  ),
);
it.effect("bundled mem0 confirms a frozen prepared-vector manifest before accepting indexing", () =>
  Effect.gen(function* () {
    const backend = yield* Backend.MemoryBackend;
    const configured = Backend.mem0Destination({
      environmentId: "env",
      owner: destination.owner,
      pythonPath: "/python",
      scriptPath: "/bundled/mem0_backend.py",
      storeRoot: "/private/memory",
      cwd: "/private/cwd",
      embeddingRoute: {
        environmentId: EnvironmentId.make("env"),
        owner: destination.owner,
        enabled: true,
        endpoint: "https://example.test/embeddings",
        model: "chosen",
        secretName: "memory-key",
        dimensions: 3,
      },
    });
    yield* backend.execute({
      destination: configured,
      operationKey: "exact",
      operation: "index",
      payload: { observations: [] },
    });
  }).pipe(
    Effect.provide(Backend.layer),
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) => {
        assert.deepStrictEqual(input.args, [
          "/bundled/mem0_backend.py",
          "--store-dir",
          "/private/memory",
          "--dimensions",
          "3",
        ]);
        const request = JSON.parse(input.stdin ?? "{}");
        assert.equal(request.requestId, "exact");
        const result =
          request.operation === "index"
            ? { writtenObservationIds: [] }
            : {
                complete: true,
                missingObservationIds: [],
                invalidObservationIds: [],
                unexpectedBackendIds: [],
              };
        return Effect.succeed({
          stdout: JSON.stringify({
            protocolVersion: 1,
            requestId: "exact",
            operation: request.operation,
            result,
          }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        });
      },
    }),
  ),
);
