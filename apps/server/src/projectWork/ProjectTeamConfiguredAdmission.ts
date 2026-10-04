import * as NodeCrypto from "node:crypto";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  canonicalProjectWorkPayload,
  CommandId,
  EnvironmentId,
  ProjectTeamRecord,
  ProjectWorkAttemptId,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkTask,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { decideProjectWorkCommand, type ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { projectTeamConfigurationGeneration } from "./ProjectTeamConfiguration.ts";
import { resolveProjectTeamLimits } from "./ProjectTeamLimits.ts";
import {
  projectTeamDerivedRecordId,
  projectTeamScopeHash,
  projectTeamSpecificationHash,
} from "./ProjectTeamPolicy.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import type { ProjectTeamDispatchRequest } from "./ProjectTeamDispatchJournal.ts";

const pathService = Effect.runSync(Effect.provide(Path.Path, NodePath.layer));
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Positive = Safe.check(Schema.isGreaterThan(0));
const Id = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256));
const Ids = Schema.Array(Id).check(
  Schema.isMaxLength(64),
  Schema.makeFilter((ids) => new Set(ids).size === ids.length),
);
const Absolute = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter(
    (value) =>
      pathService.isAbsolute(value) &&
      pathService.normalize(value) === value &&
      !/[\0\r\n]/u.test(value),
  ),
);
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Timestamp = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value;
  }),
);
const RootCaps = Schema.Struct({
  maximumDelegationDepth: Safe.check(Schema.isLessThanOrEqualTo(8)),
  repairAllowance: Safe.check(Schema.isLessThanOrEqualTo(16)),
  environmentModelCalls: Positive.check(Schema.isLessThanOrEqualTo(128)),
  projectWritableWorkers: Safe.check(Schema.isLessThanOrEqualTo(64)),
  modelCalls: Positive.check(Schema.isLessThanOrEqualTo(128)),
});
const Facts = Schema.Struct({
  environmentId: EnvironmentId,
  provider: Schema.Struct({
    instanceId: ProviderInstanceId,
    driverKind: Schema.String,
    enabled: Schema.Boolean,
    runtimeVersion: Schema.String,
    maxInputTokens: Positive.check(Schema.isLessThanOrEqualTo(1_000_000)),
    maxOutputTokens: Positive.check(Schema.isLessThanOrEqualTo(65_536)),
    catalogue: Schema.Struct({
      source: Schema.Literal("https://api.commandcode.ai/provider/v1/models"),
      fetchedAt: Timestamp,
      selectedEntry: Schema.Struct({
        id: Schema.Literal("inclusionai/ling-3.1-flash:free"),
        owned_by: Schema.Literal("command-code"),
        context_length: Positive,
        supported_endpoints: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(
          Schema.isMaxLength(32),
        ),
        max_output_tokens: Schema.optional(Positive),
      }),
    }),
  }),
  supportedToolIds: Ids,
  ownedSkillIds: Ids,
  git: Schema.Struct({
    primaryRoot: Absolute,
    commonGitDirectory: Absolute,
    worktreePath: Absolute,
    branchRef: Id,
    baseRef: Id,
    baseOid: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
    policyHash: Digest,
    writable: Schema.Boolean,
  }),
  rootAnchor: Schema.Union([
    Schema.TaggedStruct("NewRoot", {}),
    Schema.TaggedStruct("RetainedRoot", {
      budget: Schema.Struct({
        rootTaskId: ProjectWorkTaskId,
        maximumTokens: Positive,
        deadlineAtMs: Positive,
      }),
      caps: RootCaps,
    }),
  ]),
});
/** Captured by Root from its actual registered runtime, owned skills, Git and durable budget.
 * This snapshot grants no authority; Root revalidates it in the reservation transaction. */
