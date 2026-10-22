import {
  ProjectId,
  ProjectTeamIntegrationSourceRef,
  ProjectWorkPublicationRequest,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sources from "./ProjectTeamIntegrationSources.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Host from "./ProjectWorkPublicationHost.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import {
  PublicationDecision,
  PublicationError,
  publicationHash,
} from "./ProjectWorkPublicationJournal.ts";

export const PublicationInput = Schema.Struct({
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  projectId: ProjectId,
  taskId: ProjectTeamIntegrationSourceRef.fields.taskId,
  gateId: Schema.String,
  sourceRef: ProjectTeamIntegrationSourceRef,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  body: Schema.String.check(Schema.isMaxLength(32000)),
});
export type PublicationInput = typeof PublicationInput.Type;
export class ProjectWorkPublicationAuthorization extends Context.Service<
  ProjectWorkPublicationAuthorization,
  {
    readonly prepare: (
      input: PublicationInput,
    ) => Effect.Effect<PublicationDecision, PublicationError>;
    readonly assertReviewed: (
      decision: PublicationDecision,
    ) => Effect.Effect<void, PublicationError>;
    readonly assertCurrent: (
      decision: PublicationDecision,
    ) => Effect.Effect<void, PublicationError>;
  }
>()("t3/projectWork/ProjectWorkPublicationAuthorization") {}
const isPublicationError = Schema.is(PublicationError);
const boundary = (cause: unknown) =>
  isPublicationError(cause) ? cause : new PublicationError({ reason: "stale", cause });
const decodeRequest = Schema.decodeUnknownEffect(ProjectWorkPublicationRequest);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environmentId = yield* (yield* Environment.ServerEnvironment).getEnvironmentId;
  const sources = yield* Sources.ProjectTeamIntegrationSources;
  const host = yield* Host.ProjectWorkPublicationHost;
  const assertReviewed = Effect.fn("ProjectWorkPublicationAuthorization.assertReviewed")(function* (
    decision: PublicationDecision,
  ) {
    const state = yield* readCurrentState(sql, decision.request.target.projectId);
    const task = state.tasks.find((t) => t.taskId === decision.request.target.taskId);
    const gate = state.foundationRecords?.find(
      (r) => r.kind === "gate" && r.recordId === decision.gate.recordId,
    );
    if (
      !task ||
      task.revision !== decision.request.expectedTaskRevision ||
      task.specRevision !== decision.request.target.specRevision ||
      !gate ||
      canonicalProjectWorkPayload(gate) !== canonicalProjectWorkPayload(decision.gate) ||
      gate.kind !== "gate" ||
      gate.status !== "approved"
    )
      return yield* new PublicationError({ reason: "stale" });
    const source = yield* sources.qualify(state, decision.sourceRef);
    if (canonicalProjectWorkPayload(source) !== canonicalProjectWorkPayload(decision.source))
      return yield* new PublicationError({ reason: "stale" });
    if (decision.integrationSources)
      yield* sources.assertCurrent(state, {
        integrationTaskId: task.taskId,
        sources: decision.integrationSources,
      });
  }, Effect.mapError(boundary));
  const assertCurrent = Effect.fn("ProjectWorkPublicationAuthorization.assertCurrent")(function* (
    decision: PublicationDecision,
  ) {
    yield* assertReviewed(decision);
    yield* host.assertCurrent(decision);
  });
  const prepare = Effect.fn("ProjectWorkPublicationAuthorization.prepare")(function* (
    input: PublicationInput,
  ) {
    const state = yield* readCurrentState(sql, input.projectId);
    const task = state.tasks.find((t) => t.taskId === input.taskId);
    const gate = state.foundationRecords?.find(
      (r) => r.kind === "gate" && r.recordId === input.gateId,
    );
    const source = yield* sources.qualify(state, input.sourceRef);
    if (
      !task ||
      source.taskId !== task.taskId ||
      !gate ||
      gate.kind !== "gate" ||
      gate.status !== "approved" ||
      gate.taskId !== task.taskId ||
      gate.specRevision !== source.specRevision ||
      gate.planRevision !== source.planRevision ||
      gate.contentHash !== source.scopeHash ||
      gate.headSha !== source.headSha ||
      gate.targetBranch === undefined ||
      gate.gate !== "publication"
    )
      return yield* new PublicationError({ reason: "authorization" });
    const captured = yield* host.capture({
      projectId: input.projectId,
      source,
      baseRef: gate.targetBranch,
    });
    if (
      gate.repository !== captured.repository.nameWithOwner ||
      gate.targetBranch !== captured.baseRef
    )
      return yield* new PublicationError({ reason: "stale" });
    const plan = state.foundationRecords?.find(
      (r) =>
        r.kind === "plan-revision" &&
        r.taskId === task.taskId &&
        r.specRevision === source.specRevision &&
        r.planRevision === source.planRevision,
    );
    const request = yield* decodeRequest({
      version: 1,
      kind: "create-pr",
      operationId: input.operationId,
      marker: publicationHash({
        environmentId,
        projectId: input.projectId,
        operationId: input.operationId,
      }),
      repository: captured.repository,
      target: {
        projectId: input.projectId,
        taskId: task.taskId,
        specRevision: source.specRevision,
        planRevision: source.planRevision,
        scopeHash: source.scopeHash,
        baseSha: source.baseSha,
        headSha: source.headSha,
        baseRef: captured.baseRef,
        headRef: source.branchRef,
        headRepositoryNodeId: captured.headRepositoryNodeId,
        headSelector: captured.headSelector,
      },
      expectedTaskRevision: task.revision,
      authorizationRecordIds: [gate.recordId],
      title: input.title,
      body: input.body,
    });
    const decision: PublicationDecision = {
      request,
      cwd: captured.cwd,
      providerId: captured.providerId,
      account: captured.account,
      gate,
      source,
      sourceRef: input.sourceRef,
      ...(plan?.kind === "plan-revision" && plan.integrationSources
        ? { integrationSources: plan.integrationSources }
        : {}),
    };
    yield* assertCurrent(decision);
    return decision;
  }, Effect.mapError(boundary));
  return ProjectWorkPublicationAuthorization.of({ prepare, assertCurrent, assertReviewed });
});
export const layer = Layer.effect(ProjectWorkPublicationAuthorization, make);
