import {
  ProjectWorkWriteIntent,
  ProjectWorkDeliveryRequest,
  ProjectWorkDeliveryResult,
  ProjectWorkDeliveryRecoveryRead,
  ProjectWorkMemoryObservationsRead,
  ProjectTeamSupervisionSummary,
  ProjectWorkVerificationJobRead,
  ProjectTeamIntegrationSourcePage,
  ProjectTeamMemorySourcesRead,
  ProjectTeamMemorySharedSourcesRead,
  ProjectMemorySourceRead,
  MemoryProcessingConfiguration,
  MemoryOwner,
  ProjectWorkTaskId,
  ProjectId,
  NonNegativeInt,
  type ProjectWorkReadIntent,
  ProjectWorkTaskContext,
  ProjectWorkBriefingRead,
  ProjectTeamRecordRead,
  ProjectWorkTaskRead,
  ProjectWorkCriterionRead,
  ProjectWorkKnowledgeRead,
  ProjectWorkDecisionRead,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type { ProjectWorkHumanCommand } from "./state/projectWork.ts";

export const PROJECT_WORK_EXECUTION_UNAVAILABLE_REASON =
  "Worker execution is unavailable until managed execution is enabled.";

const decodeProjectWorkTaskContext = Schema.decodeUnknownOption(ProjectWorkTaskContext);
const decodeProjectWorkBriefingRead = Schema.decodeUnknownOption(ProjectWorkBriefingRead);
const decodeProjectTeamRecordRead = Schema.decodeUnknownOption(ProjectTeamRecordRead);
const decodeProjectWorkTaskRead = Schema.decodeUnknownOption(ProjectWorkTaskRead);
const decodeProjectWorkCriterionRead = Schema.decodeUnknownOption(ProjectWorkCriterionRead);
const decodeProjectWorkKnowledgeRead = Schema.decodeUnknownOption(ProjectWorkKnowledgeRead);
const decodeProjectWorkDecisionRead = Schema.decodeUnknownOption(ProjectWorkDecisionRead);

export const asProjectWorkTaskContext = (value: unknown) =>
  Option.getOrNull(decodeProjectWorkTaskContext(value));
export const asProjectWorkBriefing = (value: unknown) =>
  Option.getOrNull(decodeProjectWorkBriefingRead(value));
export const asProjectTeamRecord = (value: unknown) =>
  Option.getOrNull(decodeProjectTeamRecordRead(value));
export const asProjectWorkTask = (value: unknown) =>
  Option.getOrNull(decodeProjectWorkTaskRead(value));
export const asProjectWorkCriterion = (value: unknown) =>
  Option.getOrNull(decodeProjectWorkCriterionRead(value));
export const asProjectWorkKnowledge = (value: unknown) =>
  Option.getOrNull(decodeProjectWorkKnowledgeRead(value));
export const asProjectWorkDecision = (value: unknown) =>
  Option.getOrNull(decodeProjectWorkDecisionRead(value));

export interface ProjectWorkScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly checkoutPath: string;
}
export interface ProjectWorkSelection extends ProjectWorkScope {
  readonly taskId?: ProjectWorkTaskId;
  readonly revision: number;
  readonly taskRevision: number;
}
export function projectWorkScopeKey(scope: ProjectWorkScope): string {
  return JSON.stringify([scope.environmentId, scope.projectId, scope.checkoutPath]);
}
export function projectWorkSelectionIsCurrent(
  selected: ProjectWorkSelection,
  current: ProjectWorkSelection,
): boolean {
  return (
    projectWorkScopeKey(selected) === projectWorkScopeKey(current) &&
    selected.taskId === current.taskId &&
    selected.revision === current.revision &&
    selected.taskRevision === current.taskRevision
  );
}

