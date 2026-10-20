import * as NodeCrypto from "node:crypto";
import {
  type ProjectWorkActor,
  type ProjectWorkWriteIntent,
  ProjectTeamWriteIntent,
  type ProjectTeamMemoryRetractIntent,
  type ProjectTeamMemorySharesReplaceIntent,
  ProjectWorkVerificationJobRead,
  ProjectTeamGuidedIntent,
  ProjectTeamIntegrationSourcePage,
  ProjectTeamSupervisionSummary,
  type ProjectWorkAttribution,
  type ProjectWorkCommand,
  type ProjectWorkCriterion,
  type ProjectWorkReadIntent,
  type ProjectWorkWriteResult,
  canonicalProjectWorkPayload,
  projectWorkPayloadFingerprint,
  projectWorkProtectedRevisionIntentFingerprintPayload,
  projectWorkProtectedRevisionFingerprintPayload,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { ProjectWorkVerification } from "./ProjectWorkVerification.ts";
import { ProjectWorkVerificationRequest } from "./ProjectWorkVerificationRequest.ts";
import {
  ProjectWorkVerificationApproval,
  ProjectWorkVerificationGateError,
  makeProjectWorkVerificationGate,
} from "./ProjectWorkVerificationGate.ts";
import { ProjectWorkVerificationPreparationSelection } from "./ProjectWorkVerificationPreparation.ts";
import { makeProjectTeamIntegrationSources } from "./ProjectTeamIntegrationSources.ts";
import { makeProjectMemoryProcessing } from "./memory/ProjectMemoryProcessing.ts";
import {
  makeProjectMemoryService,
  ProjectMemoryServiceError,
} from "./memory/ProjectMemoryService.ts";
import { readProjectMemorySharedSources } from "./memory/ProjectMemorySharing.ts";
import { ProjectMemoryPorts } from "./memory/ProjectMemoryPorts.ts";
import {
  makeProjectMemoryQuery,
  ProjectMemoryQueryQualification,
} from "./memory/ProjectMemoryQuery.ts";
import * as ProjectTeamAuthorization from "./ProjectTeamAuthorization.ts";
import * as ProjectWorkBriefing from "./ProjectWorkBriefing.ts";
import * as IssueComments from "./ProjectIssueComments.ts";
import * as ProjectWorkNarrative from "./ProjectWorkNarrative.ts";
import * as ProjectWorkAttentionReactor from "./ProjectWorkAttentionReactor.ts";
import * as ProjectWorkExport from "./ProjectWorkExport.ts";
import * as ProjectWorkContentGuard from "./ProjectWorkContentGuard.ts";
import {
  assertProjectWorkCommandContentSafe,
  ProjectWorkContentRejectedError,
  isProjectWorkContentRejectedError,
  redactProjectWorkContent,
} from "./ProjectWorkContentGuard.ts";
import * as ProjectWorkQuery from "./ProjectWorkQuery.ts";
import { readProjectTeamSupervision } from "./ProjectTeamSupervisionRead.ts";
import * as ProjectWorkRepository from "./ProjectWorkRepository.ts";
import * as ProjectWorkSearch from "./ProjectWorkSearch.ts";
import * as ProjectLifecycle from "../project/ProjectLifecycle.ts";
import { assertProjectAcceptsMutations } from "../project/ProjectMutationFence.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  isPersistenceError,
  PersistenceSqlError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../persistence/Errors.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";

/** All project-work adapters go through this boundary. It is where transport
 * identity becomes durable attribution and where sensitive agent intents are
 * checked before reaching the event-sourced repository. */
export class ProjectWorkAuthorizationError extends Schema.TaggedError<ProjectWorkAuthorizationError>()(
  "ProjectWorkAuthorizationError",
  {
    reason: Schema.Literals([
      "spoofed-attribution",
      "agent-approval-required",
      "invalid-approval",
      "project-work-disabled",
      "unknown-project",
      "project-archived",
      "project-tombstoned",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "spoofed-attribution":
        return "Project-work attribution must match the authenticated principal.";
      case "agent-approval-required":
        return "This project-work intent requires a human approval.";
      case "project-tombstoned":
        return "This project has been permanently deleted locally and cannot accept new work.";
      case "project-work-disabled":
        return "Project work is disabled for this environment.";
      case "unknown-project":
        return "This project is not known to this environment.";
      case "project-archived":
        return "This project is archived and cannot accept new work.";
      default:
        return "The project-work approval does not match this intent.";
    }
  }
}

export class ProjectWorkGatewayUnavailableError extends Schema.TaggedError<ProjectWorkGatewayUnavailableError>()(
  "ProjectWorkGatewayUnavailableError",
  {},
) {
  override get message(): string {
    return "The project-work service is unavailable.";
  }
}

export type ProjectWorkWriteReceipt = ProjectWorkWriteResult;

export interface ProjectWorkGatewayShape {
  readonly read: (
    input: ProjectWorkReadIntent,
    principal?: ProjectTeamAuthorization.ProjectTeamPrincipal,
  ) => Effect.Effect<
    unknown,
    | ProjectionRepositoryError
    | ProjectTeamAuthorization.ProjectTeamAuthorizationError
    | IssueComments.IssueCommentsError
  >;
  readonly write: (
    command: ProjectWorkWriteIntent,
    actor: ProjectWorkActor,
    source: ProjectWorkAttribution["source"],
    principal?: ProjectTeamAuthorization.ProjectTeamPrincipal,
  ) => Effect.Effect<
    ProjectWorkWriteReceipt,
    | ProjectTeamAuthorization.ProjectTeamAuthorizationError
    | ProjectWorkRepository.ProjectWorkRepositoryError
    | ProjectWorkAuthorizationError
    | ProjectWorkContentRejectedError
    | EnvironmentAuth.ServerAuthInternalError
  >;
}

export class ProjectWorkGateway extends Context.Service<
  ProjectWorkGateway,
  ProjectWorkGatewayShape
>()("t3/projectWork/ProjectWorkGateway") {}

const isTeamAuthorizationError = Schema.is(ProjectTeamAuthorization.ProjectTeamAuthorizationError);
const isMemoryServiceError = Schema.is(ProjectMemoryServiceError);
const isPersistenceSqlError = Schema.is(PersistenceSqlError);
const isIssueCommentsError = Schema.is(IssueComments.IssueCommentsError);
const isTeamIntent = Schema.is(ProjectTeamWriteIntent);
const isGuidedIntent = Schema.is(ProjectTeamGuidedIntent);

const sensitiveAgentIntent = (command: ProjectWorkCommand): boolean =>
  command.type === "project-work.task.cancel" ||
  command.type === "project-work.task.approve" ||
  command.type === "project-work.task.protect-specification" ||
  command.type === "project-work.attempt.takeover" ||
  command.type === "project-work.task.revise-protected-specification" ||
  command.type === "project-work.criterion.waive" ||
  command.type === "project-work.decision.accept" ||
  command.type === "project-work.decision.reject" ||
  command.type === "project-work.decision.supersede" ||
  (command.type === "project-work.evidence.add" && command.evidence.kind === "external");

const isProtectedRevision = (
  command: ProjectWorkCommand,
): command is Extract<
  ProjectWorkCommand,
  { readonly type: "project-work.task.revise-protected-specification" }
> => command.type === "project-work.task.revise-protected-specification";

const approvalTaskIdFor = (command: ProjectWorkCommand): string => {
  if ("taskId" in command && command.taskId !== undefined) return String(command.taskId);
  if (command.type === "project-work.evidence.add" && command.evidence.taskId !== undefined) {
    return String(command.evidence.taskId);
  }
  return `project:${String(command.projectId)}`;
};

const approvalSpecRevisionFor = (command: ProjectWorkCommand): number =>
  "specRevision" in command && typeof command.specRevision === "number"
    ? command.specRevision
    : isProtectedRevision(command)
      ? command.approval.specRevision
      : 0;

const withoutApprovalToken = (command: ProjectWorkCommand): ProjectWorkCommand => {
  if (!("approvalToken" in command)) return command;
  const { approvalToken: _approvalToken, ...withoutToken } = command;
  return withoutToken as ProjectWorkCommand;
};

const attributionFor = (
  actor: ProjectWorkActor,
  source: ProjectWorkAttribution["source"],
  recordedAt: string,
): ProjectWorkAttribution => ({ actor, source, recordedAt });

const optionValue = <A>(value: Option.Option<A>): A | undefined =>
  Option.isSome(value) ? value.value : undefined;

const withAttribution = <T extends { readonly attribution?: ProjectWorkAttribution }>(
  value: T,
  attribution: ProjectWorkAttribution,
): T => ({ ...value, attribution });

const canonicalizeCriterion = (
  criterion: ProjectWorkCriterion,
  attribution: ProjectWorkAttribution,
) =>
  criterion.waiver === undefined
    ? criterion
    : { ...criterion, waiver: withAttribution(criterion.waiver, attribution) };

/** Replace every author supplied by a transport with the authenticated author.
 * Target actors (assignees and watchers) are deliberately not changed. */
const canonicalizeCommand = (
  command: ProjectWorkCommand,
  attribution: ProjectWorkAttribution,
): ProjectWorkCommand => {
  const base = { ...command, attribution };
  switch (command.type) {
    case "project-work.criterion.waive":
      return {
        ...base,
        waiver: withAttribution(command.waiver, attribution),
      } as ProjectWorkCommand;
    case "project-work.criterion.upsert":
      return {
        ...base,
        criterion: canonicalizeCriterion(command.criterion, attribution),
      } as ProjectWorkCommand;
    case "project-work.evidence.add":
      return {
        ...base,
        evidence: withAttribution(command.evidence, attribution),
      } as ProjectWorkCommand;
    case "project-work.relationship.link":
      return {
        ...base,
        relationship: withAttribution(command.relationship, attribution),
      } as ProjectWorkCommand;
    case "project-work.knowledge.promote":
      return {
        ...base,
        knowledge: withAttribution(command.knowledge, attribution),
      } as ProjectWorkCommand;
    case "project-work.decision.propose":
      return {
        ...base,
        decision: withAttribution(command.decision, attribution),
      } as ProjectWorkCommand;
    case "project-work.decision.supersede":
      return {
        ...base,
        replacement: withAttribution(command.replacement, attribution),
      } as ProjectWorkCommand;
    case "project-work.comment.add":
      return {
        ...base,
        comment: withAttribution(command.comment, attribution),
      } as ProjectWorkCommand;
    case "project-work.task.revise-protected-specification":
      return {
        ...base,
        criterionSnapshots: command.criterionSnapshots.map((criterion) =>
          canonicalizeCriterion(criterion, attribution),
        ),
      } as ProjectWorkCommand;
    default:
      return base as ProjectWorkCommand;
  }
};

const canonicalizeProtectedRevisionFingerprint = (
  command: ProjectWorkCommand,
): ProjectWorkCommand => {
  if (!isProtectedRevision(command)) return command;
  return {
    ...command,
    approval: {
      ...command.approval,
      payloadFingerprint: projectWorkPayloadFingerprint(
        projectWorkProtectedRevisionFingerprintPayload(command),
      ),
    },
  } as ProjectWorkCommand;
};

const PUBLIC_MAX_STRING_LENGTH = 32_000;
const PUBLIC_MAX_ARRAY_ITEMS = 1_000;
const PUBLIC_MAX_OBJECT_KEYS = 256;
const PUBLIC_MAX_DEPTH = 12;
const PUBLIC_SENSITIVE_KEY = /(token|secret|password|credential|authorization|api[-_]?key)/i;
const PUBLIC_TOKEN_BUDGET_KEYS = new Set([
  "tokenLimit",
  "maxTokens",
  "maximumTokens",
  "consumedTokens",
]);
// Public gate references and grant metadata preserve typed foundation records.
const PUBLIC_FOUNDATION_REFERENCE_KEYS = new Set([
  "authorizationGateId",
  "assignmentAuthorization",
  "repairAuthorization",
]);
const sanitizePublicValue = (value: unknown, depth = 0, foundation = false): unknown => {
  if (depth > PUBLIC_MAX_DEPTH) return "[omitted: maximum output depth]";
  if (typeof value === "string") {
    return value.length > PUBLIC_MAX_STRING_LENGTH
      ? `${value.slice(0, PUBLIC_MAX_STRING_LENGTH)}…[truncated]`
      : value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, PUBLIC_MAX_ARRAY_ITEMS)
      .map((entry) => sanitizePublicValue(entry, depth + 1, foundation));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, PUBLIC_MAX_OBJECT_KEYS)
      .filter(
        ([key, entry]) =>
          !PUBLIC_SENSITIVE_KEY.test(key) ||
          (foundation &&
            ((PUBLIC_TOKEN_BUDGET_KEYS.has(key) && typeof entry === "number") ||
              PUBLIC_FOUNDATION_REFERENCE_KEYS.has(key))),
      )
      .map(([key, entry]) => [key, sanitizePublicValue(entry, depth + 1, foundation)]),
  );
};

