import {
  canonicalProjectWorkPayload,
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  type ProjectTeamRecord,
  type ProjectWorkPublicationRequest,
  type ProjectWorkPublicationOutcome,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "./ProjectWorkRepository.ts";
import { publicationRequestHash } from "./github/ProjectWorkGitHubOutbox.ts";
import * as Invalidation from "./ProjectWorkEvidenceInvalidation.ts";

const at = "2026-10-06T00:00:00.000Z";
const p = ProjectId.make("pr-evidence-project");
const t = ProjectWorkTaskId.make("pr-evidence-task");
const human = {
  actor: { kind: "human" as const, id: "maintainer" },
  source: { kind: "web" as const },
  recordedAt: at,
};
const base = "a".repeat(40);
const head = "b".repeat(40);
const input = {
  projectId: p,
  provider: "github",
  host: "github.com",
  repository: "owner/repo",
  number: 42,
};
const fresh = {
  number: 42,
  url: "https://github.com/owner/repo/pull/42",
  baseRevision: base,
  headRevision: head,
};
const fields = { projectId: p, revision: 0, generation: 0, updatedAt: at };
const evidence: Extract<ProjectTeamRecord, { kind: "evidence-applicability" }> = {
  ...fields,
  kind: "evidence-applicability",
  recordId: "tested-evidence",
  status: "current",
  taskId: t,
  evidenceId: "raw-evidence",
  specRevision: 0,
  planRevision: 0,
  repository: "owner/repo",
  worktree: "/fixture",
  testedTree: "tested-tree",
  testedCommit: head,
  baseSha: base,
  headSha: head,
  command: "vp test run focused.test.ts",
  exitCode: 0,
  artifactId: "raw-log",
  environmentSummary: "Fixture",
  integration: true,
};
const gate: Extract<ProjectTeamRecord, { kind: "gate" }> = {
  ...fields,
  kind: "gate",
  recordId: "merge-gate",
  status: "approved",
  taskId: t,
  gate: "merge",
  specRevision: 0,
  planRevision: 0,
  contentHash: "content",
  attribution: human,
  repository: "owner/repo",
  pullRequestNumber: 42,
  headSha: head,
  targetBranch: "main",
  mergeMethod: "squash",
  evidenceIds: [evidence.recordId],
};
const request: ProjectWorkPublicationRequest = {
  version: 1,
  kind: "create-pr",
  operationId: "retained-publication",
  marker: "opaque-marker-one",
  repository: { host: "github.com", nodeId: "R_owner", nameWithOwner: "owner/repo" },
  target: {
    projectId: p,
    taskId: t,
    specRevision: 0,
    planRevision: 0,
    scopeHash: "scope",
    baseSha: base,
    headSha: head,
    baseRef: "main",
    headRef: "feature",
    headRepositoryNodeId: "R_owner",
    headSelector: "feature",
  },
  expectedTaskRevision: 0,
  authorizationRecordIds: ["tested-evidence"],
  title: "Task",
  body: "Body",
};
const receipt: Extract<ProjectWorkPublicationOutcome, { kind: "confirmed" }> = {
  version: 1,
  operationId: request.operationId,
  requestHash: publicationRequestHash(request),
  claimGeneration: 1,
  observedAt: at,
  kind: "confirmed",
  marker: request.marker,
  repository: request.repository,
  pullRequest: {
    nodeId: "PR_42",
    number: 42,
    url: fresh.url,
    state: "OPEN",
    baseSha: base,
    headSha: head,
    baseRef: "main",
    headRef: "feature",
    headRepositoryNodeId: "R_owner",
  },
};
const setup = Effect.gen(function* () {
  const repository = yield* ProjectWorkRepository;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${p},'Fixture','/fixture','[]',${at},${at})`;
  yield* repository.execute({
    type: "project-work.task.create",
    projectId: p,
    taskId: t,
    commandId: CommandId.make("create-task"),
    title: "Task",
    createdAt: at,
  });
  yield* repository.execute({
    type: "project-work.foundation.commit",
    projectId: p,
    commandId: CommandId.make("seed-foundation"),
    expectedRevision: 1,
    committedAt: at,
    attribution: human,
    records: [
      {
        ...fields,
        kind: "limits",
        recordId: "limits",
        status: "configured",
        environmentModelCalls: 1,
        projectWritableWorkers: 1,
        modelCalls: 1,
        delegationDepth: 1,
        repairAllowance: 1,
        model: "fixture",
        tokenLimit: 100,
        durationLimitMs: 100,
      },
      {
        ...fields,
        kind: "task-membership",
        recordId: "membership",
        status: "active",
        taskId: t,
        executionKind: "managed",
        deliverableKind: "code",
      },
      evidence,
      gate,
    ],
  });
  const effect = {
    ...fields,
    kind: "effect",
    recordId: request.operationId,
    effectId: request.operationId,
    revision: 2,
    status: "succeeded",
    effectKind: "publication",
    taskId: t,
    targetId: "github.com/owner/repo",
    payload: {
      recordIds: request.authorizationRecordIds,
      expectedRevision: 0,
      summary: canonicalProjectWorkPayload(request),
    },
    claimGeneration: 1,
    availableAt: at,
    outcome: canonicalProjectWorkPayload(receipt),
  };
  yield* sql`INSERT INTO project_team_effect
    (record_id,project_id,status,revision,generation,updated_at,task_id,unique_key,payload_json)
    VALUES (${request.operationId},${p},'succeeded',2,0,${at},${t},${request.operationId},${canonicalProjectWorkPayload(effect)})`;
  return { repository, sql, service: yield* Invalidation.ProjectWorkEvidenceInvalidation };
});
const services = Layer.mergeAll(
  ProjectWorkRepositoryLive,
  Authorization.layer,
  ServerSettingsService.layerTest({ projectWorkEnabled: true, projectTeamExecutionEnabled: true }),
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
const runtime = Invalidation.layer.pipe(Layer.provideMerge(services));

it.effect("unrelated historical PRs do not consume the exact PR publication bound", () =>
  Effect.gen(function* () {
    const { service, sql } = yield* setup;
    yield* sql`
      WITH RECURSIVE generated(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM generated WHERE value<129)
      INSERT INTO project_team_effect
        SELECT printf('other-publication-%03d',value),project_id,status,revision,generation,updated_at,task_id,attempt_id,member_id,source_id,scope_key,slot,
          printf('other-publication-%03d',value),provider_instance_id,thread_id,session_id,
          json_set(payload_json,'$.outcome',json_set(${canonicalProjectWorkPayload(receipt)},'$.pullRequest.number',1000+value))
        FROM project_team_effect,generated WHERE record_id=${request.operationId}`;
    expect(yield* service.capture(input)).toBeDefined();
  }).pipe(Effect.provide(runtime)),
);

it.effect("exact PR candidate overflow is unavailable instead of silently truncating history", () =>
  Effect.gen(function* () {
    const { service, sql, repository } = yield* setup;
    yield* sql`
      WITH RECURSIVE generated(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM generated WHERE value<128)
      INSERT INTO project_team_effect
        SELECT printf('same-publication-%03d',value),project_id,status,revision,generation,updated_at,task_id,attempt_id,member_id,source_id,scope_key,slot,
          printf('same-publication-%03d',value),provider_instance_id,thread_id,session_id,payload_json
        FROM project_team_effect,generated WHERE record_id=${request.operationId}`;
    const before = yield* repository.replay(p);
    expect(yield* service.capture(input).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "unavailable" },
    });
    expect(yield* repository.replay(p)).toEqual(before);
  }).pipe(Effect.provide(runtime)),
);

it.effect(
  "valid physical evidence payload tampering cannot replace canonical tested provenance",
  () =>
    Effect.gen(function* () {
      const { service, sql, repository } = yield* setup;
      yield* sql`UPDATE project_team_evidence_applicability SET payload_json=json_set(payload_json,'$.command','forged test command')`;
      const captured = yield* service.capture(input);
      expect(captured).toBeDefined();
      if (!captured) return;
      const before = yield* repository.replay(p);
      expect(
        yield* service
          .invalidate(captured, { ...fresh, headRevision: "c".repeat(40) })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "changed" } });
      expect(yield* repository.replay(p)).toEqual(before);
      expect(
        (yield* readCurrentState(sql, p)).foundationRecords?.find(
          (record) => record.recordId === evidence.recordId,
        ),
      ).toEqual(evidence);
    }).pipe(Effect.provide(runtime)),
);

it.effect("feature disablement during a remote read rejects its captured observation", () =>
  Effect.gen(function* () {
    const { service, repository } = yield* setup;
    const captured = yield* service.capture(input);
    expect(captured).toBeDefined();
    if (!captured) return;
    yield* (yield* ServerSettingsService).updateSettings({ projectTeamExecutionEnabled: false });
    const before = yield* repository.replay(p);
    expect(
      yield* service
        .invalidate(captured, { ...fresh, headRevision: "c".repeat(40) })
        .pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { reason: "changed" } });
    expect(yield* repository.replay(p)).toEqual(before);
  }).pipe(Effect.provide(runtime)),
);

it.effect(
  "fresh head movement atomically removes evidence and merge qualification without replacing tested payloads",
  () =>
    Effect.gen(function* () {
      const { service, sql, repository } = yield* setup;
      const captured = yield* service.capture(input);
      expect(captured).toBeDefined();
      if (!captured) return;
      expect(yield* service.invalidate(captured, { ...fresh, headRevision: "c".repeat(40) })).toBe(
        2,
      );
      const state = yield* readCurrentState(sql, p);
      expect(state.foundationRecords?.find((r) => r.recordId === evidence.recordId)).toEqual({
        ...evidence,
        status: "stale",
        revision: 1,
        updatedAt: expect.any(String),
      });
      expect(state.foundationRecords?.find((r) => r.recordId === gate.recordId)).toEqual({
        ...gate,
        status: "invalidated",
        revision: 1,
        updatedAt: expect.any(String),
      });
      const events = yield* repository.replay(p);
      expect(events.slice(-2).map((event) => event.type)).toEqual([
        "project-work.foundation.recorded",
        "project-work.foundation.recorded",
      ]);
      expect(
        yield* sql`SELECT actor_kind AS actorKind,actor_id AS actorId,source_kind AS sourceKind,source_id AS sourceId
      FROM project_work_command_receipts WHERE project_id=${p} AND actor_id='project-work-pr-observer'`,
      ).toEqual([
        {
          actorKind: "system",
          actorId: "project-work-pr-observer",
          sourceKind: "system",
          sourceId: "project-work-pr-observer",
        },
      ]);
    }).pipe(Effect.provide(runtime)),
);

it.effect("unchanged revisions and missing or foreign host observations do not write", () =>
  Effect.gen(function* () {
    const { service, repository } = yield* setup;
    const captured = yield* service.capture(input);
    expect(captured).toBeDefined();
    if (!captured) return;
    const before = yield* repository.replay(p);
    for (const observation of [
      fresh,
      { ...fresh, baseRevision: undefined },
      { ...fresh, headRevision: undefined },
      { ...fresh, headRevision: "branch-name" },
      { ...fresh, number: 43 },
      { ...fresh, url: "https://github.com/other/repo/pull/42", headRevision: "c".repeat(40) },
      { ...fresh, url: "https://other.example/owner/repo/pull/42", headRevision: "c".repeat(40) },
    ])
      expect(yield* service.invalidate(captured, observation)).toBe(0);
    expect(yield* repository.replay(p)).toEqual(before);
  }).pipe(Effect.provide(runtime)),
);

it.effect("base movement invalidates only the exact task repository and PR gates", () =>
  Effect.gen(function* () {
    const { service, repository, sql } = yield* setup;
    const otherTask = ProjectWorkTaskId.make("other-task");
    const state = yield* readCurrentState(sql, p);
    yield* repository.execute({
      type: "project-work.task.create",
      projectId: p,
      taskId: otherTask,
      commandId: CommandId.make("other-task-create"),
      title: "Other task",
      createdAt: at,
    });
    const foreignEvidence = { ...evidence, recordId: "other-task-evidence", taskId: otherTask };
    const otherPrGate = { ...gate, recordId: "other-pr-gate", pullRequestNumber: 99 };
    const otherRepositoryEvidence = {
      ...evidence,
      recordId: "other-repository-evidence",
      repository: "other/repo",
    };
    yield* repository.execute({
      type: "project-work.foundation.commit",
      projectId: p,
      commandId: CommandId.make("other-target-records"),
      expectedRevision: state.revision + 1,
      records: [foreignEvidence, otherPrGate, otherRepositoryEvidence],
      attribution: human,
      committedAt: at,
    });
    const captured = yield* service.capture(input);
    expect(captured).toBeDefined();
    if (!captured) return;
    expect(yield* service.invalidate(captured, { ...fresh, baseRevision: "c".repeat(64) })).toBe(2);
    const after = yield* readCurrentState(sql, p);
    expect(after.foundationRecords?.find((r) => r.recordId === foreignEvidence.recordId)).toEqual(
      foreignEvidence,
    );
    expect(after.foundationRecords?.find((r) => r.recordId === otherPrGate.recordId)).toEqual(
      otherPrGate,
    );
    expect(
      after.foundationRecords?.find((r) => r.recordId === otherRepositoryEvidence.recordId),
    ).toEqual(otherRepositoryEvidence);
  }).pipe(Effect.provide(runtime)),
);

it.effect("a captured response cannot invalidate a newer foundation revision", () =>
  Effect.gen(function* () {
    const { service, repository, sql } = yield* setup;
    const captured = yield* service.capture(input);
    expect(captured).toBeDefined();
    if (!captured) return;
    const state = yield* readCurrentState(sql, p);
    const newer = { ...evidence, revision: 1, updatedAt: "2026-10-06T01:00:00.000Z" };
    yield* repository.execute({
      type: "project-work.foundation.commit",
      projectId: p,
      commandId: CommandId.make("newer-evidence"),
      expectedRevision: state.revision,
      records: [newer],
      committedAt: newer.updatedAt,
      attribution: human,
    });
    const before = yield* repository.replay(p);
    const result = yield* service
      .invalidate(captured, { ...fresh, headRevision: "c".repeat(40) })
      .pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "changed" } });
    expect(yield* repository.replay(p)).toEqual(before);
    expect(
      (yield* readCurrentState(sql, p)).foundationRecords?.find(
        (r) => r.recordId === evidence.recordId,
      ),
    ).toEqual(newer);
  }).pipe(Effect.provide(runtime)),
);

it.effect("new captures after service replacement retain replay idempotence", () =>
  Effect.gen(function* () {
    const { service, repository } = yield* setup;
    const captured = yield* service.capture(input);
    expect(captured).toBeDefined();
    if (!captured) return;
    const moved = { ...fresh, headRevision: "c".repeat(40) };
    yield* service.invalidate(captured, moved);
    const before = yield* repository.replay(p);
    const restarted = yield* Invalidation.ProjectWorkEvidenceInvalidation.pipe(
      Effect.provide(Layer.fresh(Invalidation.layer)),
    );
    const repeated = yield* restarted.capture(input);
    expect(repeated).toBeDefined();
    if (!repeated) return;
    expect(yield* restarted.invalidate(repeated, moved)).toBe(0);
    expect(yield* repository.replay(p)).toEqual(before);
  }).pipe(Effect.provide(runtime)),
);

for (const mutation of [
  "invalid-json",
  "wrong-project",
  "wrong-task",
  "wrong-status",
  "wrong-revision",
  "wrong-generation",
  "wrong-number",
  "wrong-repository",
  "corrupt-outcome",
  "duplicate",
] as const)
  it.effect(`cannot select targets from ${mutation} publication history`, () =>
    Effect.gen(function* () {
      const { service, repository, sql } = yield* setup;
      if (mutation === "invalid-json") yield* sql`UPDATE project_team_effect SET payload_json='{'`;
      else if (mutation === "wrong-project")
        yield* sql`UPDATE project_team_effect SET project_id='foreign-project'`;
      else if (mutation === "wrong-task")
        yield* sql`UPDATE project_team_effect SET task_id='foreign-task'`;
      else if (mutation === "wrong-status")
        yield* sql`UPDATE project_team_effect SET status='pending'`;
      else if (mutation === "wrong-revision") yield* sql`UPDATE project_team_effect SET revision=3`;
      else if (mutation === "wrong-generation")
        yield* sql`UPDATE project_team_effect SET generation=1`;
      else if (mutation === "wrong-number")
        yield* sql`UPDATE project_team_effect SET payload_json=json_set(payload_json,'$.outcome',${canonicalProjectWorkPayload({ ...receipt, pullRequest: { ...receipt.pullRequest, number: 43 } })})`;
      else if (mutation === "wrong-repository")
        yield* sql`UPDATE project_team_effect SET payload_json=json_set(payload_json,'$.outcome',${canonicalProjectWorkPayload({ ...receipt, repository: { ...receipt.repository, nameWithOwner: "other/repo" } })})`;
      else if (mutation === "corrupt-outcome")
        yield* sql`UPDATE project_team_effect SET payload_json=json_set(payload_json,'$.outcome','{')`;
      else {
        const duplicateRequest = { ...request, operationId: "duplicate-publication" };
        const duplicateReceipt = {
          ...receipt,
          operationId: duplicateRequest.operationId,
          requestHash: publicationRequestHash(duplicateRequest),
        };
        yield* sql`INSERT INTO project_team_effect
          SELECT 'duplicate-publication',project_id,status,revision,generation,updated_at,task_id,attempt_id,member_id,source_id,scope_key,slot,'duplicate-publication',provider_instance_id,thread_id,session_id,
            json_set(payload_json,'$.recordId','duplicate-publication','$.effectId','duplicate-publication','$.payload.summary',${canonicalProjectWorkPayload(duplicateRequest)},'$.outcome',${canonicalProjectWorkPayload(duplicateReceipt)})
          FROM project_team_effect WHERE record_id=${request.operationId}`;
      }
      const before = yield* repository.replay(p);
      const result = yield* service.capture(input).pipe(Effect.result);
      expect(result._tag === "Failure" || result.success === undefined).toBe(true);
      expect(yield* repository.replay(p)).toEqual(before);
    }).pipe(Effect.provide(runtime)),
  );

for (const mode of [
  "project-work-disabled",
  "team-disabled",
  "limits-disabled",
  "project-deleted",
  "membership-removed",
  "physical-evidence-corrupt",
  "physical-owner-duplicate",
  "record-overflow",
] as const)
  it.effect(`does not qualify invalidation when ${mode}`, () =>
    Effect.gen(function* () {
      const { service, repository, sql } = yield* setup;
      if (mode === "project-work-disabled" || mode === "team-disabled") {
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings(
          mode === "project-work-disabled"
            ? { projectWorkEnabled: false }
            : { projectTeamExecutionEnabled: false },
        );
      } else if (mode === "project-deleted")
        yield* sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id=${p}`;
      else if (mode === "physical-evidence-corrupt")
        yield* sql`UPDATE project_team_evidence_applicability SET payload_json='{'`;
      else if (mode === "physical-owner-duplicate")
        yield* sql`INSERT INTO project_team_mission
        (record_id,project_id,status,revision,generation,updated_at,payload_json) VALUES (${evidence.recordId},'foreign-project','active',0,0,${at},'{}')`;
      else if (mode === "record-overflow")
        yield* sql`
        WITH RECURSIVE generated(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM generated WHERE value<64)
        INSERT INTO project_team_evidence_applicability (record_id,project_id,status,revision,generation,updated_at,task_id,payload_json)
        SELECT printf('overflow-%03d',value),${p},'current',0,0,${at},${t},
          json_set(${canonicalProjectWorkPayload(evidence)},'$.recordId',printf('overflow-%03d',value)) FROM generated`;
      else {
        const state = yield* readCurrentState(sql, p);
        const kind = mode === "limits-disabled" ? "limits" : "task-membership";
        const old = state.foundationRecords?.find((record) => record.kind === kind);
        expect(old).toBeDefined();
        if (!old || (old.kind !== "limits" && old.kind !== "task-membership")) return;
        yield* repository.execute({
          type: "project-work.foundation.commit",
          projectId: p,
          commandId: CommandId.make(mode),
          expectedRevision: state.revision,
          attribution: human,
          committedAt: at,
          records: [
            old.kind === "limits"
              ? { ...old, status: "disabled", revision: 1 }
              : { ...old, status: "removed", revision: 1 },
          ],
        });
      }
      const before = yield* repository.replay(p);
      const result = yield* service.capture(input).pipe(Effect.result);
      expect(result._tag === "Failure" || result.success === undefined).toBe(true);
      expect(yield* repository.replay(p)).toEqual(before);
    }).pipe(Effect.provide(runtime)),
  );