const humanTypes = new Set<ProjectWorkHumanCommand["type"]>([
  "project-work.issue.refine",
  "project-work.task.create",
  "project-work.task.specify",
  "project-work.task.revise-protected-specification",
  "project-work.task.approve",
  "project-work.task.protect-specification",
  "project-work.task.ready",
  "project-work.task.block",
  "project-work.task.resolve-blocker",
  "project-work.task.reopen",
  "project-work.task.cancel",
  "project-work.task.duplicate",
  "project-work.task.watch",
  "project-work.task.unwatch",
  "project-work.criterion.upsert",
  "project-work.criterion.waive",
  "project-work.criterion.revoke-waiver",
  "project-work.evidence.add",
  "project-work.relationship.link",
  "project-work.relationship.unlink",
  "project-work.knowledge.promote",
  "project-work.decision.propose",
  "project-work.decision.accept",
  "project-work.decision.reject",
  "project-work.decision.supersede",
  "project-work.comment.add",
  "project-work.attention.seen",
  "project-team.configure",
  "project-team.gate.respond",
  "project-team.specification.propose",
  "project-team.criterion.waiver",
  "project-team.plan.propose",
  "project-team.task.control",
  "project-team.investigation.start",
  "project-team.assignment.start",
  "project-team.execution.start",
  "project-team.dispatch",
  "project-team.message.send",
  "project-team.message.attention",
  "project-team.question.request",
  "project-team.question.answer",
  "project-team.verification.propose",
  "project-team.review.finding.record",
  "project-team.memory.process",
  "project-team.memory.query",
  "project-team.memory.promote",
  "project-team.memory.retract",
  "project-team.memory.shares.replace",
  "project-team.memory.configure",
]);
const validIntent = Schema.is(ProjectWorkWriteIntent);
export function isProjectWorkHumanCommand(value: unknown): value is ProjectWorkHumanCommand {
  return validIntent(value) && humanTypes.has(value.type as ProjectWorkHumanCommand["type"]);
}

function matchesReviewedTask(
  intent: ProjectWorkHumanCommand,
  current: ProjectWorkSelection,
): boolean {
  const matches = (taskId: ProjectWorkTaskId) =>
    current.taskId !== undefined && taskId === current.taskId;
  switch (intent.type) {
    case "project-work.task.create":
      return true;
    case "project-work.task.duplicate":
      return matches(intent.sourceTaskId);
    case "project-work.evidence.add":
      return intent.evidence.taskId === undefined || matches(intent.evidence.taskId);
    case "project-work.comment.add":
      return intent.comment.taskId === undefined || matches(intent.comment.taskId);
    case "project-work.relationship.link":
      // The other endpoint is intentionally another task, not a second edited selection.
      return matches(intent.relationship.fromTaskId) || matches(intent.relationship.toTaskId);
    case "project-work.criterion.upsert":
      return matches(intent.taskId) && matches(intent.criterion.taskId);
    case "project-work.task.revise-protected-specification":
      return (
        matches(intent.taskId) &&
        matches(intent.approval.taskId) &&
        intent.criterionSnapshots.every((criterion) => matches(criterion.taskId))
      );
    case "project-team.specification.propose":
      return (
        matches(intent.taskId) &&
        intent.criterionSnapshots.every((criterion) => matches(criterion.taskId))
      );
    case "project-work.issue.refine":
      return (
        intent.target.kind !== "existing-task" ||
        (matches(intent.target.taskId) &&
          intent.target.expectedTaskRevision === current.taskRevision)
      );
    default:
      // Configuration, knowledge, decisions and record-ID-only unlink act on the project.
      return !("taskId" in intent) || matches(intent.taskId);
  }
}

/** A reviewed selection cannot be reused after navigation or a newer read. */
export function prepareProjectWorkHumanMutation(input: {
  readonly selected: ProjectWorkSelection;
  readonly current: ProjectWorkSelection;
  readonly intent: unknown;
}): ProjectWorkHumanCommand | null {
  const { selected, current, intent } = input;
  if (
    !projectWorkSelectionIsCurrent(selected, current) ||
    !isProjectWorkHumanCommand(intent) ||
    intent.projectId !== current.projectId
  )
    return null;
  if (intent.expectedRevision !== current.revision) return null;
  if ("expectedTaskRevision" in intent && intent.expectedTaskRevision !== current.taskRevision)
    return null;
  if (!matchesReviewedTask(intent, current)) return null;
  return intent;
}

