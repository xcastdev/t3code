import { CommandId, EventId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionTerminalCompletionWakeRepository } from "../../persistence/Services/ProjectionTerminalCompletionWakes.ts";
import { OrchestrationEngineService } from "./OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./ProjectionSnapshotQuery.ts";

export interface ProjectTerminalWakeRequest {
  readonly projectId: ProjectId;
  readonly terminalId: string;
  readonly generation: string;
  readonly threadId: ThreadId;
  readonly label: string;
  readonly status: "exited" | "killed";
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
}

export interface ProjectTerminalWakeServiceShape {
  readonly serverRunId: string;
  readonly request: (input: ProjectTerminalWakeRequest) => Effect.Effect<void>;
}

export class ProjectTerminalWakeService extends Context.Service<
  ProjectTerminalWakeService,
  ProjectTerminalWakeServiceShape
>()("t3/orchestration/Services/ProjectTerminalWakeService") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const wakes = yield* ProjectionTerminalCompletionWakeRepository;
  const snapshots = yield* Effect.serviceOption(ProjectionSnapshotQuery);
  const serverRunId = yield* crypto.randomUUIDv4;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  yield* wakes.cancelOtherServerRuns({
    serverRunId,
    updatedAt: yield* nowIso,
  });
  const unknownWakes = yield* wakes.listUnknown({ limit: 1000 });
  yield* Effect.forEach(
    unknownWakes,
    (wake) =>
      Effect.gen(function* () {
        if (Option.isSome(snapshots)) {
          const thread = yield* snapshots.value.getThreadShellById(wake.threadId);
          if (Option.isNone(thread) || thread.value.projectId !== wake.projectId) return;
        }
        const stableId = `terminal-completion-wake-unknown:${wake.dedupeKey}`;
        yield* engine
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(stableId),
            threadId: wake.threadId,
            createdAt: wake.updatedAt,
            activity: {
              id: EventId.make(stableId),
              tone: "error",
              kind: "terminal.project.wake.unknown",
              summary: "Terminal completion wake outcome is unknown",
              payload: {
                projectId: wake.projectId,
                terminalId: wake.terminalId,
                label: wake.label,
                detail: "The provider outcome could not be confirmed. This wake was not resent.",
              },
              turnId: null,
              createdAt: wake.updatedAt,
            },
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to restore unknown terminal completion activity", {
                threadId: wake.threadId,
                terminalId: wake.terminalId,
                cause: String(cause),
              }),
            ),
          );
      }),
    { concurrency: 1, discard: true },
  );

  const request: ProjectTerminalWakeServiceShape["request"] = (input) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const dedupeKey = [input.projectId, input.terminalId, input.generation]
        .map((part) => `${String(part).length}:${String(part)}`)
        .join("");
      yield* engine
        .dispatch({
          type: "thread.terminal-completion.request",
          commandId: CommandId.make(`terminal-completion-wake:${dedupeKey}`),
          threadId: input.threadId,
          projectId: input.projectId,
          terminalId: input.terminalId,
          generation: input.generation,
          serverRunId,
          dedupeKey,
          label: input.label,
          status: input.status,
          exitCode: input.exitCode,
          exitSignal: input.exitSignal,
          createdAt,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to persist project terminal completion wake", {
              terminalId: input.terminalId,
              generation: input.generation,
              cause: String(cause),
            }),
          ),
        );
    });

  return ProjectTerminalWakeService.of({ serverRunId, request });
});

export const ProjectTerminalWakeServiceLive = Layer.effect(ProjectTerminalWakeService, make);
