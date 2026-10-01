import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  type ProjectTeamRecord,
  type ProjectWorkTask,
} from "@t3tools/contracts";
import type { ProjectWorkState } from "./ProjectWorkPolicy.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";

type Gate = Extract<ProjectTeamRecord, { kind: "gate" }>;
type Membership = Extract<ProjectTeamRecord, { kind: "task-membership" }>;
type Plan = Extract<ProjectTeamRecord, { kind: "plan-revision" }>;
const scopeDigest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
export const projectTeamDerivedRecordId = (commandId: string, suffix: string) =>
  `guided:${scopeDigest([commandId, suffix])}`;

/** Managed history remains a fence after assignment removal or run retirement. */
export const isGuidedProjectTeamTask = (state: ProjectWorkState, taskId: string) =>
  (state.foundationRecords ?? []).some(
    (record) =>
      (record.kind === "task-membership" &&
        record.taskId === taskId &&
        record.executionKind !== "legacy") ||
      (record.kind === "run-binding" && record.taskId === taskId),
  );

export const projectTeamSpecificationHash = (state: ProjectWorkState, taskId: string) => {
  const task = state.tasks.find((entry) => entry.taskId === taskId);
  return scopeDigest({
    specification: task?.specification,
    criteria: state.criteria
      .filter((entry) => entry.taskId === taskId)
      .map((entry) => ({
        criterionId: entry.criterionId,
        description: entry.description,
        required: entry.required,
        waiver: entry.waiver,
      }))
      .sort((a, b) => (a.criterionId < b.criterionId ? -1 : a.criterionId > b.criterionId ? 1 : 0)),
  });
};

export const projectTeamPlanHash = (plan: Pick<Plan, "content" | "dependencyTaskIds">) =>
  scopeDigest({ content: plan.content, dependencyTaskIds: [...plan.dependencyTaskIds].sort() });

export const projectTeamScopeHash = (state: ProjectWorkState, taskId: string, plan?: Plan) =>
  scopeDigest({
    specificationHash: projectTeamSpecificationHash(state, taskId),
    plan:
      plan === undefined
        ? undefined
        : {
            planRevision: plan.planRevision,
            contentHash: projectTeamPlanHash(plan),
            dependencyTaskIds: [...plan.dependencyTaskIds].sort(),
          },
  });