const decodeVerificationSelection = Schema.decodeUnknownEffect(
  ProjectWorkVerificationPreparationSelection,
  { onExcessProperty: "error" },
);
const decodeVerificationPreview = Schema.decodeUnknownEffect(ProjectWorkVerificationJobRead, {
  onExcessProperty: "error",
});
const decodeIntegrationSourcePage = Schema.decodeUnknownEffect(ProjectTeamIntegrationSourcePage);
const decodeSupervision = Schema.decodeUnknownEffect(ProjectTeamSupervisionSummary);
const decodeMemorySourceContent = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const SUPERVISION_CAPTIONS = new Set(["name", "title", "reason"]);
const SUPERVISION_IDENTITY = /\.(?:[A-Za-z]*Id|availability)$/u;

// Redaction may expand a short secret. Bound display text after that expansion,
// without changing the authoritative identities used by inspection links.
const boundSupervisionText = (value: unknown, key = ""): unknown => {
  if (typeof value === "string") {
    const limit = SUPERVISION_CAPTIONS.has(key) ? 240 : 4_000;
    if (value.length <= limit) return value;
    const bounded = value.slice(0, limit);
    const last = bounded.charCodeAt(bounded.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? bounded.slice(0, -1) : bounded;
  }
  if (Array.isArray(value)) return value.map((entry) => boundSupervisionText(entry));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, boundSupervisionText(entry, key)]),
    );
  return value;
};
const publicSupervision = Effect.fn("ProjectWorkGateway.publicSupervision")(function* (
  value: unknown,
  redactions: ReadonlyArray<string>,
) {
  const changedIdentities = redactions.filter((path) => SUPERVISION_IDENTITY.test(path));
  if (changedIdentities.length > 0)
    return yield* new ProjectWorkContentRejectedError({
      matches: changedIdentities.map((path) => ({ path, kind: "redacted-identity" })),
    });
  return yield* decodeSupervision(boundSupervisionText(value));
});