export * from "./projectWorkModel.ts";

const MemoryCurrentRead = Schema.Struct({
  owner: MemoryOwner,
  projectId: ProjectId,
  taskId: ProjectWorkTaskId,
  revision: NonNegativeInt,
  status: Schema.Literals(["available", "disabled", "degraded"]),
  items: Schema.Array(ProjectMemorySourceRead).check(Schema.isMaxLength(32)),
  nextCursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
});
const MemoryConfigurationRead = Schema.Struct({
  revision: NonNegativeInt,
  configuration: MemoryProcessingConfiguration,
});
const decoder = <A>(schema: Schema.ConstraintDecoder<A, never>) => {
  const decode = Schema.decodeUnknownOption(schema);
  return (value: unknown) => Option.getOrNull(decode(value));
};
export const asProjectTeamSupervision = decoder(ProjectTeamSupervisionSummary);
export const asProjectWorkVerificationJob = decoder(ProjectWorkVerificationJobRead);
export const asProjectTeamIntegrationSources = decoder(ProjectTeamIntegrationSourcePage);
export const asProjectTeamMemorySources = decoder(ProjectTeamMemorySourcesRead);
export const asProjectTeamMemorySharedSources = decoder(ProjectTeamMemorySharedSourcesRead);
export const asProjectTeamMemoryCurrent = decoder(MemoryCurrentRead);
export const asProjectTeamMemoryConfiguration = decoder(MemoryConfigurationRead);
export const asProjectWorkDeliveryRecovery = decoder(ProjectWorkDeliveryRecoveryRead);
export const asProjectWorkMemoryObservations = decoder(ProjectWorkMemoryObservationsRead);

/** Special reads retain server pagination and states rather than guessing from record arrays. */
export function decodeProjectWorkSpecialRead(
  input: ProjectWorkReadIntent,
  value: unknown,
  environmentId: EnvironmentId,
) {
  const qualified = <
    T extends {
      readonly projectId: ProjectId;
      readonly taskId?: ProjectWorkTaskId;
      readonly owner?: { readonly kind: string; readonly projectId?: ProjectId };
    },
  >(
    decoded: T | null,
  ): T | null =>
    decoded !== null &&
    decoded.projectId === input.projectId &&
    (decoded.owner === undefined ||
      (decoded.owner.kind === "project" && decoded.owner.projectId === input.projectId)) &&
    (input.taskId === undefined || decoded.taskId === input.taskId)
      ? decoded
      : null;
  switch (input.operation) {
    case "supervision": {
      const decoded = asProjectTeamSupervision(value);
      return {
        operation: input.operation,
        value: decoded?.projectId === input.projectId ? decoded : null,
      } as const;
    }
    case "verification-job": {
      const decoded = asProjectWorkVerificationJob(value);
      return {
        operation: input.operation,
        value:
          decoded?.manifest.environmentId === environmentId &&
          decoded.manifest.projectId === input.projectId &&
          decoded.manifest.taskId === input.taskId &&
          decoded.manifest.jobId === input.verificationJobId
            ? decoded
            : null,
      } as const;
    }
    case "integration-sources": {
      const decoded = qualified(asProjectTeamIntegrationSources(value));
      return {
        operation: input.operation,
        value:
          decoded?.environmentId === environmentId &&
          (decoded.ownSource === undefined ||
            (decoded.ownSource.ref.taskId === input.taskId &&
              decoded.ownSource.source.taskId === input.taskId))
            ? decoded
            : null,
      } as const;
    }
    case "memory-sources":
      return {
        operation: input.operation,
        value: qualified(asProjectTeamMemorySources(value)),
      } as const;
    case "memory-shared-sources":
      return {
        operation: input.operation,
        value: qualified(asProjectTeamMemorySharedSources(value)),
      } as const;
    case "memory-current":
    case "memory-recall":
      return {
        operation: input.operation,
        value: qualified(asProjectTeamMemoryCurrent(value)),
      } as const;
    case "delivery-recovery": {
      const decoded = qualified(asProjectWorkDeliveryRecovery(value));
      return {
        operation: input.operation,
        value: decoded?.environmentId === environmentId ? decoded : null,
      } as const;
    }
    case "memory-observations": {
      const decoded = qualified(asProjectWorkMemoryObservations(value));
      return {
        operation: input.operation,
        value: decoded?.environmentId === environmentId ? decoded : null,
      } as const;
    }
    case "memory-configuration":
      return {
        operation: input.operation,
        value: asProjectTeamMemoryConfiguration(value),
      } as const;
    default:
      return null;
  }
}