/** Missing pre-guided anchors never grant new credentials or tool authority. */
export const assertProjectTeamRunAuthority = (
  state: ProjectWorkState,
  binding: Extract<ProjectTeamRecord, { kind: "run-binding" }>,
  role: Extract<ProjectTeamRecord, { kind: "role-revision" }>,
  issuing: boolean,
): void => {
  function deny(message: string): never {
    throw new ProjectWorkPolicyError("authority-required", message);
  }
  const records = state.foundationRecords ?? [];
  const task = state.tasks.find((t) => t.taskId === binding.taskId);
  const memberships = records.filter(
    (r): r is Membership => r.kind === "task-membership" && r.taskId === binding.taskId,
  );
  const m = memberships[0];
  if (
    memberships.length !== 1 ||
    m?.status !== "active" ||
    m.executionKind !== "managed" ||
    (m.controlState !== undefined && m.controlState !== "active")
  )
    deny("Managed assignment is not current and active");
  if (binding.status !== "running" && !(issuing && binding.status === "reserved"))
    deny("Managed run is stopping or no longer active");
  if (role.recordId !== binding.roleRevisionId || role.status !== "available")
    deny("Frozen role is no longer available");
  const member = records.find((r) => r.kind === "member" && r.recordId === binding.memberId);
  if (
    member?.kind !== "member" ||
    member.status !== "active" ||
    binding.configuration.toolIds.some((tool) => !role.tools.includes(tool)) ||
    binding.configuration.skillIds.some((skill) => !role.skills.includes(skill))
  )
    deny("Run member or frozen capabilities changed");
  const grant = records.find(
    (r): r is Gate => r.kind === "gate" && r.recordId === binding.authorizationGateId,
  );
  if (
    grant === undefined ||
    grant.projectId !== binding.projectId ||
    grant.taskId !== binding.taskId ||
    grant.status !== "consumed" ||
    grant.consumedByRunId !== binding.recordId ||
    grant.attribution.actor.kind !== "human" ||
    grant.consumedByCommandId === undefined ||
    grant.specRevision !== binding.specRevision ||
    grant.planRevision !== binding.planRevision ||
    grant.evidenceIds.length !== 0 ||
    m?.assignment?.authorizationGateId !== grant.recordId
  )
    deny("Managed run lacks its exact consumed human grant");
  const plan = records
    .filter(
      (r): r is Plan =>
        r.kind === "plan-revision" && r.taskId === binding.taskId && r.status === "proposed",
    )
    .sort((a, b) => b.planRevision - a.planRevision)[0];
  if (
    task === undefined ||
    binding.specRevision !== task.specRevision ||
    binding.planRevision !== (plan?.planRevision ?? 0) ||
    (plan !== undefined &&
      (plan.contentHash !== projectTeamPlanHash(plan) ||
        plan.specRevision !== task.specRevision)) ||
    binding.scopeHash !== projectTeamScopeHash(state, binding.taskId, plan)
  )
    deny("Frozen run scope changed");
  const dependencies = new Set(plan?.dependencyTaskIds ?? []);
  for (const rel of state.relationships) {
    if (rel.kind === "depends-on" && rel.fromTaskId === binding.taskId)
      dependencies.add(rel.toTaskId);
    if (rel.kind === "blocks" && rel.toTaskId === binding.taskId) dependencies.add(rel.fromTaskId);
  }
  for (const taskId of dependencies) {
    const result = evaluateProjectTeamDependency({
      projectId: binding.projectId,
      taskId,
      task: state.tasks.find((t) => t.taskId === taskId),
      memberships: records.filter((r): r is Membership => r.kind === "task-membership"),
    });
    if (!result.available) deny(`Run dependency changed: ${result.reason}`);
  }
  if (
    grant.gate === "investigation" ||
    (grant.gate === "repair" && m?.deliverableKind === "research" && plan === undefined)
  ) {
    if (
      m?.deliverableKind !== "research" ||
      role.role !== "investigator" ||
      plan !== undefined ||
      grant.contentHash !== binding.scopeHash ||
      binding.configuration.toolIds.some(
        (tool) => !["read", "search", "project-work", "project-work.report"].includes(tool),
      )
    )
      deny("Investigation cannot grant writable implementation authority");
  } else {
    if (grant.gate !== "execution" && grant.gate !== "repair")
      deny("Managed run has an inapplicable grant kind");
    if (plan === undefined || grant.contentHash !== binding.scopeHash)
      deny("Execution grant does not bind current plan scope");
    const targets = [
      [
        binding.specificationGateId,
        "specification",
        projectTeamSpecificationHash(state, binding.taskId),
        0,
      ],
      [binding.planGateId, "plan", plan!.contentHash, plan!.planRevision],
    ] as const;
    for (const [id, kind, hash, planRevision] of targets) {
      const gate = records.find((r): r is Gate => r.kind === "gate" && r.recordId === id);
      const result = evaluateProjectTeamGate(gate, {
        projectId: binding.projectId,
        taskId: binding.taskId,
        gate: kind,
        specRevision: binding.specRevision,
        planRevision,
        contentHash: hash,
        evidenceIds: [],
      });
      if (!result.available) deny(`Run ${kind} approval is no longer applicable`);
    }
    if (
      grant.gate === "repair" &&
      (binding.repairEpisodeId === undefined ||
        !records.some((r) => r.kind === "repair-episode" && r.recordId === binding.repairEpisodeId))
    )
      deny("Repair run lacks canonical episode history");
  }
  if (grant.gate === "repair") {
    const proof = grant.repairAuthorization;
    const episode = records.find(
      (r) => r.kind === "repair-episode" && r.recordId === proof?.episodeId,
    );
    const inherited = records.find(
      (r): r is Gate => r.kind === "gate" && r.recordId === proof?.inheritedGateId,
    );
    const predecessor = records.find(
      (r) => r.kind === "run-binding" && r.recordId === inherited?.consumedByRunId,
    );
    const seen = new Set<string>();
    let root: string = binding.taskId;
    while (true) {
      if (seen.has(root)) deny("Repair lineage has a cycle");
      seen.add(root);
      const parent = records.find((r) => r.kind === "task-membership" && r.taskId === root);
      if (parent?.kind !== "task-membership" || parent.parentTaskId === undefined) break;
      root = parent.parentTaskId;
    }
    if (
      proof === undefined ||
      proof.semanticRepairNumber < 1 ||
      binding.repairEpisodeId !== proof.episodeId ||
      episode?.kind !== "repair-episode" ||
      (episode.rootTaskId ?? episode.taskId) !== root ||
      episode.failureFingerprint !== proof.failureFingerprint ||
      episode.semanticRepairs < proof.semanticRepairNumber ||
      inherited === undefined ||
      inherited.status !== "consumed" ||
      inherited.projectId !== binding.projectId ||
      inherited.taskId !== binding.taskId ||
      inherited.contentHash !== binding.scopeHash ||
      inherited.specRevision !== binding.specRevision ||
      inherited.planRevision !== binding.planRevision ||
      inherited.attribution.actor.kind !== "human" ||
      canonicalProjectWorkPayload(inherited.attribution) !==
        canonicalProjectWorkPayload(grant.attribution) ||
      predecessor?.kind !== "run-binding" ||
      predecessor.status !== "settled" ||
      !episode.attemptIds.includes(predecessor.attemptId)
    )
      deny("Repair run lacks frozen canonical debit and inherited approval provenance");
    if (proof.exceptionGateId !== undefined) {
      const exception = records.find(
        (r) => r.kind === "gate" && r.recordId === proof.exceptionGateId,
      );
      if (
        exception?.kind !== "gate" ||
        exception.status !== "consumed" ||
        exception.gate !== "repair" ||
        exception.attribution.actor.kind !== "human" ||
        exception.consumedByRunId !== binding.recordId ||
        exception.consumedByCommandId !== grant.consumedByCommandId
      )
        deny("Repair exception is not owned by this exact run and debit");
    } else if (proof.semanticRepairNumber > episode.allowance)
      deny("Repair debit exceeded its automatic allowance");
  }
};
export type ProjectTeamGateTarget = Pick<
  Gate,
  | "projectId"
  | "taskId"
  | "gate"
  | "specRevision"
  | "planRevision"
  | "contentHash"
  | "evidenceIds"
  | "repository"
  | "pullRequestNumber"
  | "headSha"
  | "targetBranch"
  | "mergeMethod"
