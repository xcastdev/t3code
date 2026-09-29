import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionTerminalCompletionWakeRepository } from "../../persistence/Services/ProjectionTerminalCompletionWakes.ts";
import type { ProjectionTerminalCompletionWake } from "../../persistence/Services/ProjectionTerminalCompletionWakes.ts";
import { OrchestrationEngineService } from "./OrchestrationEngine.ts";
import {
  ProjectTerminalWakeService,
  ProjectTerminalWakeServiceLive,
} from "./ProjectTerminalWakeService.ts";

const unknownWake: ProjectionTerminalCompletionWake = {
  dedupeKey: "recovered-claimed-wake",
  threadId: ThreadId.make("recovered-origin-thread"),
  projectId: ProjectId.make("recovered-project"),
  terminalId: "recovered-terminal",
  generation: "recovered-generation",
  serverRunId: "previous-server-run",
  label: "Build terminal",
  status: "exited",
  exitCode: 1,
  exitSignal: null,
  deliveryStatus: "unknown",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:01:00.000Z",
};

const recoveryCommands: OrchestrationCommand[] = [];

const recoveryLayer = ProjectTerminalWakeServiceLive.pipe(
  Layer.provideMerge(
    Layer.succeed(ProjectionTerminalCompletionWakeRepository, {
      recordRequest: () => Effect.void,
      listPendingByThread: () => Effect.succeed([]),
      listPendingByServerRun: () => Effect.succeed([]),
      listUnknown: () => Effect.succeed([unknownWake]),
      claim: () => Effect.succeed(null),
      setStatus: () => Effect.void,
      cancelOtherServerRuns: () => Effect.void,
      cancelThread: () => Effect.void,
    }),
  ),
  Layer.provideMerge(
    Layer.mock(OrchestrationEngineService, {
      dispatch: (command) =>
        Effect.sync(() => {
          recoveryCommands.push(command);
          return { sequence: 1 };
        }),
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(recoveryLayer)("ProjectTerminalWakeService recovery", (it) => {
  it.effect("emits a stable unknown activity for a recovered claim without resending it", () =>
    Effect.gen(function* () {
      const wakeService = yield* ProjectTerminalWakeService;
      assert.notEqual(wakeService.serverRunId, "previous-server-run");
      assert.equal(recoveryCommands.length, 1);
      const command = recoveryCommands[0];
      assert.equal(command?.type, "thread.activity.append");
      if (command?.type !== "thread.activity.append") return;
      assert.equal(command.commandId, "terminal-completion-wake-unknown:recovered-claimed-wake");
      assert.equal(command.threadId, unknownWake.threadId);
      assert.equal(command.activity.id, "terminal-completion-wake-unknown:recovered-claimed-wake");
      assert.equal(command.activity.kind, "terminal.project.wake.unknown");
      assert.match(command.activity.summary, /outcome is unknown/);

      const request = {
        projectId: ProjectId.make("recovered-project"),
        threadId: ThreadId.make("recovered-origin-thread"),
        terminalId: "new-terminal",
        generation: "new-generation",
        label: "Test terminal",
        status: "killed" as const,
        exitCode: null,
        exitSignal: 9,
      };
      yield* wakeService.request(request);
      assert.equal(recoveryCommands.length, 2);
      const persistedWake = recoveryCommands[1];
      assert.equal(persistedWake?.type, "thread.terminal-completion.request");
      if (persistedWake?.type !== "thread.terminal-completion.request") return;
      assert.equal(persistedWake.threadId, request.threadId);
      assert.equal(persistedWake.projectId, request.projectId);
      assert.equal(persistedWake.terminalId, request.terminalId);
      assert.equal(persistedWake.generation, request.generation);
      assert.equal(persistedWake.serverRunId, wakeService.serverRunId);
      assert.equal(
        persistedWake.dedupeKey,
        [request.projectId, request.terminalId, request.generation]
          .map((part) => `${String(part).length}:${String(part)}`)
          .join(""),
      );
    }),
  );
});