const decodeDeliveryRequest = Schema.decodeUnknownOption(ProjectWorkDeliveryRequest);

export function prepareProjectWorkDeliveryMutation(input: {
  readonly selected: ProjectWorkSelection;
  readonly current: ProjectWorkSelection;
  readonly request: unknown;
  readonly reviewedOperation?: ProjectWorkReviewedDeliveryOperation;
}): {
  readonly projectId: ProjectId;
  readonly request: ProjectWorkDeliveryRequest;
} | null {
  if (!projectWorkSelectionIsCurrent(input.selected, input.current)) return null;
  const decoded = decodeDeliveryRequest(input.request);
  if (Option.isNone(decoded)) return null;
  const request = decoded.value;
  if (request.operation === "preview" || request.operation === "publish") {
    if (
      request.input.projectId !== input.current.projectId ||
      request.input.taskId !== input.current.taskId
    )
      return null;
    if (
      request.operation === "preview" &&
      request.input.expectedRevision !== input.current.revision
    )
      return null;
  }
  if (request.operation === "merge" || request.operation === "accept") {
    const operation = input.reviewedOperation;
    if (
      operation === undefined ||
      operation.operationId !== request.input.operationId ||
      projectWorkScopeKey(operation) !== projectWorkScopeKey(input.current) ||
      operation.taskId !== input.current.taskId ||
      (request.operation === "merge" &&
        (operation.kind !== "merge" ||
          operation.publicationOperationId !== request.input.publicationOperationId)) ||
      (request.operation === "accept" &&
        (operation.kind !== "merge" ||
          operation.stage !== "confirmed" ||
          operation.receiptHash === undefined ||
          operation.receiptHash !== request.input.expectedReceiptHash))
    )
      return null;
  }
  return { projectId: input.current.projectId, request };
}

export interface ProjectWorkReviewedDeliveryOperation extends ProjectWorkScope {
  readonly taskId: ProjectWorkTaskId;
  readonly operationId: string;
  readonly kind: "create-pr" | "merge";
  readonly stage: ProjectWorkDeliveryResult["stage"];
  readonly receiptHash?: string;
  readonly publicationOperationId?: string;
}

const decodeDeliveryResult = Schema.decodeUnknownOption(ProjectWorkDeliveryResult);