>;

type ProjectTeamPolicyReason =
  | "missing-gate"
  | "gate-not-approved"
  | "human-approval-required"
  | "stale-gate-target"
  | "invalid-gate-evidence"
  | "stale-gate-evidence"
  | "invalid-merge-target"
  | "stale-merge-target"
  | "missing-dependency"
  | "dependency-project-mismatch"
  | "dependency-task-mismatch"
  | "dependency-not-completed"
  | "dependency-membership-removed"
  | "ambiguous-dependency-membership"
  | "delivery-proof-required";

export type ProjectTeamPolicyResult =
  | { readonly available: true }
  | { readonly available: false; readonly reason: ProjectTeamPolicyReason };

const unavailable = (reason: ProjectTeamPolicyReason): ProjectTeamPolicyResult => ({
  available: false,
  reason,
});
const validText = (text: string | undefined) =>
  text !== undefined && text.length > 0 && text.length <= 4_000 && text === text.trim();
const validEvidenceIds = (ids: ReadonlyArray<string>) =>
  ids.length <= 64 &&
  new Set(ids).size === ids.length &&
  ids.every((id) => validText(id) && id.length <= 256);
const validMergeTarget = (target: ProjectTeamGateTarget) =>
  validText(target.repository) &&
  validText(target.headSha) &&
  validText(target.targetBranch) &&
  target.pullRequestNumber !== undefined &&
  Number.isSafeInteger(target.pullRequestNumber) &&
  target.pullRequestNumber > 0 &&
  (target.mergeMethod === "merge" ||
    target.mergeMethod === "squash" ||
    target.mergeMethod === "rebase");

/** The caller resolves the current target and content hash from trusted server authority. */
export const evaluateProjectTeamGate = (
  gate: Gate | undefined,
  target: ProjectTeamGateTarget,
): ProjectTeamPolicyResult => {
  if (gate === undefined) return unavailable("missing-gate");
  if (gate.status !== "approved") return unavailable("gate-not-approved");
  if (gate.attribution.actor.kind !== "human") return unavailable("human-approval-required");
  if (
    gate.projectId !== target.projectId ||
    gate.taskId !== target.taskId ||
    gate.gate !== target.gate ||
    gate.specRevision !== target.specRevision ||
    gate.planRevision !== target.planRevision ||
    gate.contentHash !== target.contentHash
  ) {
    return unavailable("stale-gate-target");
  }
  if (!validEvidenceIds(gate.evidenceIds) || !validEvidenceIds(target.evidenceIds)) {
    return unavailable("invalid-gate-evidence");
  }
  const expectedEvidence = new Set(target.evidenceIds);
  if (
    gate.evidenceIds.length !== expectedEvidence.size ||
    gate.evidenceIds.some((id) => !expectedEvidence.has(id))
  ) {
    return unavailable("stale-gate-evidence");
  }
  if (target.gate === "merge") {
    if (!validMergeTarget(gate) || !validMergeTarget(target)) {
      return unavailable("invalid-merge-target");
    }
    if (
      gate.repository !== target.repository ||
      gate.pullRequestNumber !== target.pullRequestNumber ||
      gate.headSha !== target.headSha ||
      gate.targetBranch !== target.targetBranch ||
      gate.mergeMethod !== target.mergeMethod
    ) {
      return unavailable("stale-merge-target");
    }
  }
  return { available: true };
};

/** Managed code needs a future authoritative delivery receipt; completion or approval cannot prove merge. */
export const evaluateProjectTeamDependency = (input: {
  readonly projectId: ProjectWorkTask["projectId"];
  readonly taskId: ProjectWorkTask["taskId"];
  readonly task: ProjectWorkTask | undefined;
  readonly memberships: ReadonlyArray<Membership>;
}): ProjectTeamPolicyResult => {
  const { task, taskId, projectId } = input;
  if (task === undefined) return unavailable("missing-dependency");
  if (task.projectId !== projectId) return unavailable("dependency-project-mismatch");
  if (task.taskId !== taskId) return unavailable("dependency-task-mismatch");
  const memberships = input.memberships.filter((membership) => membership.taskId === taskId);
  if (memberships.some((membership) => membership.projectId !== projectId)) {
    return unavailable("dependency-project-mismatch");
  }
  if (memberships.length > 1) return unavailable("ambiguous-dependency-membership");
  const membership = memberships[0];
  if (membership?.status === "removed") return unavailable("dependency-membership-removed");
  if (task.state !== "completed") return unavailable("dependency-not-completed");
  if (membership?.executionKind === "managed" && membership.deliverableKind === "code") {
    return unavailable("delivery-proof-required");
  }
  return { available: true };
};
