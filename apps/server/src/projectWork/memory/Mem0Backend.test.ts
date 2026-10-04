// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Captured native Python test processes need bounded pipe retention and cleanup.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeMem0Backend } from "./Mem0Backend.ts";
import {
  MEMORY_BACKEND_MAX_BYTES,
  MemoryBackendError,
  type MemoryBackendTransport,
  type MemoryIndexManifest,
} from "./MemoryBackend.ts";

const scope = { environmentId: "environment-a", projectId: "project-a" };
const vector = [1, ...Array.from({ length: 2047 }, () => 0)];
const manifest: typeof MemoryIndexManifest.Type = {
  ...scope,
  sourceRecordId: "memory-source-a",
  sourceRevision: 1,
  sourceGeneration: 1,
  extractionId: "extraction-a",
  observations: [
    {
      observationId: "observation-a",
      body: "A sourced observation",
      payloadHash: "a".repeat(64),
      vector,
    },
  ],
};
const failureCode = <A>(effect: Effect.Effect<A, MemoryBackendError>) =>
  effect.pipe(Effect.match({ onSuccess: () => "accepted", onFailure: (error) => error.code }));

/** Concrete byte transport to the committed dispatcher. Missing pins fail rather than skip. */
const nativeTransport =
  (directory: string): MemoryBackendTransport =>
  (request) =>
    Effect.tryPromise({
      try: (signal) =>
        new Promise<Uint8Array>((resolve, reject) => {
          const python = process.env.T3_MEM0_TEST_PYTHON;
          if (!python) {
            reject(
              new Error(
                "Set T3_MEM0_TEST_PYTHON to the pinned Python Mem0 2.2.1 / Qdrant 1.19.1 proof environment",
              ),
            );
            return;
          }
          const child = NodeChildProcess.spawn(
            python,
            [
              NodeURL.fileURLToPath(new URL("./companion/mem0_backend.py", import.meta.url)),
              "--store-dir",
              directory,
            ],
            {
              stdio: ["pipe", "pipe", "pipe"],
              env: {
                ...process.env,
                PYTHONDONTWRITEBYTECODE: "1",
                OPENBLAS_NUM_THREADS: "1",
                OMP_NUM_THREADS: "1",
                HF_HUB_OFFLINE: "1",
                TRANSFORMERS_OFFLINE: "1",
                MEM0_TELEMETRY: "false",
              },
            },
          );
          const chunks: Buffer[] = [];
          let retained = 0;
          let stderrBytes = 0;
          let failure: Error | undefined;
          const stop = () => {
            failure = new Error("Native memory transport canceled");
            child.kill("SIGKILL");
          };
          const deadline = setTimeout(stop, 10_000);
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) stop();
          child.on("error", (error) => {
            failure = error;
          });
          child.stdin.on("error", (error) => {
            failure = error;
            child.kill("SIGKILL");
          });
          child.stdout.on("data", (chunk: Buffer) => {
            if (failure) return;
            if (retained + chunk.byteLength > MEMORY_BACKEND_MAX_BYTES) {
              failure = new Error("Native memory output exceeds byte limit");
              child.kill("SIGKILL");
              return;
            }
            retained += chunk.byteLength;
            chunks.push(chunk);
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderrBytes += chunk.byteLength;
            if (stderrBytes > 65_536) {
              failure = new Error("Native memory stderr exceeds byte limit");
              child.kill("SIGKILL");
            }
          });
          child.on("close", (code) => {
            clearTimeout(deadline);
            signal.removeEventListener("abort", stop);
            if (failure || code !== 0) reject(failure ?? new Error("Native memory process failed"));
            else resolve(Buffer.concat(chunks));
          });
          child.stdin.end(request);
        }),
      catch: () =>
        new MemoryBackendError({ code: "unavailable", message: "Native memory transport failed" }),
    });