/** Keep this with the preview/publication draft; later gate revisions do not change its target. */
export function retainProjectWorkDeliveryOperation(input: {
  readonly selected: ProjectWorkSelection;
  readonly current: ProjectWorkSelection;
  readonly request: Extract<
    ProjectWorkDeliveryRequest,
    { readonly operation: "preview" | "publish" | "merge" }
  >;
  readonly reviewedOperation?: ProjectWorkReviewedDeliveryOperation;
  readonly result: unknown;
}): ProjectWorkReviewedDeliveryOperation | null {
  if (input.current.taskId === undefined || prepareProjectWorkDeliveryMutation(input) === null)
    return null;
  const decoded = decodeDeliveryResult(input.result);
  if (Option.isNone(decoded)) return null;
  const result = decoded.value;
  const request = input.request;
  if (!deliveryResultMatchesRequest(request, result)) return null;
  return {
    environmentId: input.current.environmentId,
    projectId: input.current.projectId,
    checkoutPath: input.current.checkoutPath,
    taskId: input.current.taskId,
    operationId: result.operationId,
    kind:
      request.operation === "preview"
        ? request.input.kind
        : request.operation === "publish"
          ? "create-pr"
          : "merge",
    stage: result.stage,
    ...(request.operation === "merge" &&
    result.stage === "confirmed" &&
    result.receiptHash !== undefined
      ? { receiptHash: result.receiptHash }
      : {}),
    ...((request.operation === "preview" || request.operation === "merge") &&
    request.input.publicationOperationId !== undefined
      ? { publicationOperationId: request.input.publicationOperationId }
      : {}),
  };
}

function deliveryResultMatchesRequest(
  request: ProjectWorkDeliveryRequest,
  result: ProjectWorkDeliveryResult,
): boolean {
  if (request.operation === "accept") return false;
  const expectedId =
    request.operation === "preview" ? request.input.commandId : request.input.operationId;
  const expectedKind =
    request.operation === "preview"
      ? "preview"
      : request.operation === "publish"
        ? "create-pr"
        : "merge";
  return (
    result.operationId === expectedId &&
    result.kind === expectedKind &&
    (request.operation === "preview" ? result.stage === "proposed" : result.stage !== "proposed")
  );
}

/** Recovery reads identify retained operations; they never retry an external write. */
export function prepareProjectWorkRecoveredDelivery(input: {
  readonly selected: ProjectWorkSelection;
  readonly current: ProjectWorkSelection;
  readonly readScope: ProjectWorkScope;
  readonly recovery: unknown;
  readonly operationId: string;
  readonly operation: "preview" | "publish" | "merge";
}): {
  readonly projectId: ProjectId;
  readonly request: ProjectWorkDeliveryRequest;
  readonly reviewedOperation: ProjectWorkReviewedDeliveryOperation;
} | null {
  if (
    !projectWorkSelectionIsCurrent(input.selected, input.current) ||
    projectWorkScopeKey(input.readScope) !== projectWorkScopeKey(input.current) ||
    input.current.taskId === undefined
  )
    return null;
  const page = asProjectWorkDeliveryRecovery(input.recovery);
  if (
    page === null ||
    page.environmentId !== input.current.environmentId ||
    page.projectId !== input.current.projectId ||
    page.taskId !== input.current.taskId ||
    page.revision !== input.current.revision
  )
    return null;
  const rows = page.items.filter(
    (item) =>
      item.result.operationId === input.operationId && item.request.operation === input.operation,
  );
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const { request, result } = row;
  if (!deliveryResultMatchesRequest(request, result) || request.operation === "accept") return null;
  if (
    (request.operation === "preview" || result.gateId !== undefined) &&
    result.gateId !== row.gateId
  )
    return null;
  if (
    (request.operation === "preview" || request.operation === "publish") &&
    (request.input.projectId !== page.projectId || request.input.taskId !== page.taskId)
  )
    return null;
  if (
    (request.operation === "publish" || request.operation === "merge") &&
    request.input.gateId !== row.gateId
  )
    return null;
  return {
    projectId: page.projectId,
    request,
    reviewedOperation: {
      ...input.readScope,
      taskId: page.taskId,
      operationId: result.operationId,
      kind:
        request.operation === "preview"
          ? request.input.kind
          : request.operation === "publish"
            ? "create-pr"
            : "merge",
      stage: result.stage,
      ...(request.operation === "merge" ||
      (request.operation === "preview" && request.input.publicationOperationId !== undefined)
        ? { publicationOperationId: request.input.publicationOperationId }
        : {}),
      ...(request.operation === "merge" &&
      result.stage === "confirmed" &&
      result.receiptHash !== undefined
        ? { receiptHash: result.receiptHash }
        : {}),
    },
  };
}