export type ProjectTeamConfiguredAdmissionFacts = typeof Facts.Type;
type Role = Extract<ProjectTeamRecord, { kind: "role-revision" }>;
type Limits = Extract<ProjectTeamRecord, { kind: "limits" }>;
type Member = Extract<ProjectTeamRecord, { kind: "member" }>;
type Plan = Extract<ProjectTeamRecord, { kind: "plan-revision" }>;
type Gate = Extract<ProjectTeamRecord, { kind: "gate" }>;
type Run = Extract<ProjectTeamRecord, { kind: "run-binding" }>;
type Membership = Extract<ProjectTeamRecord, { kind: "task-membership" }>;
const validSafe = Schema.is(Safe);
const validPositive = Schema.is(Positive);
const validRecord = Schema.is(ProjectTeamRecord);
const validTask = Schema.is(ProjectWorkTask);
const decodeFacts = Schema.decodeUnknownSync(Facts, { onExcessProperty: "error" });
const decodeClaim = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand, {
  onExcessProperty: "error",
});
function reject(reason: string): never {
  throw new ProjectWorkPolicyError("authority-required", reason);
}
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const sorted = <T extends { readonly recordId: string }>(records: ReadonlyArray<T>) =>
  [...records].sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  canonicalProjectWorkPayload([...a].sort()) === canonicalProjectWorkPayload([...b].sort());
const initialRoles = [
  "coordinator",
  "investigator",
  "planner",
  "implementer",
  "reviewer",
  "integrator",
] as const;

/** Produces an uncommitted request only. Root reads the original durable request before
 * calling this for new work, preserving its exact timestamps across lost responses. */
