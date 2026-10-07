import {
  canonicalProjectWorkPayload,
  ProjectId,
  type ProjectTeamIntegrationSource,
  type ProjectWorkTaskId,
} from "@t3tools/contracts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import {
  projectTeamPlanHash,
  projectTeamScopeHash,
  projectTeamSpecificationHash,
} from "./ProjectTeamPolicy.ts";
import { indexReviewFindings, selectReviewFindings } from "./ProjectTeamReviewResolutionRecords.ts";
const canonical = canonicalProjectWorkPayload;
/** Negative-only durable observations; successful history/artifacts still require the transaction reader. */
export function staleSourceIndex(state: ProjectWorkReducerState) {
  const tasks = new Map(state.tasks.map((task) => [String(task.taskId), task]));
  const criteria = new Map<string, Array<(typeof state.criteria)[number]>>();
  for (const criterion of state.criteria) {
    const key = String(criterion.taskId);
    const group = criteria.get(key);
    if (group) group.push(criterion);
    else criteria.set(key, [criterion]);
  }
  const records = state.foundationRecords ?? [];
  const byTask = new Map<string, Array<(typeof records)[number]>>();
  const byId = new Map<string, Array<(typeof records)[number]>>();
  for (const record of records) {
    if ("taskId" in record && record.taskId !== undefined) {
      const key = String(record.taskId);
      const group = byTask.get(key);
      if (group) group.push(record);
      else byTask.set(key, [record]);
    }
    const sameId = byId.get(record.recordId);
    if (sameId) sameId.push(record);
    else byId.set(record.recordId, [record]);
  }
  const findings = indexReviewFindings(state);
  const checked = new Map<string, boolean>();
  const inspect = (source: ProjectTeamIntegrationSource) => {
    const task = tasks.get(source.taskId),
      scoped = byTask.get(source.taskId) ?? [];
    const bindings = byId.get(source.bindingId) ?? [],
      binding = bindings[0];
    const members = scoped.filter((r) => r.kind === "task-membership"),
      member = members[0];
    const plans = scoped.filter((r) => r.kind === "plan-revision" && r.status === "proposed");
    const exactPlans = plans.filter(
        (r) =>
          r.kind === "plan-revision" &&
          r.specRevision === source.specRevision &&
          r.planRevision === source.planRevision,
      ),
      plan = exactPlans[0];
    let stale =
      task === undefined ||
      task.state === "canceled" ||
      task.state === "failed" ||
      task.specRevision !== source.specRevision ||
      members.length !== 1 ||
      member?.kind !== "task-membership" ||
      member.status !== "active" ||
      member.executionKind !== "managed" ||
      member.deliverableKind !== "code" ||
      (member.controlState !== undefined && member.controlState !== "active") ||
      member.requestedSuccessorMemberId !== undefined ||
      bindings.length !== 1 ||
      binding?.kind !== "run-binding" ||
      binding.status !== "settled" ||
      binding.projectId !== state.projectId ||
      binding.taskId !== source.taskId ||
      binding.revision !== source.bindingRevision ||
      binding.generation !== source.generation ||
      binding.branch !== source.branchRef ||
      binding.scopeHash !== source.scopeHash ||
      scoped.some(
        (r) =>
          r.kind === "run-binding" &&
          r.recordId !== source.bindingId &&
          r.generation > source.generation &&
          (byId.get(r.roleRevisionId) ?? []).some(
            (role) =>
              role.kind === "role-revision" &&
              (role.role === "implementer" || role.role === "integrator"),
          ),
      ) ||
      exactPlans.length !== 1 ||
      plan?.kind !== "plan-revision" ||
      plans.filter((r) => r.kind === "plan-revision" && r.planRevision === source.planRevision)
        .length !== 1 ||
      plans.some((r) => r.kind === "plan-revision" && r.planRevision > source.planRevision);
    if (!stale && task !== undefined && plan?.kind === "plan-revision") {
      const limited = { ...state, tasks: [task], criteria: criteria.get(source.taskId) ?? [] };
      const specificationHash = projectTeamSpecificationHash(limited, source.taskId);
      stale =
        plan.contentHash !== projectTeamPlanHash(plan) ||
        projectTeamScopeHash(limited, source.taskId, plan) !== source.scopeHash;
      for (const [kind, contentHash, revision] of [
        ["specification", specificationHash, 0],
        ["plan", plan.contentHash, source.planRevision],
      ] as const) {
        const grants = scoped.filter(
          (r) =>
            r.kind === "gate" &&
            r.gate === kind &&
            r.specRevision === source.specRevision &&
            r.planRevision === revision &&
            r.contentHash === contentHash &&
            (r.status === "approved" || r.status === "consumed") &&
            r.attribution.actor.kind === "human",
        );
        if (grants.length !== 1) stale = true;
      }
      const verification = scoped.filter(
        (r) =>
          r.kind === "gate" &&
          r.gate === "verification" &&
          r.verificationJobId === source.jobId &&
          r.contentHash === source.manifestHash &&
          r.status === "consumed" &&
          r.consumedByRunId === source.attemptId &&
          r.attribution.actor.kind === "human",
      );
      if (verification.length !== 1) stale = true;
      if (
        selectReviewFindings(findings, {
          projectId: ProjectId.make(state.projectId),
          taskId: source.taskId,
          specRevision: source.specRevision,
          planRevision: source.planRevision,
          baseSha: source.baseSha,
          headSha: source.headSha,
        }).records.some((finding) => finding.status === "open" && finding.severity === "critical")
      )
        stale = true;
    }
    return {
      stale,
      dependencies: plan?.kind === "plan-revision" ? (plan.integrationSources?.sources ?? []) : [],
    };
  };
  return (source: ProjectTeamIntegrationSource) => {
    const key = canonical(source);
    const previous = checked.get(key);
    if (previous !== undefined) return previous;
    const stack: Array<{
      source: ProjectTeamIntegrationSource;
      key: string;
      dependencies: readonly ProjectTeamIntegrationSource[];
      next: number;
      stale: boolean;
    }> = [];
    const visiting = new Set<string>();
    const enter = (next: ProjectTeamIntegrationSource) => {
      stack.push({ source: next, key: canonical(next), ...inspect(next), next: 0 });
      visiting.add(next.taskId);
    };
    enter(source);
    // Each retained source is checked once. Depth is bounded by the current task graph,
    // without a recursive call stack or a new eligibility limit.
    while (stack.length > 0) {
      const current = stack.at(-1);
      if (current === undefined) break;
      if (current.stale || current.next === current.dependencies.length) {
        checked.set(current.key, current.stale);
        visiting.delete(current.source.taskId);
        stack.pop();
        const parent = stack.at(-1);
        if (parent !== undefined && current.stale) parent.stale = true;
        continue;
      }
      const dependency = current.dependencies[current.next++];
      if (dependency === undefined) continue;
      const known = checked.get(canonical(dependency));
      if (known !== undefined) current.stale = known;
      else if (visiting.has(dependency.taskId)) current.stale = true;
      else enter(dependency);
    }
    return checked.get(key) ?? true;
  };
}
export const staleIntegrationTaskIds = (
  state: ProjectWorkReducerState,
): readonly ProjectWorkTaskId[] => {
  const stale = staleSourceIndex(state);
  const ids = new Set<ProjectWorkTaskId>();
  const plans = new Map<
    string,
    Array<
      Extract<
        NonNullable<ProjectWorkReducerState["foundationRecords"]>[number],
        { kind: "plan-revision" }
      >
    >
  >();
  for (const record of state.foundationRecords ?? [])
    if (record.kind === "plan-revision" && record.status === "proposed") {
      const group = plans.get(record.taskId);
      if (group) group.push(record);
      else plans.set(record.taskId, [record]);
    }
  for (const group of plans.values()) {
    const latest = group.reduce((revision, plan) => Math.max(revision, plan.planRevision), -1);
    const current = group.filter((plan) => plan.planRevision === latest);
    if (current.length !== 1) {
      for (const plan of current) if (plan.integrationSources !== undefined) ids.add(plan.taskId);
      continue;
    }
    const plan = current[0];
    if (plan?.integrationSources !== undefined && plan.integrationSources.sources.some(stale))
      ids.add(plan.taskId);
  }
  return [...ids];
};
