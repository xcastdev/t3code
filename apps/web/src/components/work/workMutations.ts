import * as Schema from "effect/Schema";
import {
  projectWorkPayloadFingerprint,
  projectWorkProtectedRevisionFingerprintPayload,
  type CommandId,
  type ProjectId,
  type ProjectWorkCommand,
  type ProjectWorkCriterionId,
  type ProjectWorkTaskId,
  type ProjectWorkBlockerId,
  type ProjectWorkEvidenceId,
  type ProjectWorkRelationshipId,
  type ProjectWorkKnowledgeId,
  type ProjectWorkDecisionId,
  type ProjectWorkApprovalId,
  type ProjectWorkAttribution,
  type ProjectWorkCriterionRead,
  ProjectWorkCriterion,
  type ProjectWorkSpecification,
  type ProjectWorkResultId,
} from "@t3tools/contracts";

const decodeCriterion = Schema.decodeUnknownSync(ProjectWorkCriterion);

type TaskCreateCommand = Extract<ProjectWorkCommand, { readonly type: "project-work.task.create" }>;
type CriterionUpsertCommand = Extract<
  ProjectWorkCommand,
  { readonly type: "project-work.criterion.upsert" }
>;
type TaskSpecifyCommand = Extract<
  ProjectWorkCommand,
  { readonly type: "project-work.task.specify" }
>;
type TaskReadyCommand = Extract<ProjectWorkCommand, { readonly type: "project-work.task.ready" }>;

export function makeProjectWorkTaskCreateCommand(input: {
  readonly projectId: ProjectId;
  readonly expectedRevision: number;
  readonly taskId: ProjectWorkTaskId;
  readonly commandId: CommandId;
  readonly title: string;
  readonly summary?: string;
  readonly createdAt: string;
}): TaskCreateCommand {
  return {
    type: "project-work.task.create",
    commandId: input.commandId,
    projectId: input.projectId,
    expectedRevision: input.expectedRevision,
    taskId: input.taskId,
    title: input.title,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    createdAt: input.createdAt,
  };
}

export function makeProjectWorkCriterionUpsertCommand(input: {
  readonly projectId: ProjectId;
  readonly taskId: ProjectWorkTaskId;
  readonly taskRevision: number;
  readonly criterionId: ProjectWorkCriterionId;
  readonly commandId: CommandId;
  readonly description: string;
  readonly updatedAt: string;
}): CriterionUpsertCommand {
  return {
    type: "project-work.criterion.upsert",
    commandId: input.commandId,
    projectId: input.projectId,
    taskId: input.taskId,
    expectedRevision: input.taskRevision,
    criterion: {
      criterionId: input.criterionId,
      taskId: input.taskId,
      description: input.description,
      required: true,
      status: "unsatisfied",
      satisfiedByEvidenceIds: [],
      revision: 0,
      updatedAt: input.updatedAt,
    },
    updatedAt: input.updatedAt,
  };
}

export function makeProjectWorkTaskSpecifyCommand(input: {
  readonly projectId: ProjectId;
  readonly taskId: ProjectWorkTaskId;
  readonly criterionId: ProjectWorkCriterionId;
  readonly criterionRevision: number;
  readonly specificationRevision: number;
  readonly commandId: CommandId;
  readonly objective: string;
  readonly scopeIn: string;
  readonly scopeOut: string;
  readonly updatedAt: string;
}): TaskSpecifyCommand {
  return {
    type: "project-work.task.specify",
    commandId: input.commandId,
    projectId: input.projectId,
    taskId: input.taskId,
    expectedRevision: input.criterionRevision,
    specification: {
      objective: input.objective,
      scopeIn: input.scopeIn,
      scopeOut: input.scopeOut,
      criterionIds: [input.criterionId],
      revision: input.specificationRevision,
      protected: false,
    },
    updatedAt: input.updatedAt,
  };
}

export function makeProjectWorkTaskReadyCommand(input: {
  readonly projectId: ProjectId;
  readonly taskId: ProjectWorkTaskId;
  readonly expectedRevision: number;
  readonly commandId: CommandId;
  readonly updatedAt: string;
}): TaskReadyCommand {
  return {
    type: "project-work.task.ready",
    commandId: input.commandId,
    projectId: input.projectId,
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    updatedAt: input.updatedAt,
  };
}

type CommandOf<T extends ProjectWorkCommand["type"]> = Extract<ProjectWorkCommand, { type: T }>;
const base = (input: { projectId: ProjectId; commandId: CommandId; expectedRevision: number }) => ({
  projectId: input.projectId,
  commandId: input.commandId,
  expectedRevision: input.expectedRevision,
});

export const makeProjectWorkTaskBlockCommand = (input: {
  projectId: ProjectId;
  taskId: ProjectWorkTaskId;
  expectedRevision: number;
  commandId: CommandId;
  blockerId: ProjectWorkBlockerId;
  reason: string;
  resolver: string;
  referenceIds?: ReadonlyArray<string>;
  blockedAt: string;
}): CommandOf<"project-work.task.block"> => ({
  ...base(input),
  type: "project-work.task.block",
  taskId: input.taskId,
  blockerId: input.blockerId,
  reason: input.reason,
  resolver: input.resolver,
  referenceIds: [...(input.referenceIds ?? [])],
  blockedAt: input.blockedAt,
});