export const prepareProjectTeamConfiguredAdmission = (input: {
  readonly state: ProjectWorkReducerState;
  readonly taskId: ProjectWorkTaskId;
  readonly nowMs: number;
  readonly facts: ProjectTeamConfiguredAdmissionFacts;
}):
  | { readonly _tag: "Prepared"; readonly request: ProjectTeamDispatchRequest }
  | { readonly _tag: "Blocked"; readonly reason: string } => {
  try {
    const facts = decodeFacts(input.facts);
    const { state, taskId, nowMs } = input;
    if (
      !validSafe(state.revision) ||
      state.revision === Number.MAX_SAFE_INTEGER ||
      !validPositive(nowMs)
    )
      reject("Unsafe project revision or admission time");
    const provider = facts.provider;
    const entry = provider.catalogue.selectedEntry;
    const fetchedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(provider.catalogue.fetchedAt));
    if (
      !provider.enabled ||
      provider.driverKind !== "piAgent" ||
      provider.runtimeVersion !== "0.99.1"
    )
      reject("Current enabled pinned Pi runtime is required");
    if (
      fetchedAt > nowMs ||
      nowMs - fetchedAt >= 86_400_000 ||
      !entry.supported_endpoints.includes("/chat/completions")
    )
      reject("Current supported CommandCode catalogue is required");
    if (
      entry.max_output_tokens !== undefined &&
      (entry.max_output_tokens > entry.context_length ||
        provider.maxOutputTokens > entry.max_output_tokens)
    )
      reject("Actual Pi output limit exceeds supported metadata");
    const routeReservation = provider.maxInputTokens + provider.maxOutputTokens;
    if (!validPositive(routeReservation) || routeReservation > entry.context_length)
      reject("Actual Pi reservation exceeds model context");
    const records = state.foundationRecords ?? [];
    if (new Set(records.map((r) => r.recordId)).size !== records.length)
      reject("Ambiguous foundation identity");
    const checked = <T extends ProjectTeamRecord>(record: T): T => {
      if (
        !validRecord(record) ||
        record.projectId !== state.projectId ||
        !validSafe(record.revision) ||
        !validSafe(record.generation) ||
        record.revision === Number.MAX_SAFE_INTEGER
      )
        reject("Invalid current foundation record");
      return record;
    };
    const knownTask = (id: ProjectWorkTaskId) => {
      const matches = state.tasks.filter((task) => task.taskId === id);
      const task = matches[0];
      if (
        matches.length !== 1 ||
        task === undefined ||
        task.projectId !== state.projectId ||
        !validTask(task) ||
        !validSafe(task.revision) ||
        task.revision === Number.MAX_SAFE_INTEGER ||
        !validSafe(task.specRevision)
      )
        reject("Invalid current task");
      return task!;
    };
    const task = knownTask(taskId);
    const lineage: Membership[] = [];
    const ancestorTasks: ProjectWorkTask[] = [];
    const seen = new Set<string>();
    let rootTaskId = taskId;
    for (;;) {
      if (seen.has(rootTaskId) || seen.size >= 9) reject("Invalid task ancestry");
      seen.add(rootTaskId);
      ancestorTasks.push(knownTask(rootTaskId));
      const matches = records.filter(
        (r): r is Membership => r.kind === "task-membership" && r.taskId === rootTaskId,
      );
      const membership = matches[0];
      if (matches.length !== 1 || membership === undefined)
        reject("Current task membership is required");
      checked(membership!);
      if (
        membership!.status !== "active" ||
        membership!.executionKind === "legacy" ||
        (membership!.controlState !== undefined && membership!.controlState !== "active")
      )
        reject("Task ancestry is inactive");
      lineage.push(membership!);
      if (membership!.parentTaskId === undefined) break;
      rootTaskId = membership!.parentTaskId;
    }
    const membership = lineage[0]!;
    if (membership.executionKind !== "managed" || membership.assignment === undefined)
      reject("Explicit active managed assignment is required");
    const assignment = membership.assignment!;
    const grants = records.filter(
      (r): r is Gate => r.kind === "gate" && r.recordId === assignment.authorizationGateId,
    );
    if (grants.length !== 1) reject("Exact assignment authorization is required");
    const grant = checked(grants[0]!);
    if (
      grant.taskId !== taskId ||
      grant.attribution.actor.kind !== "human" ||
      (grant.status !== "approved" && grant.status !== "consumed")
    )
      reject("Current human authorization is required");
    const configurationGeneration = projectTeamConfigurationGeneration(state);
    if (!validPositive(configurationGeneration))
      reject("Human-installed configuration is required");
    const policies = records.filter(
      (r): r is Limits => r.kind === "limits" && r.status === "configured",
    );
    if (policies.length === 0 || policies.length > 6)
      reject("Current configured policies are required");
    for (const policy of policies) {
      checked(policy);
      if (
        policy.generation !== configurationGeneration ||
        policy.providerInstanceId !== provider.instanceId ||
        policy.profileRecordIds?.length !== 6 ||
        !validPositive(policy.tokenLimit) ||
        !validPositive(policy.durationLimitMs) ||
        !validPositive(policy.environmentModelCalls) ||
        !validPositive(policy.modelCalls)
      )
        reject("Configuration policy generation or provider changed");
      if (!sameIds(policy.profileRecordIds, policies[0]!.profileRecordIds ?? []))
        reject("Configured profile lineage differs");
    }
    const profileIds = policies[0]!.profileRecordIds!;
    if (new Set(profileIds).size !== 6) reject("Configured profiles are ambiguous");
    const roles = profileIds.map((id) => {
      const role = records.find((r): r is Role => r.kind === "role-revision" && r.recordId === id);
      if (role === undefined) reject("Configured profile is missing");
      checked(role!);
      if (
        role!.status !== "available" ||
        role!.generation !== configurationGeneration ||
        !validSafe(role!.roleRevision) ||
        role!.model === "unconfigured" ||
        policies.filter((p) => p.model === role!.model).length !== 1
      )
        reject("Configured profile is retired or unconfigured");
      return role!;
    });
    if (initialRoles.some((name) => roles.filter((r) => r.role === name).length !== 1))
      reject("Six current configured roles are required");
    const members = roles.map((role) => {
      const matches = records.filter(
        (r): r is Member =>
          r.kind === "member" && r.roleRevisionId === role.recordId && r.status !== "retired",
      );
      if (matches.length !== 1) reject("Configured member is missing or ambiguous");
      const member = checked(matches[0]!);
      if (
        member.status !== "active" ||
        member.generation !== configurationGeneration ||
        member.coordinator !== (role.role === "coordinator")
      )
        reject("Configured member generation is inactive");
      return member;
    });
    const defaultRole =
      membership.deliverableKind === "research"
        ? "investigator"
        : membership.deliverableKind === "plan"
          ? "planner"
          : membership.deliverableKind === "review"
            ? "reviewer"
            : membership.deliverableKind === "code"
              ? "implementer"
              : undefined;
    if (defaultRole === undefined) reject("Assignment requires explicit supported role selection");
    const member =
      membership.requestedSuccessorMemberId === undefined
        ? members[roles.findIndex((r) => r.role === defaultRole)]!
        : members.find((m) => m.recordId === membership.requestedSuccessorMemberId);
    if (member === undefined) reject("Exact requested successor is not a configured active member");
    const role = roles.find((r) => r.recordId === member!.roleRevisionId)!;
    if (
      membership.deliverableKind === "code"
        ? role.role !== "implementer" && role.role !== "integrator"
        : role.role !== defaultRole
    )
      reject("Successor role does not match assignment");
    const policy = policies.find((p) => p.model === role.model)!;
    if (role.model !== entry.id) reject("Configured model is unavailable on the actual Pi route");
    if (
      new Set(role.tools).size !== role.tools.length ||
      role.tools.some((id) => !facts.supportedToolIds.includes(id))
    )
      reject("Configured tools are unsupported");
    if (!sameIds(role.skills, facts.ownedSkillIds) || role.skills.length > 32)
      reject("Exact owned configured skills are unavailable");
    const writable = role.role === "implementer" || role.role === "integrator";
    if (
      role.role === "integrator" &&
      !role.tools.some((tool) => ["pi.write", "pi.edit", "pi.bash"].includes(tool))
    )
      reject("Integrator requires the journal's configured writable tool capability");
    if (facts.git.writable !== writable)
      reject("Measured workspace access does not match the configured role");
    if (
      writable &&
      (facts.git.worktreePath === facts.git.primaryRoot ||
        facts.git.worktreePath.startsWith(facts.git.primaryRoot + pathService.sep) ||
        facts.git.primaryRoot.startsWith(facts.git.worktreePath + pathService.sep))
    )
      reject("Writable work requires a separate isolated assigned worktree");
    if (!facts.git.branchRef.startsWith("refs/heads/") || !facts.git.baseRef.startsWith("refs/"))
      reject("Assigned Git references are invalid");
    const runs = records.filter((r): r is Run => r.kind === "run-binding" && seen.has(r.taskId));
    for (const run of runs) checked(run);
    const belongsToRoot = (id: ProjectWorkTaskId) => {
      const visited = new Set<string>();
      let current = id;
      for (let depth = 0; depth < 9; depth++) {
        if (current === rootTaskId) return true;
        if (visited.has(current)) return false;
        visited.add(current);
        const parent = records.find((r) => r.kind === "task-membership" && r.taskId === current);
        if (parent?.kind !== "task-membership" || parent.parentTaskId === undefined) return false;
        current = parent.parentTaskId;
      }
      return false;
    };
    if (
      facts.rootAnchor._tag === "NewRoot" &&
      (records.some((r) => r.kind === "run-binding" && belongsToRoot(r.taskId)) ||
        state.attempts.some((attempt) => belongsToRoot(attempt.taskId)))
    )
      reject("Existing lineage requires its retained root anchor");
    const prior = runs.filter((run) => run.taskId === taskId);
    const highestGeneration = prior.reduce(
      (generation, run) => Math.max(generation, run.generation),
      -1,
    );
    if (highestGeneration >= Number.MAX_SAFE_INTEGER) reject("Lease generation is exhausted");
    const generation = highestGeneration + 1;
    const maxTokens = Math.min(
      policy.tokenLimit,
      entry.context_length,
      facts.rootAnchor._tag === "RetainedRoot"
        ? facts.rootAnchor.budget.maximumTokens
        : policy.tokenLimit,
    );
    const duration = policy.durationLimitMs;
    if (routeReservation > maxTokens)
      reject("Configured or root token budget cannot cover the actual Pi reservation");
    if (nowMs > Number.MAX_SAFE_INTEGER - duration) reject("Admission deadline overflow");
    const budget =
      facts.rootAnchor._tag === "RetainedRoot"
        ? facts.rootAnchor.budget
        : { rootTaskId, maximumTokens: maxTokens, deadlineAtMs: nowMs + duration };
    const resolved = resolveProjectTeamLimits({
      state,
      taskId,
      roleRevisionId: role.recordId,
      nowMs,
      environmentModelCalls: policy.environmentModelCalls,
      writable,
      rootBudget: budget,
      attemptConfiguration: { maxTokens, maxDurationMs: duration, paidFallback: false },
      ...(assignment.parentRunId === undefined ? {} : { parentRunId: assignment.parentRunId }),
    });
    if (resolved._tag !== "Eligible") reject(`Configured limits blocked: ${resolved.reason}`);
    const limits = resolved.frozen;
    if (facts.rootAnchor._tag === "RetainedRoot") {
      const caps = facts.rootAnchor.caps;
      if (
        limits.delegationDepth >
          Math.min(limits.maximumDelegationDepth, caps.maximumDelegationDepth) ||
        (writable && Math.min(limits.projectWritableWorkers, caps.projectWritableWorkers) === 0)
      )
        reject("Original root capacity or depth is exhausted");
    }
    const plans = records.filter(
      (r): r is Plan =>
        r.kind === "plan-revision" && r.taskId === taskId && r.status === "proposed",
    );
    for (const plan of plans) checked(plan);
    const plan = [...plans].sort((a, b) => b.planRevision - a.planRevision)[0];
    if (
      plan &&
      (!validSafe(plan.planRevision) ||
        plans.filter((p) => p.planRevision === plan.planRevision).length !== 1)
    )
      reject("Current plan revision is ambiguous");
    const specGate = records.find(
      (r): r is Gate =>
        r.kind === "gate" &&
        r.taskId === taskId &&
        r.gate === "specification" &&
        r.status === "approved" &&
        r.specRevision === task.specRevision &&
        r.planRevision === 0 &&
        r.contentHash === projectTeamSpecificationHash(state, taskId),
    );
    const planGate =
      plan === undefined
        ? undefined
        : records.find(
            (r): r is Gate =>
              r.kind === "gate" &&
              r.taskId === taskId &&
              r.gate === "plan" &&
              r.status === "approved" &&
              r.specRevision === task.specRevision &&
              r.planRevision === plan.planRevision &&
              r.contentHash === plan.contentHash,
          );
    if (specGate) checked(specGate);
    if (planGate) checked(planGate);
    const episodes = records.filter(
      (r) =>
        r.kind === "repair-episode" &&
        (r.rootTaskId ?? r.taskId) === rootTaskId &&
        r.status !== "resolved" &&
        r.pendingSemanticRepair !== false,
    );
    const episode = grant.status === "consumed" && episodes.length === 1 ? episodes[0] : undefined;
    if (episode) checked(episode);
    const exception =
      episode?.kind === "repair-episode" && episode.exceptionGrantId !== undefined
        ? records.find(
            (r): r is Gate => r.kind === "gate" && r.recordId === episode.exceptionGrantId,
          )
        : undefined;
    if (exception) checked(exception);
    if (
      episode?.kind === "repair-episode" &&
      exception === undefined &&
      episode.semanticRepairs >=
        Math.min(
          policy.repairAllowance,
          facts.rootAnchor._tag === "RetainedRoot"
            ? facts.rootAnchor.caps.repairAllowance
            : policy.repairAllowance,
        )
    )
      reject("Original configured automatic repair allowance is exhausted");
    const lineageKey = hash(
      canonicalProjectWorkPayload({
        projectId: state.projectId,
        taskId,
        ancestorTasks,
        memberships: lineage,
        grant,
        roles: sorted(roles),
        members: sorted(members),
        policies: sorted(policies),
        generation,
        plan,
        specGate,
        planGate,
        episode,
        exception,
        parentRuns: sorted(runs),
        provider: {
          ...provider,
          catalogue: { source: provider.catalogue.source, selectedEntry: entry },
        },
        ownedSkillIds: [...facts.ownedSkillIds].sort(),
        git: facts.git,
        rootAnchor: facts.rootAnchor,
        environmentId: facts.environmentId,
      }),
    );
    const id = (suffix: string) => projectTeamDerivedRecordId(lineageKey, suffix);
    const commandId = CommandId.make(id("claim"));
    const dispatchId = id("dispatch");
    const runId = id("run");
    const attemptId = ProjectWorkAttemptId.make(id("attempt"));
    const committedAt = iso(nowMs);
    const maxDurationMs = limits.deadlineAtMs - nowMs;
    // DateTime must represent the entire bounded lease; safe integers alone include
    // instants outside the calendar range supported by the existing wire timestamp.
    const leasedUntil = iso(limits.deadlineAtMs);
    const claim = decodeClaim({
      type: "project-work.foundation.commit",
      commandId,
      projectId: state.projectId,
      expectedRevision: state.revision,
      attribution: {
        actor: { kind: "system", id: "project-team-scheduler" },
        source: { kind: "system", id: dispatchId },
        recordedAt: committedAt,
      },
      records: [],
      committedAt,
      transition: {
        kind: "claim",
        taskId,
        expectedTaskRevision: task.revision,
        authorizationGateId: grant.recordId,
        expectedGateRevision: grant.revision,
        claim: {
          type: "project-work.task.claim",
          commandId,
          projectId: state.projectId,
          taskId,
          attemptId,
          expectedRevision: state.revision,
          leaseToken: id("lease"),
          claimedAt: committedAt,
          leasedUntil,
        },
        binding: {
          kind: "run-binding",
          recordId: runId,
          projectId: state.projectId,
          revision: 0,
          generation,
          updatedAt: committedAt,
          status: "reserved",
          taskId,
          attemptId,
          memberId: member!.recordId,
          roleRevisionId: role.recordId,
          providerInstanceId: provider.instanceId,
          threadId: ThreadId.make(id("thread")),
          environmentId: facts.environmentId,
          model: role.model,
          configuration: {
            instructionsHash: hash(role.instructions),
            toolIds: role.tools,
            skillIds: role.skills,
            runtimeVersion: provider.runtimeVersion,
            maxTokens: limits.attemptMaximumTokens,
            maxDurationMs,
            paidFallback: false,
          },
          worktree: facts.git.worktreePath,
          branch: facts.git.branchRef,
          leaseGeneration: generation,
          specRevision: task.specRevision,
          planRevision: plan?.planRevision ?? 0,
          authorizationGateId: grant.recordId,
          ...(specGate === undefined ? {} : { specificationGateId: specGate.recordId }),
          ...(planGate === undefined ? {} : { planGateId: planGate.recordId }),
          scopeHash: projectTeamScopeHash(state, taskId, plan),
          ...(assignment.parentRunId === undefined ? {} : { parentRunId: assignment.parentRunId }),
          ...(episode?.kind !== "repair-episode" ? {} : { repairEpisodeId: episode.recordId }),
        },
        ...(episode?.kind !== "repair-episode"
          ? {}
          : {
              repair: {
                episodeId: episode.recordId,
                expectedEpisodeRevision: episode.revision,
                ...(exception === undefined
                  ? {}
                  : {
                      exceptionGateId: exception.recordId,
                      expectedExceptionGateRevision: exception.revision,
                    }),
              },
            }),
      },
    });
    const events = decideProjectWorkCommand(state, claim);
    if (events.length > Number.MAX_SAFE_INTEGER - state.revision)
      reject("Project event revision is exhausted");
    const parent = grant.assignmentAuthorization?.parentTaskId;
    const parentPlanId = grant.assignmentAuthorization?.parentPlan?.recordId;
    const parentPlan =
      parentPlanId === undefined
        ? undefined
        : records.find((r) => r.kind === "plan-revision" && r.recordId === parentPlanId);
    const caps = facts.rootAnchor._tag === "RetainedRoot" ? facts.rootAnchor.caps : limits;
    const briefing = canonicalProjectWorkPayload({
      instructions: role.instructions,
      task: { taskId, title: task.title, specification: task.specification },
      plan: plan?.content,
      requiredOutputs: assignment.outputDescriptions,
      criteria: state.criteria.filter((criterion) => criterion.taskId === taskId),
      ...(parent === undefined
        ? {}
        : {
            approvedParent: knownTask(parent).specification,
            approvedParentPlan:
              parentPlan?.kind === "plan-revision" ? parentPlan.content : undefined,
          }),
      limits: {
        rootMaximumTokens: limits.maximumTokens,
        maximumTokens: limits.attemptMaximumTokens,
        deadlineAt: leasedUntil,
        maximumDelegationDepth: Math.min(
          limits.maximumDelegationDepth,
          caps.maximumDelegationDepth,
        ),
        repairAllowance: Math.min(limits.repairAllowance, caps.repairAllowance),
        environmentModelCalls: Math.min(limits.environmentModelCalls, caps.environmentModelCalls),
        projectWritableWorkers: Math.min(
          limits.projectWritableWorkers,
          caps.projectWritableWorkers,
        ),
        modelCalls: Math.min(limits.modelCalls, caps.modelCalls),
        paidFallback: false,
      },
    });
    if (Buffer.byteLength(briefing) > 131072) reject("Approved assignment exceeds its byte budget");
    const { writable: _writable, ...git } = facts.git;
    return {
      _tag: "Prepared",
      request: {
        dispatchId,
        claim,
        git: { ...git, effectId: dispatchId, runId, generation, ownershipToken: id("git-owner") },
        setupId: id("setup"),
        initializeOperationId: id("initialize"),
        assignmentOperationId: id("assignment"),
        assignment: briefing,
      },
    };
  } catch (error) {
    return {
      _tag: "Blocked",
      reason:
        error instanceof ProjectWorkPolicyError
          ? error.message
          : "Invalid configured admission snapshot",
    };
  }
};
