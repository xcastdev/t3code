import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProviderInstanceId,
  type ProjectTeamMemoryProcessIntent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../../config.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Projects from "../../orchestration-v2/ProjectStore.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as Repository from "../ProjectWorkRepository.ts";
import * as TeamAuthorization from "../ProjectTeamAuthorization.ts";
import * as Authority from "./ProjectMemoryService.ts";
import * as Processing from "./ProjectMemoryProcessing.ts";
import * as Configuration from "./ProjectMemoryConfiguration.ts";
import * as Runtime from "./ProjectMemoryRuntime.ts";
import * as Backend from "./MemoryBackend.ts";
import * as Routes from "./ProjectMemoryModelRoutes.ts";
import {
  layer as authorityLayer,
  seed,
  scope,
  captureInput,
  projectId,
  taskId,
  env,
  at,
  human,
} from "./ProjectMemoryService.test-utils.ts";
const unused = () => Effect.die("unused");
const fixture = (extract: TextGeneration.TextGeneration["Service"]["extractMemoryFacts"]) => {
  const infrastructure = Layer.mergeAll(
    authorityLayer,
    NodeServices.layer,
    ServerConfig.layerTest("/tmp", { prefix: "p12-memory-runtime-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    Layer.succeed(Environment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(env),
      getDescriptor: Effect.die("unused"),
    }),
    Layer.succeed(TeamAuthorization.ProjectTeamAuthorization, {
      assertHuman: () => Effect.void,
      assertHumanSourceControl: unused,
      assertManaged: unused,
      compile: unused,
    }),
    Layer.succeed(TextGeneration.TextGeneration, {
      generateCommitMessage: unused,
      generatePrContent: unused,
      generateBranchName: unused,
      generateThreadTitle: unused,
      generateReviewGuide: unused,
      extractMemoryFacts: extract,
    }),
    Layer.succeed(Routes.ProjectMemoryModelRoutes, { extract: unused, embed: unused }),
    Layer.succeed(Backend.MemoryBackend, { execute: unused }),
  );
  return Runtime.layer.pipe(
    Layer.provideMerge(
      Processing.layer.pipe(
        Layer.provideMerge(Configuration.layer.pipe(Layer.provideMerge(infrastructure))),
      ),
    ),
  );
};
const capture = Effect.fn("MemoryRuntimeTest.capture")(function* () {
  yield* seed();
  const repository = yield* Repository.ProjectWorkRepository;
  const sql = yield* SqlClient.SqlClient;
  const state = yield* Repository.readCurrentState(sql, projectId);
  yield* repository.execute({
    type: "project-work.foundation.commit",
    commandId: CommandId.make("limits"),
    projectId,
    expectedRevision: state.revision,
    attribution: human,
    committedAt: at,
    records: [
      {
        kind: "limits",
        recordId: "limits",
        projectId,
        revision: 0,
        generation: 0,
        updatedAt: at,
        status: "configured",
        environmentModelCalls: 1,
        projectWritableWorkers: 1,
        modelCalls: 1,
        delegationDepth: 0,
        repairAllowance: 0,
        model: "selected-native",
        providerInstanceId: ProviderInstanceId.make("chosen-instance"),
        tokenLimit: 1000,
        durationLimitMs: 1000,
      },
    ],
  });
  const memory = yield* Authority.ProjectMemoryService;
  return yield* memory.capture(captureInput());
});
const intent = (): ProjectTeamMemoryProcessIntent => ({
  type: "project-team.memory.process",
  commandId: CommandId.make("process"),
  projectId,
  taskId,
  expectedRevision: 3,
  expectedTaskRevision: 0,
  specRevision: 0,
  planRevision: 0,
  selection: captureInput().selection,
});
it.effect(
  "enqueues after committed capture and runs the exact selected native instance in recovery",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      yield* Effect.gen(function* () {
        yield* capture();
        const runtime = yield* Runtime.ProjectMemoryRuntime;
        const sql = yield* SqlClient.SqlClient;
        yield* runtime.process(intent());
        assert.equal(calls, 0);
        assert.equal(
          (yield* sql`SELECT * FROM t3_workflow_v2_memory_processing WHERE status='pending'`)
            .length,
          1,
        );
        yield* runtime.recover();
        assert.equal(calls, 1);
        assert.equal(
          (yield* sql`SELECT * FROM t3_workflow_v2_memory_observations WHERE status='current'`)
            .length,
          1,
        );
      }).pipe(
        Effect.provide(
          fixture((input) => {
            calls++;
            assert.equal(input.modelSelection.instanceId, "chosen-instance");
            assert.equal(input.modelSelection.model, "selected-native");
            return Effect.succeed({
              facts: [{ key: "testing", body: "Use focused tests", quote: "Use focused tests" }],
            });
          }),
        ),
      );
    }),
);
it.effect(
  "recovers capture-to-enqueue crash gaps and retains cleanup after actual project deletion",
  () =>
    Effect.gen(function* () {
      yield* capture();
      const runtime = yield* Runtime.ProjectMemoryRuntime;
      const sql = yield* SqlClient.SqlClient;
      yield* runtime.recover();
      assert.equal(
        (yield* sql`SELECT * FROM t3_workflow_v2_memory_observations WHERE status='current'`)
          .length,
        1,
      );
      const projects = yield* Projects.ProjectStoreV2;
      yield* projects.apply({
        sequence: 2,
        eventId: EventId.make("delete"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: at,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.deleted",
        payload: { projectId, deletedAt: at },
      });
      yield* runtime.recover();
      assert.equal(
        (yield* sql`SELECT * FROM t3_workflow_v2_memory_observations WHERE status='current'`)
          .length,
        0,
      );
      assert.equal(
        (yield* sql`SELECT * FROM t3_workflow_v2_memory_observations WHERE status='retracted'`)
          .length,
        1,
      );
      assert.equal(
        (yield* sql`SELECT * FROM t3_workflow_v2_memory_cleanup WHERE status='completed'`).length,
        1,
      );
    }).pipe(
      Effect.provide(
        fixture(() =>
          Effect.succeed({
            facts: [{ key: "testing", body: "Use focused tests", quote: "Use focused tests" }],
          }),
        ),
      ),
    ),
);
it.effect(
  "configuration CAS shares the canonical Work receipt transaction and replays without a second write",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const runtime = yield* Runtime.ProjectMemoryRuntime;
      const sql = yield* SqlClient.SqlClient;
      const state = yield* Repository.readCurrentState(sql, projectId);
      const input = {
        type: "project-team.memory.configure" as const,
        commandId: CommandId.make("configure"),
        projectId,
        expectedRevision: state.revision,
        owner: scope.owner,
        ownerRevision: 0,
        expectedConfigurationRevision: 0,
        configuration: {},
      };
      const principal = { actor: human.actor, source: human.source, projectId };
      yield* runtime.configure(input, principal);
      yield* runtime.configure(input, principal);
      assert.equal(
        (yield* sql<{
          revision: number;
        }>`SELECT revision FROM t3_workflow_v2_memory_configuration`)[0]?.revision,
        1,
      );
      assert.equal(
        (yield* sql`SELECT * FROM t3_workflow_v2_work_evidence WHERE evidence_id LIKE 'memory-configuration:%'`)
          .length,
        1,
      );
    }).pipe(Effect.provide(fixture(unused))),
);