const makeProjectWorkGateway = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const verification = yield* Effect.serviceOption(ProjectWorkVerification);
  const issueComments = yield* Effect.serviceOption(IssueComments.ProjectIssueComments);
  const repository = yield* ProjectWorkRepository.ProjectWorkRepository;
  const query = yield* ProjectWorkQuery.ProjectWorkQuery;
  const search = yield* ProjectWorkSearch.ProjectWorkSearch;
  const briefing = yield* ProjectWorkBriefing.ProjectWorkBriefing;
  const narrative = yield* ProjectWorkNarrative.ProjectWorkNarrative;
  const attention = yield* Effect.serviceOption(
    ProjectWorkAttentionReactor.ProjectWorkAttentionReactor,
  );
  const contentGuard = yield* Effect.serviceOption(ProjectWorkContentGuard.ProjectWorkContentGuard);
  const exporter = yield* Effect.serviceOption(ProjectWorkExport.ProjectWorkExport);
  // Identity is a separate service so exports never derive an environment
  // identifier from transport input. The full descriptor service remains a
  // fallback for runtimes that expose only ServerEnvironment.
  const environmentIdentity = yield* Effect.serviceOption(
    ServerEnvironment.ServerEnvironmentIdentity,
  );
  const serverEnvironment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const projectLifecycle = yield* Effect.serviceOption(ProjectLifecycle.ProjectLifecycle);
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const teamAuthorization = yield* Effect.serviceOption(
    ProjectTeamAuthorization.ProjectTeamAuthorization,
  );
  const usageServices = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const base = effect.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(ProjectWorkRepository.ProjectWorkRepository, repository),
    );
    const authorized = Option.isSome(teamAuthorization)
      ? base.pipe(
          Effect.provideService(
            ProjectTeamAuthorization.ProjectTeamAuthorization,
            teamAuthorization.value,
          ),
        )
      : base;
    return Option.isSome(environmentIdentity)
      ? authorized.pipe(
          Effect.provideService(
            ServerEnvironment.ServerEnvironmentIdentity,
            environmentIdentity.value,
          ),
        )
      : authorized;
  };

  const verificationGate = (environmentId: string) =>
    Effect.gen(function* () {
      return yield* makeProjectWorkVerificationGate({
        environmentId,
        maximumEnvironmentModelCalls: 128,
      });
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(ProjectWorkRepository.ProjectWorkRepository, repository),
    );

  const executeAuthorized = <E, L = never>(
    command: ProjectWorkCommand,
    authorize: (input: {
      readonly commandFingerprint: string;
    }) => Effect.Effect<ProjectWorkCommand, E>,
    liveValidate?: (input: { readonly duplicate: boolean }) => Effect.Effect<void, L>,
    receiptFingerprint?: string,
  ) =>
    Effect.suspend(() => {
      let denial: ProjectTeamAuthorization.ProjectTeamAuthorizationError | undefined;
      const captureDenial = <A, Error>(effect: Effect.Effect<A, Error>) =>
        effect.pipe(
          Effect.tapCause((cause) =>
            Effect.sync(() => {
              const reason = cause.reasons[0];
              if (
                cause.reasons.length === 1 &&
                reason?._tag === "Fail" &&
                isTeamAuthorizationError(reason.error)
              )
                denial = reason.error;
            }),
          ),
        );
      return repository
        .executeAuthorized(
          command,
          (input) => captureDenial(authorize(input)),
          liveValidate === undefined ? undefined : (input) => captureDenial(liveValidate(input)),
          receiptFingerprint,
        )
        .pipe(
          // Restore only a sole callback denial after successful rollback. Mixed
          // transaction failures retain their defects/interruption and uncertainty.
          Effect.catchCause((cause) =>
            Effect.failCause(
              Cause.map(cause, (error) =>
                cause.reasons.length === 1 &&
                denial !== undefined &&
                isPersistenceSqlError(error) &&
                error.operation === "ProjectWorkRepository.executeAuthorized" &&
                error.cause === denial
                  ? denial
                  : error,
              ),
            ),
          ),
        );
    });

  const readRaw = (input: ProjectWorkReadIntent) => {
    const base = { projectId: String(input.projectId) };
    const requestedLimit =
      input.limit === undefined || !Number.isFinite(input.limit)
        ? 50
        : Math.min(1_000, Math.max(0, Math.floor(input.limit)));
    const boundedInput = {
      ...input,
      ...(input.limit === undefined && input.envelope !== true
        ? {}
        : { limit: requestedLimit + (input.envelope === true ? 1 : 0) }),
      ...(input.offset === undefined
        ? {}
        : {
            offset: Number.isFinite(input.offset)
              ? Math.min(1_000_000, Math.max(0, Math.floor(input.offset)))
              : 0,
          }),
    };
    const result: Effect.Effect<unknown, ProjectionRepositoryError> = (() => {
      switch (boundedInput.operation) {
        case "memory-sources":
        case "memory-shared-sources":
        case "integration-sources":
        case "verification-job":
          return Effect.fail(
            toPersistenceSqlError("ProjectWorkGateway.read")(
              new Error("Verification job requires its private read boundary"),
            ),
          );
        case "supervision":
          return Effect.gen(function* () {
            const settings = yield* serverSettings.getSettings.pipe(
              Effect.mapError(toPersistenceSqlError("ProjectWorkGateway.read")),
            );
            if (!settings.projectWorkEnabled)
              return { ...base, availability: "unsupported" as const };
            return yield* usageServices(readProjectTeamSupervision(sql, base));
          });
        case "issue-comments":
          return Effect.fail(
            toPersistenceSqlError("ProjectWorkGateway.read")(
              new IssueComments.IssueCommentsError({ reason: "unavailable" }),
            ),
          );
        case "foundation-records":
          return usageServices(
            query.listFoundationRecords({
              ...base,
              ...(boundedInput.cursor === undefined ? {} : { cursor: boundedInput.cursor }),
              ...(boundedInput.limit === undefined ? {} : { limit: boundedInput.limit }),
              ...(boundedInput.recordKinds === undefined
                ? {}
                : { kinds: boundedInput.recordKinds }),
            }),
          );
        case "snapshot":
          return query.snapshot(base.projectId);
        case "task":
          return boundedInput.taskId === undefined
            ? Effect.succeed(undefined)
            : query.getTask(base.projectId, boundedInput.taskId).pipe(Effect.map(optionValue));
        case "task-context":
          return boundedInput.taskId === undefined
            ? Effect.succeed(undefined)
            : query
                .getTaskContext(base.projectId, boundedInput.taskId)
                .pipe(Effect.map(optionValue));
        case "tasks":
          return query.listTasks({
            ...base,
            ...(boundedInput.envelope === true ? { trusted: true as const } : {}),
            ...(boundedInput.state === undefined ? {} : { state: boundedInput.state }),
            ...(boundedInput.limit === undefined ? {} : { limit: boundedInput.limit }),
            ...(boundedInput.offset === undefined ? {} : { offset: boundedInput.offset }),
          });
        case "attempts":
          return query.listAttempts({
            ...base,
            ...(boundedInput.envelope === true ? { trusted: true as const } : {}),
            ...(boundedInput.taskId === undefined ? {} : { taskId: boundedInput.taskId }),
            ...(boundedInput.limit === undefined ? {} : { limit: boundedInput.limit }),
            ...(boundedInput.offset === undefined ? {} : { offset: boundedInput.offset }),
          });
        case "criteria":
          return query.listCriteria({
            ...base,
            ...(boundedInput.envelope === true ? { trusted: true as const } : {}),
            ...(boundedInput.taskId === undefined ? {} : { taskId: boundedInput.taskId }),
            ...(boundedInput.limit === undefined ? {} : { limit: boundedInput.limit }),
            ...(boundedInput.offset === undefined ? {} : { offset: boundedInput.offset }),
          });
        case "evidence":
          return query.listEvidence({
            ...base,
            ...(boundedInput.envelope === true ? { trusted: true as const } : {}),
            ...(boundedInput.taskId === undefined ? {} : { taskId: boundedInput.taskId }),
            ...(boundedInput.criterionId === undefined
              ? {}
              : { criterionId: boundedInput.criterionId }),
            ...(boundedInput.limit === undefined ? {} : { limit: boundedInput.limit }),
            ...(boundedInput.offset === undefined ? {} : { offset: boundedInput.offset }),
          });
        case "relationships":
          return query.listRelationships({
            ...base,
            ...(boundedInput.envelope === true ? { trusted: true as const } : {}),
            ...(boundedInput.limit === undefined ? {} : { limit: boundedInput.limit }),
            ...(boundedInput.offset === undefined ? {} : { offset: boundedInput.offset }),
          });
        case "blockers":
          return query.listBlockers({
            ...base,
            ...(boundedInput.envelope === true ? { trusted: true as const } : {}),
            ...(boundedInput.taskId === undefined ? {} : { taskId: boundedInput.taskId }),
            ...(boundedInput.state === undefined
              ? {}
              : { activeOnly: boundedInput.state === "active" }),
            ...(boundedInput.limit === undefined ? {} : { limit: boundedInput.limit }),
            ...(boundedInput.offset === undefined ? {} : { offset: boundedInput.offset }),
          });
        case "attention":
          return query.listAttention({
            ...base,
            ...(boundedInput.envelope === true ? { trusted: true as const } : {}),
            ...(boundedInput.limit === undefined ? {} : { limit: boundedInput.limit }),
            ...(boundedInput.offset === undefined ? {} : { offset: boundedInput.offset }),
          });
        case "activities":
          return query.listActivities({
            ...base,
            ...(boundedInput.envelope === true ? { trusted: true as const } : {}),
            ...(boundedInput.taskId === undefined ? {} : { taskId: boundedInput.taskId }),
            ...(boundedInput.attemptId === undefined ? {} : { attemptId: boundedInput.attemptId }),
            ...(boundedInput.limit === undefined ? {} : { limit: boundedInput.limit }),
            ...(boundedInput.offset === undefined ? {} : { offset: boundedInput.offset }),
          });
        case "checkpoints":
          return query.listCheckpoints({
            ...base,
            ...(boundedInput.envelope === true ? { trusted: true as const } : {}),
            ...(boundedInput.taskId === undefined ? {} : { taskId: boundedInput.taskId }),
            ...(boundedInput.attemptId === undefined ? {} : { attemptId: boundedInput.attemptId }),
            ...(boundedInput.limit === undefined ? {} : { limit: boundedInput.limit }),
            ...(boundedInput.offset === undefined ? {} : { offset: boundedInput.offset }),
          });
        case "knowledge":
          return query.listKnowledge({
            ...base,
            ...(boundedInput.envelope === true ? { trusted: true as const } : {}),
            ...(boundedInput.limit === undefined ? {} : { limit: boundedInput.limit }),
            ...(boundedInput.offset === undefined ? {} : { offset: boundedInput.offset }),
          });
        case "decisions":
          return query.listDecisions({
            ...base,
            ...(boundedInput.envelope === true ? { trusted: true as const } : {}),
            ...(boundedInput.state === undefined ? {} : { state: boundedInput.state }),
            ...(boundedInput.limit === undefined ? {} : { limit: boundedInput.limit }),
            ...(boundedInput.offset === undefined ? {} : { offset: boundedInput.offset }),
          });
        case "comments":
          return query.listComments({
            ...base,
            ...(boundedInput.envelope === true ? { trusted: true as const } : {}),
            ...(boundedInput.taskId === undefined ? {} : { taskId: boundedInput.taskId }),
            ...(boundedInput.limit === undefined ? {} : { limit: boundedInput.limit }),
            ...(boundedInput.offset === undefined ? {} : { offset: boundedInput.offset }),
          });
        case "search":
          return search.search({
            projectId: base.projectId,
            query: boundedInput.query ?? "",
            ...(boundedInput.state === undefined ? {} : { state: boundedInput.state }),
            ...(boundedInput.taskId === undefined ? {} : { taskId: boundedInput.taskId }),
            ...(boundedInput.limit === undefined ? {} : { limit: boundedInput.limit }),
            ...(boundedInput.offset === undefined ? {} : { offset: boundedInput.offset }),
            ...(boundedInput.includeActivity === undefined
              ? {}
              : { includeActivity: boundedInput.includeActivity }),
            ...(boundedInput.recordKinds === undefined
              ? {}
              : { recordKinds: boundedInput.recordKinds }),
          });
        case "briefing":
          return briefing.generate({
            projectId: base.projectId,
            kind: boundedInput.kind ?? "standard",
          });
        case "narrative":
          return Effect.all({
            built: briefing.generate({
              projectId: base.projectId,
              kind: input.kind ?? "standard",
            }),
            settings: serverSettings.getSettings.pipe(Effect.option),
          }).pipe(
            Effect.flatMap(({ built, settings }) => {
              if (Option.isNone(settings)) return Effect.succeed(built);
              const modelSelection = resolveProjectSettings(settings.value, input.projectId)
                .settings.textGenerationModelSelection;
              return narrative
                .get({
                  projectId: base.projectId,
                  kind: built.kind,
                  modelSelection,
                  sourceRevision: built.sourceRevision,
                })
                .pipe(
                  Effect.map((found) =>
                    found === undefined
                      ? built
                      : {
                          ...built,
                          narrative: found.narrative,
                          narrativeModel: found.model,
                          narrativeGeneratedAt: found.generatedAt,
                        },
                  ),
                );
            }),
          );
        case "export-json":
          return Effect.gen(function* () {
            const exported = yield* query.exportSnapshot(
              base.projectId,
              boundedInput.includeHistory === true,
              boundedInput.exportVersion === 2,
            );
            const environmentId =
              environmentIdentity._tag === "Some"
                ? yield* environmentIdentity.value.getEnvironmentId
                : serverEnvironment._tag === "Some"
                  ? yield* serverEnvironment.value.getEnvironmentId
                  : "unknown";
            if (exporter._tag === "Some")
              return yield* exporter.value.json(exported.snapshot, {
                environmentId,
                version: boundedInput.exportVersion ?? 1,
                ...(exported.foundationRecords === undefined
                  ? {}
                  : { foundationRecords: exported.foundationRecords }),
                ...(exported.history === undefined ? {} : { history: exported.history }),
              });
            return ProjectWorkExport.buildProjectWorkJsonExport(exported.snapshot, {
              environmentId,
              version: boundedInput.exportVersion ?? 1,
              ...(exported.foundationRecords === undefined
                ? {}
                : { foundationRecords: exported.foundationRecords }),
              ...(exported.history === undefined ? {} : { history: exported.history }),
            });
          });
        case "export-markdown":
          return Effect.gen(function* () {
            const snapshot = yield* query.snapshot(base.projectId);
            if (exporter._tag === "Some") return yield* exporter.value.markdown(snapshot);
            return ProjectWorkExport.buildProjectWorkMarkdownExport(snapshot, {});
          });
      }
    })();
    const collectionOperations = new Set([
      "tasks",
      "attempts",
      "criteria",
      "evidence",
      "relationships",
      "blockers",
      "attention",
      "activities",
      "checkpoints",
      "knowledge",
      "decisions",
      "comments",
    ]);
    const shaped =
      boundedInput.envelope === true && collectionOperations.has(boundedInput.operation)
        ? query.withProjectRevision(base.projectId, result).pipe(
            Effect.map(({ value, revision }) => {
              const items = Array.isArray(value) ? value : [];
              return {
                projectId: input.projectId,
                revision,
                offset: boundedInput.offset ?? 0,
                limit: requestedLimit,
                hasMore: items.length > requestedLimit,
                items: items.slice(0, requestedLimit),
              };
            }),
          )
        : result;
    if (boundedInput.operation === "export-json") return shaped;
    return shaped.pipe(
      Effect.flatMap((value: unknown) =>
        (contentGuard._tag === "Some"
          ? contentGuard.value.redact(value)
          : Effect.succeed(redactProjectWorkContent(value))
        ).pipe(
          Effect.flatMap(({ value: redacted, redactions }) =>
            boundedInput.operation === "supervision"
              ? publicSupervision(sanitizePublicValue(redacted), redactions)
              : Effect.succeed(
                  sanitizePublicValue(redacted, 0, boundedInput.operation === "foundation-records"),
                ),
          ),
        ),
      ),
    );
  };

  const writeCommand = (
    command: ProjectWorkCommand,
    actor: ProjectWorkActor,
    source: ProjectWorkAttribution["source"],
    principal?: ProjectTeamAuthorization.ProjectTeamPrincipal,
  ) =>
    Effect.gen(function* () {
      const caller = principal ?? { actor };
      if (caller.actor.kind !== actor.kind || caller.actor.id !== actor.id)
        return yield* new ProjectWorkAuthorizationError({ reason: "spoofed-attribution" });
      if (caller.managed !== undefined && teamAuthorization._tag === "None")
        return yield* new ProjectTeamAuthorization.ProjectTeamAuthorizationError({
          reason: "Managed authority unavailable",
        });
      const executeCommandAuthorized = <E>(
        input: ProjectWorkCommand,
        authorize: (input: {
          readonly commandFingerprint: string;
        }) => Effect.Effect<ProjectWorkCommand, E>,
      ) =>
        executeAuthorized(input, authorize, () =>
          Effect.gen(function* () {
            if (command.type === "project-work.issue.refine") yield* fence;
            if (teamAuthorization._tag === "Some")
              yield* teamAuthorization.value.write(caller, command);
          }),
        );
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          () =>
            new ProjectWorkAuthorizationError({
              reason: "project-work-disabled",
            }),
        ),
      );
      if (!settings.projectWorkEnabled) {
        return yield* new ProjectWorkAuthorizationError({
          reason: "project-work-disabled",
        });
      }
      if (command.type === "project-work.foundation.commit")
        return yield* new ProjectWorkAuthorizationError({ reason: "project-work-disabled" });
      if (
        command.type === "project-work.issue.refine" &&
        (actor.kind !== "human" || caller.managed !== undefined)
      )
        return yield* new ProjectWorkAuthorizationError({ reason: "agent-approval-required" });
      const fence = assertProjectAcceptsMutations(sql, String(command.projectId)).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectWorkAuthorizationError({
              reason: cause.reason === "storage" ? "unknown-project" : cause.reason,
            }),
        ),
      );
      // A retained tombstone is the durable guard against stale clients
      // recreating locally deleted project work after its event rows are
      // purged. Lightweight gateway tests may omit the lifecycle service;
      // production routes always provide it with the lifecycle migration.
      if (Option.isSome(projectLifecycle)) {
        const lifecycle = yield* projectLifecycle.value
          .get(command.projectId)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (lifecycle?.state === "tombstoned") {
          return yield* new ProjectWorkAuthorizationError({
            reason: "project-tombstoned",
          });
        }
      }
      yield* contentGuard._tag === "Some"
        ? contentGuard.value.assertCommandSafe(command)
        : Effect.try({
            try: () => assertProjectWorkCommandContentSafe(command),
            catch: (cause) =>
              isProjectWorkContentRejectedError(cause)
                ? cause
                : new ProjectWorkContentRejectedError({ matches: [] }),
          });
      if (
        command.attribution !== undefined &&
        (command.attribution.actor.kind !== actor.kind || command.attribution.actor.id !== actor.id)
      ) {
        return yield* new ProjectWorkAuthorizationError({
          reason: "spoofed-attribution",
        });
      }
      if (actor.kind === "agent" && sensitiveAgentIntent(command)) {
        if (!("approvalToken" in command) || command.approvalToken === undefined) {
          return yield* new ProjectWorkAuthorizationError({
            reason: "agent-approval-required",
          });
        }
      }
      const recordedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      // Protected revision intents carry their attribution in the approval
      // payload. Preserve its timestamp while replacing actor/source with the
      // authenticated transport values; otherwise the server-generated
      // timestamp would make the approved fingerprint impossible to replay.
      const attributionRecordedAt =
        isProtectedRevision(command) && actor.kind === "agent"
          ? (command.attribution?.recordedAt ?? recordedAt)
          : recordedAt;
      let authorizedCommand = canonicalizeCommand(
        command,
        attributionFor(actor, source, attributionRecordedAt),
      );
      // Human approvals are already authenticated by the transport. Their
      // request attribution is still normalized above, so bind the complete
      // protected payload again after that normalization before the decider
      // verifies it.
      if (isProtectedRevision(authorizedCommand) && actor.kind !== "agent") {
        authorizedCommand = canonicalizeProtectedRevisionFingerprint(authorizedCommand);
      }
      if (isProtectedRevision(command) && actor.kind === "agent") {
        const approvalToken = command.approvalToken;
        if (approvalToken === undefined) {
          return yield* new ProjectWorkAuthorizationError({
            reason: "agent-approval-required",
          });
        }
        const expectedFingerprintBeforeConsumption = projectWorkPayloadFingerprint(
          projectWorkProtectedRevisionFingerprintPayload(
            authorizedCommand as Extract<
              ProjectWorkCommand,
              {
                readonly type: "project-work.task.revise-protected-specification";
              }
            >,
          ),
        );
        const intentFingerprint = projectWorkPayloadFingerprint(
          projectWorkProtectedRevisionIntentFingerprintPayload(
            authorizedCommand as Extract<
              ProjectWorkCommand,
              {
                readonly type: "project-work.task.revise-protected-specification";
              }
            >,
          ),
        );
        if (
          command.approval.payloadFingerprint !== expectedFingerprintBeforeConsumption &&
          command.approval.payloadFingerprint !== intentFingerprint
        ) {
          return yield* new ProjectWorkAuthorizationError({
            reason: "invalid-approval",
          });
        }
        const approvalInput = {
          token: approvalToken,
          projectId: String(command.projectId),
          taskId: String(command.taskId),
          specRevision: command.approval.specRevision,
          agentId: actor.id ?? "anonymous-agent",
        };
        const approvalPayloadFingerprint = command.approval.payloadFingerprint;
        const requestedFingerprint =
          approvalPayloadFingerprint === intentFingerprint
            ? intentFingerprint
            : approvalPayloadFingerprint === expectedFingerprintBeforeConsumption
              ? expectedFingerprintBeforeConsumption
              : undefined;
        if (requestedFingerprint === undefined) {
          return yield* new ProjectWorkAuthorizationError({
            reason: "invalid-approval",
          });
        }
        const approval = yield* executeCommandAuthorized(authorizedCommand, () =>
          Effect.gen(function* () {
            yield* fence;
            const consumed = yield* auth.consumeProjectWorkApproval({
              ...approvalInput,
              payloadFingerprint: requestedFingerprint,
            });
            if (
              consumed.approvalId !== command.approval.approvalId ||
              consumed.taskId !== command.approval.taskId ||
              consumed.specRevision !== command.approval.specRevision
            ) {
              return yield* new ProjectWorkAuthorizationError({
                reason: "invalid-approval",
              });
            }
            const expectedFingerprint = projectWorkPayloadFingerprint(
              projectWorkProtectedRevisionFingerprintPayload({
                ...(authorizedCommand as Extract<
                  ProjectWorkCommand,
                  {
                    readonly type: "project-work.task.revise-protected-specification";
                  }
                >),
                approval: consumed,
              }),
            );
            const protectedCommand = authorizedCommand as Extract<
              ProjectWorkCommand,
              {
                readonly type: "project-work.task.revise-protected-specification";
              }
            >;
            const { approvalToken: _approvalToken, ...withoutToken } = protectedCommand;
            return {
              ...withoutToken,
              approval: {
                ...consumed,
                payloadFingerprint: expectedFingerprint,
              },
            } as ProjectWorkCommand;
          }),
        ).pipe(
          Effect.catchCause((failure) =>
            Effect.failCause(
              Cause.map(failure, (cause) => {
                if (
                  Schema.is(ProjectWorkAuthorizationError)(cause) ||
                  Schema.is(EnvironmentAuth.ServerAuthProjectWorkApprovalError)(cause) ||
                  cause instanceof ProjectWorkPolicyError ||
                  isPersistenceError(cause) ||
                  isTeamAuthorizationError(cause)
                ) {
                  return cause;
                }
                return toPersistenceSqlError("ProjectWorkGateway.write")(cause);
              }),
            ),
          ),
        );
        if (Option.isSome(attention))
          yield* attention.value.onCommitted({
            projectId: String(command.projectId),
            state: approval.state,
            events: approval.events,
          });
        return sanitizePublicValue(approval.writeResult) as ProjectWorkWriteReceipt;
      }
      const result =
        actor.kind === "agent" && sensitiveAgentIntent(command)
          ? yield* executeCommandAuthorized(authorizedCommand, ({ commandFingerprint }) =>
              Effect.gen(function* () {
                yield* fence;
                const approvalToken =
                  "approvalToken" in authorizedCommand
                    ? authorizedCommand.approvalToken
                    : undefined;
                if (approvalToken === undefined) {
                  return yield* new ProjectWorkAuthorizationError({
                    reason: "agent-approval-required",
                  });
                }
                yield* auth.consumeProjectWorkApproval({
                  token: approvalToken,
                  projectId: String(command.projectId),
                  taskId: approvalTaskIdFor(command),
                  specRevision: approvalSpecRevisionFor(command),
                  payloadFingerprint: commandFingerprint,
                  agentId: actor.id ?? "anonymous-agent",
                });
                return withoutApprovalToken(authorizedCommand);
              }),
            ).pipe(
              Effect.catchCause((failure) =>
                Effect.failCause(
                  Cause.map(failure, (cause) => {
                    if (
                      Schema.is(ProjectWorkAuthorizationError)(cause) ||
                      Schema.is(EnvironmentAuth.ServerAuthProjectWorkApprovalError)(cause) ||
                      cause instanceof ProjectWorkPolicyError ||
                      isPersistenceError(cause) ||
                      isTeamAuthorizationError(cause)
                    ) {
                      return cause;
                    }
                    return toPersistenceSqlError("ProjectWorkGateway.write")(cause);
                  }),
                ),
              ),
            )
          : yield* executeCommandAuthorized(authorizedCommand, () =>
              fence.pipe(Effect.as(authorizedCommand)),
            );
      if (Option.isSome(attention))
        yield* attention.value.onCommitted({
          projectId: String(command.projectId),
          state: result.state,
          events: result.events,
        });
      return sanitizePublicValue(result.writeResult) as ProjectWorkWriteReceipt;
    });

  const read: ProjectWorkGatewayShape["read"] = (input, principal) => {
    if (input.operation === "memory-sources" || input.operation === "memory-shared-sources")
      return sql
        .withTransaction(
          Effect.gen(function* () {
            const deny = () =>
              new ProjectTeamAuthorization.ProjectTeamAuthorizationError({
                reason: "Assigned memory source candidates unavailable",
              });
            if (
              principal?.managed === undefined ||
              Option.isNone(teamAuthorization) ||
              input.taskId === undefined
            )
              return yield* deny();
            const settings = yield* serverSettings.getSettings;
            if (!settings.projectWorkEnabled) return yield* deny();
            yield* teamAuthorization.value.read(principal, input);
            const authority = yield* teamAuthorization.value.resolve(principal);
            if (authority === undefined) return yield* deny();
            const page =
              input.operation === "memory-shared-sources"
                ? yield* readProjectMemorySharedSources(sql, input, authority)
                : yield* Effect.gen(function* () {
                    const processing = yield* makeProjectMemoryProcessing;
                    return yield* processing.readSourcesInTransaction(input, authority);
                  });
            yield* teamAuthorization.value.read(principal, input);
            if (!(yield* serverSettings.getSettings).projectWorkEnabled) return yield* deny();
            return page;
          }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ProjectWorkRepository.ProjectWorkRepository, repository),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            isTeamAuthorizationError(cause)
              ? cause
              : toPersistenceSqlError("ProjectWorkGateway.read")(cause),
          ),
        );
    if (input.operation === "integration-sources")
      return sql
        .withTransaction(
          Effect.gen(function* () {
            const deny = () =>
              new ProjectTeamAuthorization.ProjectTeamAuthorizationError({
                reason: "Current human integration source candidates unavailable",
              });
            const request = yield* Effect.serviceOption(ProjectWorkVerificationRequest);
            if (
              !principal ||
              principal.actor.kind !== "human" ||
              principal.managed !== undefined ||
              Option.isNone(request) ||
              Option.isNone(teamAuthorization) ||
              input.taskId === undefined
            )
              return yield* deny();
            yield* request.value
              .assertCurrent(principal, input.projectId, "read")
              .pipe(Effect.mapError(deny));
            const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(deny));
            if (!settings.projectWorkEnabled) return yield* deny();
            yield* teamAuthorization.value.read(principal, input);
            const environmentId = Option.isSome(environmentIdentity)
              ? yield* environmentIdentity.value.getEnvironmentId.pipe(Effect.mapError(deny))
              : Option.isSome(serverEnvironment)
                ? yield* serverEnvironment.value.getEnvironmentId.pipe(Effect.mapError(deny))
                : undefined;
            if (environmentId === undefined) return yield* deny();
            const service = yield* makeProjectTeamIntegrationSources({ environmentId }).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.provideService(ProjectWorkRepository.ProjectWorkRepository, repository),
              Effect.mapError(deny),
            );
            const state = yield* ProjectWorkRepository.readCurrentState(sql, input.projectId);
            const task = state.tasks.find((entry) => entry.taskId === input.taskId);
            if (task === undefined) return yield* deny();
            const candidates = yield* service
              .candidatesInTransaction({
                projectId: input.projectId,
                integrationTaskId: task.taskId,
                offset: Math.min(1_000_000, input.offset ?? 0),
                limit: Math.min(64, input.limit ?? 50),
              })
              .pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(deny));
            const page = {
              ...candidates,
              environmentId,
              projectId: input.projectId,
              taskId: task.taskId,
              revision: state.revision,
              taskRevision: task.revision,
            };
            const redacted =
              contentGuard._tag === "Some"
                ? (yield* contentGuard.value.redact(page)).value
                : redactProjectWorkContent(page).value;
            const decoded = yield* decodeIntegrationSourcePage(redacted).pipe(
              Effect.mapError(deny),
            );
            if (
              canonicalProjectWorkPayload(
                decoded.candidates.map(({ ref, source }) => ({ ref, source })),
              ) !==
              canonicalProjectWorkPayload(
                page.candidates.map(({ ref, source }) => ({ ref, source })),
              )
            )
              return yield* deny();
            yield* request.value
              .assertCurrent(principal, input.projectId, "read")
              .pipe(Effect.mapError(deny));
            return sanitizePublicValue(decoded);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isTeamAuthorizationError(cause)
              ? cause
              : toPersistenceSqlError("ProjectWorkGateway.read")(cause),
          ),
        );
    if (input.operation === "verification-job")
      return Effect.gen(function* () {
        const denied = () =>
          new ProjectTeamAuthorization.ProjectTeamAuthorizationError({
            reason: "Current human verification preview unavailable",
          });
        const request = yield* Effect.serviceOption(ProjectWorkVerificationRequest);
        if (
          !principal ||
          Option.isNone(request) ||
          Option.isNone(verification) ||
          input.taskId === undefined ||
          input.verificationJobId === undefined
        )
          return yield* denied();
        const projectId = input.projectId,
          taskId = input.taskId,
          jobId = input.verificationJobId;
        const authorize = Effect.gen(function* () {
          yield* request.value
            .assertCurrent(principal, projectId, "read")
            .pipe(Effect.mapError(denied));
          const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(denied));
          if (!settings.projectWorkEnabled || Option.isNone(teamAuthorization))
            return yield* denied();
          yield* teamAuthorization.value.read(principal, input);
          const state = yield* ProjectWorkRepository.readCurrentState(sql, projectId);
          const gates = (state.foundationRecords ?? []).filter(
            (row) =>
              row.kind === "gate" &&
              row.gate === "verification" &&
              row.taskId === taskId &&
              row.verificationJobId === jobId,
          );
          if (gates.length !== 1 || gates[0]?.kind !== "gate") return yield* denied();
          return gates[0].contentHash;
        });
        const before = yield* sql.withTransaction(authorize);
        const retained = yield* verification.value
          .readPrepared(jobId)
          .pipe(Effect.mapError(denied));
        if (
          retained === undefined ||
          retained.manifest.projectId !== projectId ||
          retained.manifest.taskId !== taskId ||
          retained.sha256 !== before
        )
          return yield* denied();
        const after = yield* sql.withTransaction(authorize);
        if (after !== retained.sha256) return yield* denied();
        return yield* decodeVerificationPreview({ kind: "verification-job", ...retained }).pipe(
          Effect.mapError(denied),
        );
      }).pipe(
        Effect.mapError((error) =>
          isTeamAuthorizationError(error)
            ? error
            : toPersistenceSqlError("ProjectWorkGateway.read")(error),
        ),
      );
    if (input.operation === "issue-comments")
      return Effect.gen(function* () {
        const authorize = sql.withTransaction(
          Effect.gen(function* () {
            if (principal?.managed !== undefined && teamAuthorization._tag === "None")
              return yield* new ProjectTeamAuthorization.ProjectTeamAuthorizationError({
                reason: "Managed authority unavailable",
              });
            if (principal !== undefined && teamAuthorization._tag === "Some")
              yield* teamAuthorization.value.read(principal, input);
          }),
        );
        yield* authorize;
        if (issueComments._tag === "None")
          return yield* new IssueComments.IssueCommentsError({ reason: "unavailable" });
        if (input.issueRecordId === undefined || input.expectedIssueRevision === undefined)
          return yield* new IssueComments.IssueCommentsError({ reason: "invalid-input" });
        const page = yield* issueComments.value.read({
          projectId: String(input.projectId),
          issueRecordId: input.issueRecordId,
          expectedRevision: input.expectedIssueRevision,
          ...(input.issueCommentPage === undefined ? {} : { page: input.issueCommentPage }),
        });
        yield* authorize;
        const publicPage =
          contentGuard._tag === "Some"
            ? (yield* contentGuard.value.redact(page)).value
            : redactProjectWorkContent(page).value;
        return sanitizePublicValue(publicPage);
      }).pipe(
        Effect.mapError((cause) =>
          isTeamAuthorizationError(cause) || isIssueCommentsError(cause)
            ? cause
            : toPersistenceSqlError("ProjectWorkGateway.read")(cause),
        ),
      );
    return sql
      .withTransaction(
        Effect.gen(function* () {
          if (principal?.managed !== undefined && teamAuthorization._tag === "None")
            return yield* new ProjectTeamAuthorization.ProjectTeamAuthorizationError({
              reason: "Managed authority unavailable",
            });
          if (principal !== undefined && teamAuthorization._tag === "Some")
            yield* teamAuthorization.value.read(principal, input);
          return yield* readRaw(input);
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isTeamAuthorizationError(cause)
            ? cause
            : toPersistenceSqlError("ProjectWorkGateway.read")(cause),
        ),
      );
  };
  const writeMemoryMutation = Effect.fn("ProjectWorkGateway.writeMemoryMutation")(function* (
    input: ProjectTeamMemoryRetractIntent | ProjectTeamMemorySharesReplaceIntent,
    actor: ProjectWorkActor,
    source: ProjectWorkAttribution["source"],
    principal?: ProjectTeamAuthorization.ProjectTeamPrincipal,
  ) {
    const caller = principal ?? { actor };
    const denied = (reason: string) =>
      new ProjectTeamAuthorization.ProjectTeamAuthorizationError({ reason });
    if (caller.actor.kind !== actor.kind || caller.actor.id !== actor.id)
      return yield* denied("Memory mutation actor does not match the authenticated request");
    if (Option.isNone(teamAuthorization) || Option.isNone(contentGuard))
      return yield* denied("Memory mutation safety and authorization services are unavailable");
    const authorization = teamAuthorization.value;
    const guard = contentGuard.value;
    const at = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const attribution = attributionFor(actor, source, at);
    const fingerprint =
      "project-team-intent:" +
      NodeCrypto.createHash("sha256")
        .update(
          canonicalProjectWorkPayload({
            intent: input,
            actor: { kind: actor.kind, id: actor.id },
            source: { kind: source.kind, id: source.id },
            managed: caller.managed ?? null,
          }),
        )
        .digest("hex");
    const authorize = Effect.gen(function* () {
      yield* ProjectTeamAuthorization.assertHumanMemoryMutationInTransaction(
        sql,
        caller,
        input.projectId,
      );
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(() => denied("Project Work settings are unavailable")),
      );
      if (!settings.projectWorkEnabled) return yield* denied("Project Work is disabled");
      yield* assertProjectAcceptsMutations(sql, input.projectId).pipe(
        Effect.mapError(() => denied("Memory project cannot accept mutations")),
      );
    });
    const envelope: ProjectWorkCommand = {
      type: "project-work.foundation.commit",
      commandId: input.commandId,
      projectId: input.projectId,
      expectedRevision: input.expectedRevision,
      attribution,
      records: [],
      committedAt: at,
    };
    const result = yield* executeAuthorized(
      envelope,
      () =>
        Effect.gen(function* () {
          yield* authorize;
          const environmentId = Option.isSome(environmentIdentity)
            ? yield* environmentIdentity.value.getEnvironmentId
            : Option.isSome(serverEnvironment)
              ? yield* serverEnvironment.value.getEnvironmentId
              : undefined;
          if (environmentId === undefined)
            return yield* denied("Memory environment identity is unavailable");
          const service = makeProjectMemoryService({
            sql,
            repository,
            contentGuard: guard,
            authorization,
            environmentId,
          });
          const records = yield* (
            input.type === "project-team.memory.shares.replace"
              ? service.prepareSharesInTransaction(input, at)
              : service.prepareRetractionInTransaction(input, at)
          ).pipe(
            Effect.mapError((error) =>
              denied(
                isMemoryServiceError(error)
                  ? error.reason
                  : "Selected memory source is unavailable",
              ),
            ),
          );
          yield* authorize;
          for (const record of records) {
            if (record.kind !== "memory-source") continue;
            // Permission checks can discover credentials after tombstone preparation.
            // Recheck decoded content so JSON escaping cannot hide a newly known secret.
            const content = Option.getOrElse(
              decodeMemorySourceContent(record.content),
              () => record.content,
            );
            yield* guard
              .assertSafe(content)
              .pipe(
                Effect.mapError(() => denied("Selected memory source is no longer safe to retain")),
              );
          }
          return { ...envelope, records };
        }),
      () => authorize,
      fingerprint,
    );
    return result.writeResult;
  });
  const write: ProjectWorkGatewayShape["write"] = (input, actor, source, principal) => {
    if (
      input.type === "project-team.memory.retract" ||
      input.type === "project-team.memory.shares.replace"
    )
      return writeMemoryMutation(input, actor, source, principal);
    if (!isTeamIntent(input) && !isGuidedIntent(input))
      return writeCommand(input, actor, source, principal);
    return Effect.gen(function* () {
      if (teamAuthorization._tag === "None")
        return yield* new ProjectTeamAuthorization.ProjectTeamAuthorizationError({
          reason: "Team authorization unavailable",
        });
      const authorization = teamAuthorization.value;
      const caller = principal ?? { actor };
      if (caller.actor.kind !== actor.kind || caller.actor.id !== actor.id)
        return yield* new ProjectWorkAuthorizationError({ reason: "spoofed-attribution" });
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          () => new ProjectWorkAuthorizationError({ reason: "project-work-disabled" }),
        ),
      );
      if (!settings.projectWorkEnabled)
        return yield* new ProjectWorkAuthorizationError({ reason: "project-work-disabled" });
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const attribution = attributionFor(actor, source, now);
      const queryQualification =
        input.type === "project-team.memory.query"
          ? yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const query = yield* makeProjectMemoryQuery();
                  return yield* query.qualify(input, caller, attribution, authorization.resolve);
                }).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                  Effect.provideService(ProjectWorkRepository.ProjectWorkRepository, repository),
                  Effect.mapError(
                    (error) =>
                      new ProjectTeamAuthorization.ProjectTeamAuthorizationError({
                        reason: error.reason,
                      }),
                  ),
                ),
              )
              .pipe(
                Effect.mapError((cause) =>
                  isTeamAuthorizationError(cause)
                    ? cause
                    : toPersistenceSqlError("ProjectWorkGateway.queryQualification")(cause),
                ),
              )
          : undefined;
      const fingerprint =
        queryQualification?.intentFingerprint ??
        "project-team-intent:" +
          NodeCrypto.createHash("sha256")
            .update(
              canonicalProjectWorkPayload({
                intent: input,
                actor: { kind: actor.kind, id: actor.id },
                source: { kind: source.kind, id: source.id },
                managed: caller.managed ?? null,
              }),
            )
            .digest("hex");
      const approval = yield* Effect.gen(function* () {
        // Agent decisions are denied by authorization inside the command transaction.
        // Do not acquire an unrelated read connection before that boundary.
        if (caller.actor.kind !== "human" || caller.managed !== undefined) return Option.none();
        if (
          input.type !== "project-team.verification.propose" &&
          (input.type !== "project-team.gate.respond" || input.response !== "approved")
        )
          return Option.none();
        const current = yield* ProjectWorkRepository.readCurrentState(sql, input.projectId).pipe(
          Effect.mapError(toPersistenceSqlError("ProjectWorkGateway.write")),
        );
        const gate =
          input.type === "project-team.gate.respond"
            ? (current.foundationRecords ?? []).find(
                (row) => row.kind === "gate" && row.recordId === input.gateId,
              )
            : undefined;
        if (
          input.type === "project-team.gate.respond" &&
          (gate?.kind !== "gate" || gate.gate !== "verification")
        )
          return Option.none();
        const denied = () =>
          new ProjectTeamAuthorization.ProjectTeamAuthorizationError({
            reason: "Private human verification preparation unavailable",
          });
        const request = yield* Effect.serviceOption(ProjectWorkVerificationRequest);
        if (Option.isNone(request) || Option.isNone(verification)) return yield* denied();
        const assertHuman = Effect.gen(function* () {
          yield* request.value
            .assertCurrent(caller, input.projectId, "write")
            .pipe(Effect.mapError(denied));
          const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(denied));
          if (!settings.projectWorkEnabled) return yield* denied();
          yield* assertProjectAcceptsMutations(sql, input.projectId).pipe(Effect.mapError(denied));
        });
        yield* assertHuman;
        const prior = yield* sql<{
          fingerprint: string;
        }>`SELECT payload_fingerprint AS fingerprint FROM project_work_command_receipts WHERE project_id=${input.projectId} AND command_id=${input.commandId} LIMIT 2`.pipe(
          Effect.mapError(denied),
        );
        if (prior.length > 1 || (prior.length === 1 && prior[0]?.fingerprint !== fingerprint))
          return yield* denied();
        if (input.type === "project-team.verification.propose") {
          const { type: _type, commandId: _commandId, ...selected } = input;
          const selection = yield* decodeVerificationSelection(selected).pipe(
            Effect.mapError(denied),
          );
          const receipt = yield* Effect.gen(function* () {
            return yield* prior.length === 1
              ? verification.value.readPrepared(input.jobId)
              : verification.value.prepare(selection, caller);
          }).pipe(Effect.mapError(denied));
          if (receipt === undefined) return yield* denied();
          const guard = yield* verificationGate(verification.value.environmentId).pipe(
            Effect.mapError(denied),
          );
          return Option.some(
            ProjectWorkVerificationApproval.of({
              receipt,
              selection,
              assertCurrent: (state, duplicate) =>
                assertHuman.pipe(
                  Effect.andThen(guard.assertCurrent(state, receipt, selection, duplicate)),
                  Effect.mapError(
                    () =>
                      new ProjectWorkVerificationGateError({
                        reason: "Verification preparation changed",
                      }),
                  ),
                ),
            }),
          );
        }
        if (gate?.kind !== "gate" || gate.verificationJobId === undefined) return yield* denied();
        const receipt = yield* verification.value
          .readPrepared(gate.verificationJobId)
          .pipe(Effect.mapError(denied));
        if (
          receipt === undefined ||
          receipt.sha256 !== gate.contentHash ||
          receipt.manifest.projectId !== input.projectId ||
          receipt.manifest.taskId !== input.taskId
        )
          return yield* denied();
        const binding = (current.foundationRecords ?? []).find(
          (row) => row.kind === "run-binding" && row.recordId === receipt.manifest.bindingId,
        );
        if (binding?.kind !== "run-binding") return yield* denied();
        const selection = yield* decodeVerificationSelection({
          projectId: input.projectId,
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
          expectedTaskRevision: input.expectedTaskRevision,
          specRevision: input.specRevision,
          planRevision: input.planRevision,
          jobId: receipt.manifest.jobId,
          bindingId: receipt.manifest.bindingId,
          expectedBindingRevision: binding.revision,
          generation: receipt.manifest.generation,
          criterionIds: receipt.manifest.criteria.map((row) => row.criterionId),
          command: receipt.manifest.command,
        }).pipe(Effect.mapError(denied));
        const guard = yield* verificationGate(verification.value.environmentId).pipe(
          Effect.mapError(denied),
        );
        return Option.some(
          ProjectWorkVerificationApproval.of({
            receipt,
            selection,
            assertCurrent: (state, duplicate) =>
              assertHuman.pipe(
                Effect.andThen(guard.assertCurrent(state, receipt, selection, duplicate)),
                Effect.mapError(
                  () =>
                    new ProjectWorkVerificationGateError({
                      reason: "Verification approval changed",
                    }),
                ),
              ),
          }),
        );
      });
      const envelope: ProjectWorkCommand = {
        type: "project-work.foundation.commit",
        commandId: input.commandId,
        projectId: input.projectId,
        expectedRevision: input.expectedRevision,
        attribution,
        records: [],
        committedAt: now,
      };
      const withReportTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        input.type === "project-team.assignment.report" && caller.managed !== undefined
          ? ProjectTeamAuthorization.withProjectTeamReportTransaction(sql, repository, effect)
          : effect;
      let retainedMemorySelection = false;
      const result = yield* executeAuthorized(
        envelope,
        () =>
          Effect.gen(function* () {
            yield* assertProjectAcceptsMutations(sql, input.projectId).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectWorkAuthorizationError({
                    reason: cause.reason === "storage" ? "unknown-project" : cause.reason,
                  }),
              ),
            );
            return yield* isGuidedIntent(input)
              ? withReportTransaction(
                  teamAuthorization.value.guided(caller, input, attribution, false),
                )
              : teamAuthorization.value.intent(caller, input, attribution, false);
          }),
        ({ duplicate }) => {
          retainedMemorySelection = duplicate;
          return (
            isGuidedIntent(input)
              ? withReportTransaction(
                  teamAuthorization.value.guided(caller, input, attribution, duplicate, "validate"),
                )
              : teamAuthorization.value.intent(caller, input, attribution, duplicate)
          ).pipe(Effect.asVoid);
        },
        fingerprint,
      ).pipe(
        (effect) =>
          Option.isSome(approval)
            ? Effect.provideService(effect, ProjectWorkVerificationApproval, approval.value)
            : effect,
        (effect) =>
          queryQualification === undefined
            ? effect
            : Effect.provideService(effect, ProjectMemoryQueryQualification, queryQualification),
      );
      if (input.type === "project-team.memory.process" && !retainedMemorySelection) {
        const ports = yield* Effect.serviceOption(ProjectMemoryPorts);
        if (Option.isSome(ports) && ports.value.consume !== undefined) {
          // The accepted selection survives a failed or uncertain forward stage.
          // Exact retries return that receipt without resending model work.
          yield* ports.value
            .consume(caller, input.selection.effectId)
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Selected memory work remains retained for reconciliation."),
              ),
            );
        }
      }
      if (input.type === "project-team.memory.query" && !retainedMemorySelection) {
        const ports = yield* Effect.serviceOption(ProjectMemoryPorts);
        if (
          Option.isSome(ports) &&
          ports.value.consumeQuery !== undefined &&
          queryQualification !== undefined
        ) {
          const queryId =
            "memory-query-" +
            NodeCrypto.createHash("sha256")
              .update(
                canonicalProjectWorkPayload({
                  projectId: input.projectId,
                  commandId: input.commandId,
                }),
              )
              .digest("hex");
          // Admission is already committed. A failed forward stage is retained;
          // the receipt remains authoritative and its retry cannot forward again.
          yield* ports.value
            .consumeQuery(caller, queryId)
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Semantic query remains retained for reconciliation."),
              ),
            );
        }
      }
      return sanitizePublicValue(result.writeResult) as ProjectWorkWriteReceipt;
    });
  };
  return { read, write } satisfies ProjectWorkGatewayShape;
});

// Supplying the shared stateful guard/export service here keeps direct gateway
// tests and narrow adapters safe without requiring every caller to assemble
// the complete project-work service graph.
export const ProjectWorkGatewayLive = Layer.effect(ProjectWorkGateway, makeProjectWorkGateway);