export const makeProjectWorkSimpleTaskCommand = <
  T extends
    | "project-work.task.resolve-blocker"
    | "project-work.task.reopen"
    | "project-work.task.cancel"
    | "project-work.task.approve"
    | "project-work.task.protect-specification",
>(
  type: T,
  input: {
    projectId: ProjectId;
    taskId: ProjectWorkTaskId;
    expectedRevision: number;
    commandId: CommandId;
    now: string;
    blockerId?: ProjectWorkBlockerId;
    reason?: string;
    approvalId?: ProjectWorkApprovalId;
    specRevision?: number;
    approvalToken?: string;
  },
): CommandOf<T> => {
  const common = { ...base(input), type, taskId: input.taskId };
  switch (type) {
    case "project-work.task.resolve-blocker":
      return { ...common, blockerId: input.blockerId!, resolvedAt: input.now } as CommandOf<T>;
    case "project-work.task.reopen":
      return { ...common, reopenedAt: input.now } as CommandOf<T>;
    case "project-work.task.cancel":
      return {
        ...common,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.approvalToken ? { approvalToken: input.approvalToken } : {}),
        canceledAt: input.now,
      } as CommandOf<T>;
    case "project-work.task.approve":
      return {
        ...common,
        approvalId: input.approvalId!,
        specRevision: input.specRevision!,
        ...(input.approvalToken ? { approvalToken: input.approvalToken } : {}),
        approvedAt: input.now,
      } as CommandOf<T>;
    default:
      return {
        ...common,
        specRevision: input.specRevision!,
        ...(input.approvalToken ? { approvalToken: input.approvalToken } : {}),
        protectedAt: input.now,
      } as CommandOf<T>;
  }
};

export const makeProjectWorkEvidenceAddCommand = (input: {
  projectId: ProjectId;
  taskId: ProjectWorkTaskId;
  criterionId?: ProjectWorkCriterionId;
  expectedRevision: number;
  commandId: CommandId;
  evidenceId: ProjectWorkEvidenceId;
  summary: string;
  detail?: string;
  uri?: string;
  recordedAt: string;
}): CommandOf<"project-work.evidence.add"> => ({
  ...base(input),
  type: "project-work.evidence.add",
  evidence: {
    evidenceId: input.evidenceId,
    taskId: input.taskId,
    ...(input.criterionId === undefined ? {} : { criterionId: input.criterionId }),
    kind: "observation",
    summary: input.summary,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.uri ? { uri: input.uri } : {}),
    recordedAt: input.recordedAt,
    revision: 0,
  },
  addedAt: input.recordedAt,
});

export const makeProjectWorkCriterionWaiveCommand = (input: {
  projectId: ProjectId;
  taskId: ProjectWorkTaskId;
  criterion: ProjectWorkCriterionRead;
  expectedRevision: number;
  commandId: CommandId;
  reason: string;
  specRevision: number;
  evidenceIds: ReadonlyArray<ProjectWorkEvidenceId>;
  waivedAt: string;
  attribution: ProjectWorkAttribution;
  approvalToken?: string;
}): CommandOf<"project-work.criterion.waive"> => ({
  ...base(input),
  type: "project-work.criterion.waive",
  taskId: input.taskId,
  criterionId: input.criterion.criterionId,
  waiver: {
    reason: input.reason,
    evidenceIds: [...input.evidenceIds],
    specRevision: input.specRevision,
    waivedAt: input.waivedAt,
    attribution: input.attribution,
  },
  waivedAt: input.waivedAt,
  ...(input.approvalToken ? { approvalToken: input.approvalToken } : {}),
});

export const makeProjectWorkProtectedRevisionCommand = (input: {
  projectId: ProjectId;
  taskId: ProjectWorkTaskId;
  expectedRevision: number;
  commandId: CommandId;
  specification: ProjectWorkSpecification;
  criterionSnapshots: ReadonlyArray<ProjectWorkCriterionRead>;
  affectedResultIds: ReadonlyArray<ProjectWorkResultId>;
  approvalId: ProjectWorkApprovalId;
  payloadFingerprint?: string;
  revisedAt: string;
  attribution: ProjectWorkAttribution;
  approvalToken?: string;
}): CommandOf<"project-work.task.revise-protected-specification"> => {
  const command: CommandOf<"project-work.task.revise-protected-specification"> = {
    ...base(input),
    type: "project-work.task.revise-protected-specification",
    taskId: input.taskId,
    specification: input.specification,
    criterionSnapshots: input.criterionSnapshots.map((criterion) => decodeCriterion(criterion)),
    affectedResultIds: [...input.affectedResultIds],
    approval: {
      approvalId: input.approvalId,
      taskId: input.taskId,
      specRevision: input.specification.revision,
      payloadFingerprint: input.payloadFingerprint ?? "pending",
      approvedAt: input.revisedAt,
      attribution: input.attribution,
    },
    revisedAt: input.revisedAt,
    attribution: input.attribution,
    ...(input.approvalToken ? { approvalToken: input.approvalToken } : {}),
  };
  if (input.payloadFingerprint !== undefined) return command;
  return {
    ...command,
    approval: {
      ...command.approval,
      payloadFingerprint: projectWorkPayloadFingerprint(
        projectWorkProtectedRevisionFingerprintPayload(command),
      ),
    },
  };
};

