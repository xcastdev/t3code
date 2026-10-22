import * as Path from "effect/Path";
import {
  CommandId,
  ProjectWorkEvidenceId,
  ProjectVerificationJobManifest,
  canonicalProjectWorkPayload,
  type ProjectTeamVerificationProposal,
  type ProjectWorkWriteResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Runner from "../processRunner.ts";
import * as Repository from "./ProjectWorkRepository.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as Sources from "./ProjectTeamIntegrationSources.ts";
import * as Reviews from "./ProjectTeamReviewFreshness.ts";
import { currentVerificationPlan } from "./ProjectWorkVerificationState.ts";
import * as Verification from "./ProjectWorkVerification.ts";
import * as Executable from "./ProjectWorkVerificationExecutable.ts";
import {
  projectTeamSpecificationHash,
  projectTeamPlanHash,
  projectTeamScopeHash,
} from "./ProjectTeamPolicy.ts";
import type { ProjectWorkPrincipal } from "./ProjectWorkGateway.ts";
import { verificationError } from "./ProjectWorkVerificationError.ts";

export class ProjectWorkVerificationGateway extends Context.Service<
  ProjectWorkVerificationGateway,
  {
    readonly propose: (
      input: ProjectTeamVerificationProposal,
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<ProjectWorkWriteResult, Verification.ProjectWorkVerificationError>;
    readonly execute: (
      projectId: string,
      jobId: string,
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<void, Verification.ProjectWorkVerificationError>;
  }
>()("t3/projectWork/ProjectWorkVerificationGateway") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const verification = yield* Verification.ProjectWorkVerification;
  const repository = yield* Repository.ProjectWorkRepository;
  const authorization = yield* Authorization.ProjectTeamAuthorization;
  const sources = yield* Sources.ProjectTeamIntegrationSources;
  const reviews = yield* Reviews.ProjectTeamReviewFreshness;
  const threads = yield* Threads.ThreadManagementService;
  const runner = yield* Runner.ProcessRunner;
  const environment = yield* Environment.ServerEnvironment;
  const paths = yield* Path.Path;
  const assertHuman = (principal: ProjectWorkPrincipal) =>
    authorization
      .assertHuman(principal)
      .pipe(Effect.mapError(() => verificationError("authority")));
  const current = Effect.fn("ProjectWorkVerificationGateway.current")(
    function* (manifest: ProjectVerificationJobManifest, approved: boolean) {
      const state = yield* Repository.readCurrentState(sql, manifest.projectId);
      const task = state.tasks.find((t) => t.taskId === manifest.taskId);
      const binding = state.foundationRecords?.find(
        (r) => r.kind === "run-binding" && r.recordId === manifest.bindingId,
      );
      const plan = yield* Effect.try({
        try: () =>
          currentVerificationPlan(
            state,
            manifest.taskId,
            manifest.specRevision,
            manifest.planRevision,
          ),
        catch: () => verificationError("authority"),
      });
      const admissions = yield* sql<{
        snapshot_json: string;
        fence: number;
        uncertain: number;
      }>`SELECT snapshot_json,fence,uncertain FROM t3_workflow_v2_run_admissions WHERE binding_id=${manifest.bindingId} AND run_id=${manifest.runId} AND run_attempt_id=${manifest.runAttemptId}`;
      if (
        task === undefined ||
        task.specRevision !== manifest.specRevision ||
        binding?.kind !== "run-binding" ||
        binding.generation !== manifest.generation ||
        binding.leaseGeneration !== manifest.generation ||
        binding.specRevision !== manifest.specRevision ||
        binding.planRevision !== manifest.planRevision ||
        binding.scopeHash !== projectTeamScopeHash(state, manifest.taskId, plan) ||
        binding.runId !== manifest.runId ||
        binding.runAttemptId !== manifest.runAttemptId ||
        binding.nodeId !== manifest.nodeId ||
        binding.worktree !== manifest.target.worktree ||
        !["running", "stopping", "settled"].includes(binding.status) ||
        plan?.kind !== "plan-revision" ||
        projectTeamSpecificationHash(state, manifest.taskId) !== manifest.specificationHash ||
        projectTeamPlanHash(plan) !== manifest.planHash ||
        admissions.length !== 1 ||
        admissions[0]!.uncertain !== 0 ||
        admissions[0]!.fence !== manifest.generation ||
        Executable.verificationSha256(admissions[0]!.snapshot_json) !==
          manifest.workspaceReceiptHash ||
        manifest.criteria.some(
          (c) =>
            !state.criteria.some(
              (actual) =>
                actual.criterionId === c.criterionId &&
                actual.taskId === manifest.taskId &&
                actual.revision === c.revision,
            ),
        )
      )
        return yield* verificationError("authority");
      if (plan.integrationSources !== undefined) {
        yield* sources.assertCurrent(state, {
          integrationTaskId: manifest.taskId,
          sources: plan.integrationSources,
        });
        const coverage = yield* sources.coverage(state, plan.integrationSources);
        if (
          manifest.integration !== true ||
          canonicalProjectWorkPayload(manifest.integrationCoverage) !==
            canonicalProjectWorkPayload(coverage)
        )
          return yield* verificationError("authority");
      } else if (manifest.integration !== undefined || manifest.integrationCoverage !== undefined)
        return yield* verificationError("authority");
      if (
        approved &&
        !(state.foundationRecords ?? []).some(
          (r) =>
            r.kind === "gate" &&
            r.gate === "verification" &&
            r.status === "approved" &&
            r.verificationJobId === manifest.jobId &&
            r.contentHash ===
              Executable.verificationSha256(canonicalProjectWorkPayload(manifest)) &&
            r.specRevision === manifest.specRevision &&
            r.planRevision === manifest.planRevision &&
            r.attribution.actor.kind === "human",
        )
      )
        return yield* verificationError("authority");
      return state;
    },
    Effect.mapError(() => verificationError("authority")),
  );
  const propose = Effect.fn("ProjectWorkVerificationGateway.propose")(
    function* (input: ProjectTeamVerificationProposal, principal: ProjectWorkPrincipal) {
      yield* assertHuman(principal);
      const state = yield* Repository.readCurrentState(sql, input.projectId);
      const task = state.tasks.find((t) => t.taskId === input.taskId);
      const binding = state.foundationRecords?.find(
        (r) => r.kind === "run-binding" && r.recordId === input.bindingId,
      );
      const plan = yield* Effect.try({
        try: () =>
          currentVerificationPlan(state, input.taskId, input.specRevision, input.planRevision),
        catch: () => verificationError("authority"),
      });
      if (
        state.revision !== input.expectedRevision ||
        task?.revision !== input.expectedTaskRevision ||
        task.specRevision !== input.specRevision ||
        binding?.kind !== "run-binding" ||
        binding.revision !== input.expectedBindingRevision ||
        binding.generation !== input.generation ||
        binding.worktree === null ||
        binding.runId === undefined ||
        binding.runAttemptId === undefined ||
        binding.nodeId === undefined ||
        plan?.kind !== "plan-revision"
      )
        return yield* verificationError("authority");
      const projection = yield* threads.getThreadProjection(binding.threadId);
      const run = projection.runs.find((r) => r.id === binding.runId);
      const node = projection.nodes.find((n) => n.id === binding.nodeId);
      if (
        run === undefined ||
        node?.checkpointScopeId === null ||
        node?.checkpointScopeId === undefined
      )
        return yield* verificationError("authority");
      const journals = yield* sql<{
        dispatch_id: string;
        request_json: string;
      }>`SELECT dispatch_id,request_json FROM t3_workflow_v2_team_dispatches WHERE binding_id=${binding.recordId} AND generation=${binding.generation}`;
      const admissions = yield* sql<{
        snapshot_json: string;
      }>`SELECT snapshot_json FROM t3_workflow_v2_run_admissions WHERE binding_id=${binding.recordId} AND run_id=${binding.runId} AND run_attempt_id=${binding.runAttemptId}`;
      if (journals.length !== 1 || admissions.length !== 1)
        return yield* verificationError("authority");
      const git = Effect.fn("ProjectWorkVerificationGateway.git")(function* (
        args: readonly string[],
      ) {
        const output = yield* runner.run({
          command: "git",
          args: ["-c", "core.hooksPath=/dev/null", ...args],
          cwd: binding.worktree!,
          maxOutputBytes: 8192,
        });
        if (output.code !== 0 || output.stdoutTruncated || output.stderrTruncated)
          return yield* verificationError("changed-target");
        return output.stdout.trim();
      });
      const dispatch = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(importedDispatchSchema),
      )(journals[0]!.request_json);
      const head = yield* git(["rev-parse", "HEAD"]);
      const base = yield* git([
        "rev-parse",
        dispatch.workspace.type === "worktree"
          ? dispatch.workspace.baseRef
          : "refs/remotes/origin/HEAD",
      ]);
      if (plan.integrationSources !== undefined) {
        for (const source of plan.integrationSources.sources)
          yield* reviews.assertPhysical(input.projectId, source.jobId);
      }
      const coverage =
        plan.integrationSources === undefined
          ? undefined
          : yield* sources.coverage(state, plan.integrationSources);
      const manifest = yield* verification.capture(
        {
          version: 1,
          ...(coverage === undefined
            ? {}
            : { integration: true as const, integrationCoverage: coverage }),
          jobId: input.jobId,
          environmentId: yield* environment.getEnvironmentId,
          projectId: input.projectId,
          taskId: input.taskId,
          specRevision: input.specRevision,
          specificationHash: projectTeamSpecificationHash(state, input.taskId),
          planRevision: input.planRevision,
          planHash: projectTeamPlanHash(plan),
          criteria: input.criterionIds.map((id) => ({
            criterionId: id,
            revision:
              state.criteria.find((c) => c.criterionId === id && c.taskId === input.taskId)
                ?.revision ?? -1,
          })),
          runId: binding.runId,
          runAttemptId: binding.runAttemptId,
          nodeId: binding.nodeId,
          checkpointScopeId: node.checkpointScopeId,
          ...(run.checkpointId === null ? {} : { checkpointId: run.checkpointId }),
          dispatchId: journals[0]!.dispatch_id,
          bindingId: binding.recordId,
          generation: binding.generation,
          workspaceReceiptHash: Executable.verificationSha256(admissions[0]!.snapshot_json),
          command: input.command,
          target: {
            repository: paths.dirname(
              yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
            ),
            worktree: binding.worktree,
            branchRef: yield* git(["symbolic-ref", "HEAD"]),
            baseSha: base,
            headSha: head,
            testedCommit: head,
            testedTree: yield* git(["rev-parse", "HEAD^{tree}"]),
            workspaceState: "clean-committed",
          },
        },
        yield* Executable.supportedVerificationRuntimeFiles(input.command, binding.worktree),
      );
      yield* verification.prepare(
        {
          manifest,
          runtimeFiles: yield* Executable.supportedVerificationRuntimeFiles(
            input.command,
            binding.worktree,
          ),
        },
        current(manifest, false).pipe(Effect.asVoid),
      );
      const at = DateTime.formatIso(yield* DateTime.now);
      const attribution = { actor: principal.actor, source: principal.source, recordedAt: at };
      const gateId = `verification:${input.jobId}`;
      const result = yield* repository.executeAuthorized(
        {
          type: "project-work.foundation.commit",
          commandId: input.commandId,
          projectId: input.projectId,
          expectedRevision: input.expectedRevision,
          attribution,
          committedAt: at,
          records: [],
        },
        () =>
          Effect.gen(function* () {
            yield* assertHuman(principal);
            yield* current(manifest, false);
            return {
              type: "project-work.foundation.commit" as const,
              commandId: input.commandId,
              projectId: input.projectId,
              expectedRevision: input.expectedRevision,
              attribution,
              committedAt: at,
              records: [
                {
                  kind: "gate" as const,
                  recordId: gateId,
                  projectId: input.projectId,
                  taskId: input.taskId,
                  revision: 0,
                  generation: input.generation,
                  updatedAt: at,
                  status: "proposed" as const,
                  gate: "verification" as const,
                  specRevision: input.specRevision,
                  planRevision: input.planRevision,
                  contentHash: Executable.verificationSha256(canonicalProjectWorkPayload(manifest)),
                  verificationJobId: input.jobId,
                  evidenceIds: [],
                  attribution,
                },
              ],
            };
          }),
      );
      return result.writeResult;
    },
    Effect.mapError(() => verificationError("authority")),
  );
  const execute = Effect.fn("ProjectWorkVerificationGateway.execute")(
    function* (projectId: string, jobId: string, principal: ProjectWorkPrincipal) {
      yield* assertHuman(principal);
      yield* verification.execute(projectId, jobId, {
        assertCurrent: (manifest) =>
          assertHuman(principal).pipe(
            Effect.andThen(current(manifest, true)),
            Effect.asVoid,
            Effect.mapError(() => verificationError("authority")),
          ),
        applyEvidence: Effect.fn("ProjectWorkVerificationGateway.applyEvidence")(
          function* (
            result: Verification.VerificationResult,
            manifest: ProjectVerificationJobManifest,
            markApplied: Effect.Effect<void, Verification.ProjectWorkVerificationError>,
          ) {
            const state = yield* current(manifest, true);
            const binding = state.foundationRecords?.find(
              (record) => record.kind === "run-binding" && record.recordId === manifest.bindingId,
            );
            if (binding?.kind !== "run-binding" || binding.scopeHash === undefined)
              return yield* verificationError("authority");
            const at = DateTime.formatIso(yield* DateTime.now);
            const attribution = {
              actor: principal.actor,
              source: principal.source,
              recordedAt: at,
            };
            yield* repository.executeReserved(
              {
                type: "project-work.evidence.add",
                projectId: manifest.projectId,
                commandId: CommandId.make(`verification-evidence:${jobId}`),
                expectedRevision: state.revision,
                attribution,
                addedAt: at,
                evidence: {
                  evidenceId: ProjectWorkEvidenceId.make(`verification:${jobId}`),
                  taskId: manifest.taskId,
                  scopeHash: binding.scopeHash,
                  kind: "observation",
                  summary: `Verification ${result.outcome}`,
                  detail: canonicalProjectWorkPayload({
                    jobId,
                    manifestHash: Executable.verificationSha256(
                      canonicalProjectWorkPayload(manifest),
                    ),
                    resultHash: result.sha256,
                    exitCode: result.exitCode,
                  }),
                  recordedAt: at,
                  revision: 0,
                  attribution,
                },
              },
              () => markApplied,
              Executable.verificationSha256(
                canonicalProjectWorkPayload({ jobId, resultHash: result.sha256 }),
              ),
            );
          },
          Effect.mapError(() => verificationError("authority")),
        ),
      });
    },
    Effect.mapError(() => verificationError("authority")),
  );
  return ProjectWorkVerificationGateway.of({ propose, execute });
});
import { ProjectTeamDispatchIntent as importedDispatchSchema } from "@t3tools/contracts";
export const layer = Layer.effect(ProjectWorkVerificationGateway, make);
