// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Operations from "@t3tools/provider-core/server/textGenerationOperations";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import type { OmpSettings } from "../settings.ts";
import { makeOmpProviderSession } from "./session.ts";
import { OmpRpcError } from "./rpc.ts";
import { nativeObject, nativeText } from "./toolItems.ts";
import type { NativeRecord } from "./turnController.ts";
export const collectOmpText = Effect.fn("Omp.collectText")(function* (
  connection: {
    events: Queue.Queue<NativeRecord, OmpRpcError>;
    send: (r: NativeRecord) => Effect.Effect<void, OmpRpcError>;
  },
  prompt: string,
) {
  if (!prompt.trim() || /^\s*\//.test(prompt))
    return yield* new OmpRpcError({
      operation: "helper",
      detail: "Helper input must be a nonempty generated prompt",
    });
  const id = `helper:${NodeCrypto.randomUUID()}`;
  let text = "";
  let waiting = false;
  yield* connection.send({ type: "prompt", id, message: prompt });
  for (;;) {
    const record = yield* Queue.take(connection.events);
    if (
      ["error", "persistence_error", "session_persistence_error"].includes(record.type) ||
      (record.type === "notice" &&
        record.level === "error" &&
        ["persist", "storage"].includes(String(record.source)))
    )
      return yield* new OmpRpcError({
        operation: "helper",
        detail: "Native helper runtime or persistence failed",
      });
    if (record.type === "response" && record.id === id && record.success === false)
      return yield* new OmpRpcError({
        operation: "helper",
        detail: "Native helper prompt rejected",
      });
    if (
      record.type === "message_end" &&
      nativeObject(record.message) &&
      record.message.role === "assistant"
    )
      text = nativeText(record.message);
    if (record.type === "prompt_result" && record.id === id) {
      if (record.status !== "completed")
        return yield* new OmpRpcError({ operation: "helper", detail: "Native helper failed" });
      if (record.sessionSettled === true) return text;
      waiting = true;
    }
    if (record.type === "session_settled" && waiting) return text;
    if (record.type === "host_tool_call" || record.type === "extension_ui_request")
      return yield* new OmpRpcError({
        operation: "helper",
        detail: "Restricted native helper attempted an interactive operation",
      });
  }
});
export const makeOmpTextGeneration = Effect.fn("Omp.makeTextGeneration")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const host = yield* ProviderHost;
  const runner: Operations.Runner = Effect.fn("OmpTextGeneration.run")(
    function* (request) {
      const connection = yield* makeOmpProviderSession({
        binaryPath: settings.binaryPath,
        launchArgs: settings.launchArgs,
        env: environment,
        cacheDir: host.paths.providerStatusCacheDir,
        config: {
          cwd: request.cwd,
          mode: "approval-required",
          environment: request.modelSelection.instanceId,
          project: request.cwd,
          helper: true,
        },
      });
      const state = yield* connection.request({ type: "get_state" });
      if (
        !nativeObject(state) ||
        state.sessionFile !== undefined ||
        !Array.isArray(state.dumpTools) ||
        state.dumpTools.length !== 0
      )
        return yield* new OmpRpcError({
          operation: "helper",
          detail: "Native helper tools or persistence are enabled",
        });
      if (request.modelSelection.model !== "default") {
        const split = request.modelSelection.model.indexOf("/");
        if (split < 1 || split === request.modelSelection.model.length - 1)
          return yield* new OmpRpcError({
            operation: "helper",
            detail: "Native helper model needs provider/model identity",
          });
        yield* connection.request({
          type: "set_model",
          provider: request.modelSelection.model.slice(0, split),
          modelId: request.modelSelection.model.slice(split + 1),
        });
      }
      const text = yield* collectOmpText(connection, request.prompt);
      return yield* Operations.decodeJsonReply(request, "OMP", text);
    },
    (effect, request) =>
      effect.pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: request.operation,
              detail: "OMP restricted generation failed",
              cause,
            }),
        ),
      ),
  );
  return Operations.fromRunner("OMP", Operations.withoutInvestigation("OMP", runner));
});