export const makeProjectWorkRelationshipCommand = (input: {
  mode: "link" | "unlink";
  projectId: ProjectId;
  taskId: ProjectWorkTaskId;
  otherTaskId: ProjectWorkTaskId;
  expectedRevision: number;
  commandId: CommandId;
  relationshipId: ProjectWorkRelationshipId;
  now: string;
}): CommandOf<"project-work.relationship.link"> | CommandOf<"project-work.relationship.unlink"> =>
  input.mode === "link"
    ? {
        ...base(input),
        type: "project-work.relationship.link",
        relationship: {
          relationshipId: input.relationshipId,
          projectId: input.projectId,
          fromTaskId: input.taskId,
          toTaskId: input.otherTaskId,
          kind: "depends-on",
          revision: 0,
          createdAt: input.now,
        },
        linkedAt: input.now,
      }
    : {
        ...base(input),
        type: "project-work.relationship.unlink",
        relationshipId: input.relationshipId,
        unlinkedAt: input.now,
      };

export const makeProjectWorkKnowledgePromoteCommand = (input: {
  projectId: ProjectId;
  expectedRevision: number;
  commandId: CommandId;
  knowledgeId: ProjectWorkKnowledgeId;
  supersedesKnowledgeId?: ProjectWorkKnowledgeId;
  title: string;
  body: string;
  sourceKind: "task" | "thread" | "session" | "worktree" | "attempt" | "manual";
  sourceId: string;
  promotedAt: string;
}): CommandOf<"project-work.knowledge.promote"> => ({
  ...base(input),
  type: "project-work.knowledge.promote",
  knowledge: {
    knowledgeId: input.knowledgeId,
    ...(input.supersedesKnowledgeId === undefined
      ? {}
      : { supersedesKnowledgeId: input.supersedesKnowledgeId }),
    projectId: input.projectId,
    title: input.title,
    body: input.body,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    revision: 0,
    createdAt: input.promotedAt,
    updatedAt: input.promotedAt,
  },
  promotedAt: input.promotedAt,
});

export const makeProjectWorkDecisionCommand = (input: {
  mode: "propose" | "accept" | "reject" | "supersede";
  projectId: ProjectId;
  expectedRevision: number;
  commandId: CommandId;
  decisionId: ProjectWorkDecisionId;
  replacementId?: ProjectWorkDecisionId;
  title?: string;
  body?: string;
  reason?: string;
  now: string;
  approvalToken?: string;
  attribution?: ProjectWorkAttribution;
}):
  | CommandOf<"project-work.decision.propose">
  | CommandOf<"project-work.decision.accept">
  | CommandOf<"project-work.decision.reject">
  | CommandOf<"project-work.decision.supersede"> => {
  if (input.mode === "propose")
    return {
      ...base(input),
      type: "project-work.decision.propose",
      decision: {
        decisionId: input.decisionId,
        projectId: input.projectId,
        title: input.title!,
        body: input.body!,
        state: "proposed",
        revision: 0,
        createdAt: input.now,
        updatedAt: input.now,
      },
      proposedAt: input.now,
    };
  if (input.mode === "accept")
    return {
      ...base(input),
      type: "project-work.decision.accept",
      decisionId: input.decisionId,
      acceptedAt: input.now,
      ...(input.approvalToken ? { approvalToken: input.approvalToken } : {}),
    };
  if (input.mode === "reject")
    return {
      ...base(input),
      type: "project-work.decision.reject",
      decisionId: input.decisionId,
      reason: input.reason!,
      rejectedAt: input.now,
      ...(input.approvalToken ? { approvalToken: input.approvalToken } : {}),
    };
  return {
    ...base(input),
    type: "project-work.decision.supersede",
    decisionId: input.decisionId,
    replacement: {
      decisionId: input.replacementId!,
      projectId: input.projectId,
      title: input.title!,
      body: input.body!,
      state: "proposed",
      supersedesDecisionId: input.decisionId,
      revision: 0,
      createdAt: input.now,
      updatedAt: input.now,
      ...(input.attribution ? { attribution: input.attribution } : {}),
    },
    supersededAt: input.now,
    attribution: input.attribution!,
    ...(input.approvalToken ? { approvalToken: input.approvalToken } : {}),
  };
};

export { prepareProjectWorkHumanMutation } from "@t3tools/client-runtime/project-work";
