import {
  canonicalProjectWorkPayload,
  PROJECT_TEAM_DEFAULT_LIMITS,
  type ProjectTeamConfigurationIntent,
  type ProjectTeamRecord,
  type ProjectWorkAttribution,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { projectTeamDerivedRecordId } from "./ProjectTeamPolicy.ts";

type Limits = Extract<ProjectTeamRecord, { kind: "limits" }>;
type Role = Extract<ProjectTeamRecord, { kind: "role-revision" }>;
type Member = Extract<ProjectTeamRecord, { kind: "member" }>;
const reject = (reason: string): never => {
  throw new ProjectWorkPolicyError("authority-required", reason);
};
const increment = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER)
    reject("Project configuration counter is exhausted");
  return value + 1;
};
const idFor = (projectId: string, suffix: string) =>
  projectTeamDerivedRecordId(projectId, `team-configuration:${suffix}`);

/** These are human-installed policy references, not execution or model-route authority. */
export const projectTeamConfigurationGeneration = (state: ProjectWorkReducerState) =>
  (state.foundationRecords ?? []).reduce(
    (generation, record) =>
      record.kind === "limits" &&
      record.providerInstanceId !== undefined &&
      record.profileRecordIds !== undefined
        ? Math.max(generation, record.generation)
        : generation,
    0,
  );

export const compileProjectTeamConfiguration = (
  state: ProjectWorkReducerState,
  intent: ProjectTeamConfigurationIntent,
  attribution: ProjectWorkAttribution,
): Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }> => {
  if (attribution.actor.kind !== "human") reject("Only a human can configure a project team");
  if (state.projectId !== intent.projectId || state.revision !== intent.expectedRevision)
    reject("Project configuration revision changed");
  const generation = projectTeamConfigurationGeneration(state);
  if (
    generation !== intent.expectedConfigurationGeneration ||
    !Number.isSafeInteger(generation) ||
    generation >= Number.MAX_SAFE_INTEGER
  )
    reject("Project configuration generation changed or is exhausted");
  const current = state.foundationRecords ?? [];
  if (
    current.some(
      (record) =>
        (record.kind === "run-binding" && record.status !== "settled") ||
        (record.kind === "reservation" && record.status === "held"),
    )
  )
    reject("Stop and authoritatively drain existing team work before changing configuration");
  const priorities = new Set<string>();
  for (const entry of intent.taskPriorities) {
    if (priorities.has(entry.taskId) || !state.tasks.some((task) => task.taskId === entry.taskId))
      reject("Task priorities require unique current project tasks");
    priorities.add(entry.taskId);
  }
  const models = new Set(intent.modelPolicies.map((policy) => policy.model));
  const selected = new Set(intent.profiles.map((profile) => profile.model));
  if (
    models.size !== selected.size ||
    [...selected].some((model) => !models.has(model) || model === "unconfigured")
  )
    reject("Every selected profile needs exactly its configured model policy");
  for (const profile of intent.profiles) {
    if (
      new Set(profile.skills).size !== profile.skills.length ||
      new Set(profile.tools).size !== profile.tools.length
    )
      reject("Profile skills and tools must be unique");
  }
  const nextGeneration = increment(generation);
  const at = attribution.recordedAt;
  const records: Array<ProjectTeamRecord> = [];
  const fields = (recordId: string) => ({
    recordId,
    projectId: intent.projectId,
    revision: 0,
    generation: nextGeneration,
    updatedAt: at,
  });
  const roles: Array<Role> = [];
  for (const profile of intent.profiles) {
    const roleId = idFor(intent.projectId, `role:${profile.role}`);
    const previous = current.filter(
      (record): record is Role => record.kind === "role-revision" && record.roleId === roleId,
    );
    for (const role of previous.filter((role) => role.status === "available"))
      records.push({
        ...role,
        status: "retired",
        revision: increment(role.revision),
        updatedAt: at,
      });
    const roleRevision = previous.reduce(
      (revision, role) => Math.max(revision, increment(role.roleRevision)),
      0,
    );
    const role: Role = {
      ...fields(idFor(intent.projectId, `role:${profile.role}:${nextGeneration}`)),
      ...profile,
      kind: "role-revision",
      status: "available",
      roleId,
      roleRevision,
    };
    roles.push(role);
    records.push(role);
    const old =
      profile.role === "coordinator"
        ? current.find(
            (record): record is Member =>
              record.kind === "member" && record.coordinator && record.status !== "retired",
          )
        : current.find(
            (record): record is Member =>
              record.kind === "member" &&
              record.recordId === idFor(intent.projectId, `member:${profile.role}`),
          );
    records.push({
      ...fields(old?.recordId ?? idFor(intent.projectId, `member:${profile.role}`)),
      kind: "member",
      status: intent.enabled ? "active" : "paused",
      name: old?.name ?? profile.role,
      coordinator: profile.role === "coordinator",
      roleRevisionId: role.recordId,
      revision: old === undefined ? 0 : increment(old.revision),
    });
  }
  const replacementIds = new Set(
    intent.modelPolicies.map((policy) => idFor(intent.projectId, `limits:${policy.model}`)),
  );
  for (const old of current.filter(
    (record): record is Limits =>
      record.kind === "limits" &&
      record.status === "configured" &&
      !replacementIds.has(record.recordId),
  ))
    records.push({ ...old, status: "disabled", revision: increment(old.revision), updatedAt: at });
  for (const policy of intent.modelPolicies) {
    const recordId = idFor(intent.projectId, `limits:${policy.model}`);
    const old = current.find(
      (record): record is Limits => record.kind === "limits" && record.recordId === recordId,
    );
    records.push({
      ...fields(recordId),
      ...policy,
      kind: "limits",
      status: intent.enabled ? "configured" : "disabled",
      revision: old === undefined ? 0 : increment(old.revision),
      environmentModelCalls:
        intent.environmentModelCalls ?? PROJECT_TEAM_DEFAULT_LIMITS.environmentModelCalls,
      projectWritableWorkers:
        intent.projectWritableWorkers ?? PROJECT_TEAM_DEFAULT_LIMITS.projectWritableWorkers,
      delegationDepth: intent.delegationDepth ?? PROJECT_TEAM_DEFAULT_LIMITS.delegationDepth,
      repairAllowance: intent.repairAllowance ?? PROJECT_TEAM_DEFAULT_LIMITS.repairAllowance,
      providerInstanceId: intent.providerInstanceId,
      projectPriority: intent.projectPriority,
      taskPriorities: intent.taskPriorities,
      profileRecordIds: roles.map((role) => role.recordId),
    });
  }
  if (records.length > 64)
    reject("Configuration exceeds its bounded transaction; retire obsolete policies first");
  return {
    type: "project-work.foundation.commit",
    commandId: intent.commandId,
    projectId: intent.projectId,
    expectedRevision: intent.expectedRevision,
    attribution,
    records,
    committedAt: at,
  };
};

/** The original command receipt may be replayed only while every installed record is current. */
export const assertProjectTeamConfigurationReplay = (
  state: ProjectWorkReducerState,
  original: ReadonlyArray<ProjectTeamRecord>,
) => {
  if (original.length === 0) reject("Configuration receipt has no installed records");
  for (const record of original) {
    const current = state.foundationRecords?.find((entry) => entry.recordId === record.recordId);
    if (canonicalProjectWorkPayload(current) !== canonicalProjectWorkPayload(record))
      reject("Configuration receipt target changed");
  }
};