// Ordinary discovery exercises the portable boundary. Native proof is explicitly
// selected, and selection still requires the exact external interpreter pins.
if (process.env.T3_MEM0_NATIVE_TEST === "1") {
  describe("Mem0Backend required native proof", () => {
    it.effect(
      "uses actual pinned native index, recovery receipt, search and namespace deletion",
      () =>
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() =>
              NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mem0-adapter-")),
            ),
            (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
          );
          const backend = makeMem0Backend(nativeTransport(directory));
          expect(yield* backend.health("health", scope)).toMatchObject({
            engineVersion: "2.2.1",
            qdrantVersion: "1.19.1",
          });
          expect(yield* backend.index("index", manifest)).toEqual({
            writtenObservationIds: ["observation-a"],
          });
          expect(yield* backend.index("replay", manifest)).toEqual({ writtenObservationIds: [] });
          expect(yield* backend.reconcile("receipt", manifest)).toEqual({
            complete: true,
            missingObservationIds: [],
            invalidObservationIds: [],
            unexpectedBackendIds: [],
          });
          const search = yield* backend.search("search", { ...scope, vector, limit: 10 });
          expect(search.candidates).toHaveLength(1);
          expect(search.candidates[0]).toMatchObject({
            ...scope,
            observationId: "observation-a",
            sourceRecordId: "memory-source-a",
          });
          expect(search.candidates[0]).not.toHaveProperty("body");
          expect(search.candidates[0]).not.toHaveProperty("data");
          expect(
            yield* backend.search("other-environment", {
              ...scope,
              environmentId: "environment-b",
              vector,
              limit: 10,
            }),
          ).toEqual({ candidates: [] });
          yield* backend.deleteSource("delete", {
            ...scope,
            sourceRecordId: manifest.sourceRecordId,
            sourceRevision: 1,
            sourceGeneration: 1,
          });
          expect(yield* failureCode(backend.index("late", manifest))).toBe("fenced");
          yield* backend.deleteProject("project-delete", scope);
          expect(
            yield* failureCode(backend.search("deleted", { ...scope, vector, limit: 10 })),
          ).toBe("fenced");
        }),
    );
  });
}

describe("Mem0Backend portable serialized boundary", () => {
  it.effect(
    "rejects extra fields, invalid vectors, limits, repeated IDs and request IDs before transport",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const backend = makeMem0Backend(() => {
          calls += 1;
          return Effect.fail(
            new MemoryBackendError({ code: "unavailable", message: "Unexpected dispatch" }),
          );
        });
        for (const input of [
          { ...scope, vector: [1], limit: 10 },
          { ...scope, vector: [NaN, ...vector.slice(1)], limit: 10 },
          { ...scope, vector: [Infinity, ...vector.slice(1)], limit: 10 },
          { ...scope, vector, limit: 101 },
          { ...scope, vector, limit: 10, extra: "unexpected" },
        ])
          expect(yield* failureCode(backend.search("search", input))).toBe("invalid-request");
        expect(
          yield* failureCode(
            backend.index("index", {
              ...manifest,
              observations: [...manifest.observations, ...manifest.observations],
            }),
          ),
        ).toBe("invalid-request");
        expect(yield* failureCode(backend.health("", scope))).toBe("invalid-request");
        expect(calls).toBe(0);
      }),
  );

  it.effect(
    "rejects mismatched envelopes, excessive responses, extra fields, foreign IDs and returned text",
    () =>
      Effect.gen(function* () {
        const valid = {
          protocolVersion: 1,
          requestId: "search",
          operation: "search",
          result: { candidates: [] },
        };
        const candidate = {
          ...scope,
          sourceRecordId: "memory-source-a",
          sourceRevision: 1,
          sourceGeneration: 1,
          extractionId: "extraction-a",
          observationId: "observation-a",
          score: 1,
        };
        for (const returned of [
          { ...valid, requestId: "other" },
          { ...valid, operation: "health" },
          { ...valid, protocolVersion: 2 },
          { ...valid, extra: "unexpected" },
          { ...valid, result: { candidates: [{ ...candidate, body: "Backend wording" }] } },
          {
            ...valid,
            result: { candidates: [{ ...candidate, environmentId: "foreign-environment" }] },
          },
          { ...valid, result: { candidates: [{ ...candidate, projectId: "foreign-project" }] } },
        ]) {
          const backend = makeMem0Backend(() =>
            Effect.succeed(new TextEncoder().encode(JSON.stringify(returned))),
          );
          expect(
            yield* failureCode(backend.search("search", { ...scope, vector, limit: 10 })),
          ).toBe("invalid-response");
        }
        for (const bytes of [new Uint8Array(MEMORY_BACKEND_MAX_BYTES + 1), new Uint8Array([255])]) {
          const backend = makeMem0Backend(() => Effect.succeed(bytes));
          expect(
            yield* failureCode(backend.search("search", { ...scope, vector, limit: 10 })),
          ).toBe("invalid-response");
        }
      }),
  );

  it.effect("reports companion outages without creating an authoritative success", () =>
    Effect.gen(function* () {
      const backend = makeMem0Backend(() =>
        Effect.fail(new MemoryBackendError({ code: "unavailable", message: "Offline" })),
      );
      expect(yield* failureCode(backend.index("index", manifest))).toBe("unavailable");
      expect(yield* failureCode(backend.search("search", { ...scope, vector, limit: 10 }))).toBe(
        "unavailable",
      );
      // Required context and FTS fallback belong to the service consuming this error.
    }),
  );
});
