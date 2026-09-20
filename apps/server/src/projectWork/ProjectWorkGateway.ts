import {
  type ProjectWorkActor,
  type ProjectWorkAttribution,
  type ProjectWorkCommand,
  type ProjectWorkCriterion,
  type ProjectWorkReadIntent,
  type ProjectWorkWriteResult,
  projectWorkPayloadFingerprint,
  projectWorkProtectedRevisionIntentFingerprintPayload,
  projectWorkProtectedRevisionFingerprintPayload,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ProjectWorkBriefing from "./ProjectWorkBriefing.ts";
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
import * as ProjectWorkRepository from "./ProjectWorkRepository.ts";
import * as ProjectWorkSearch from "./ProjectWorkSearch.ts";
import * as ProjectLifecycle from "../project/ProjectLifecycle.ts";
import { assertProjectAcceptsMutations } from "../project/ProjectMutationFence.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  isPersistenceError,
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
  ) => Effect.Effect<unknown, ProjectionRepositoryError>;
  readonly write: (
    command: ProjectWorkCommand,
    actor: ProjectWorkActor,
    source: ProjectWorkAttribution["source"],
  ) => Effect.Effect<
    ProjectWorkWriteReceipt,
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
const sanitizePublicValue = (value: unknown, depth = 0): unknown => {
  if (depth > PUBLIC_MAX_DEPTH) return "[omitted: maximum output depth]";
  if (typeof value === "string") {
    return value.length > PUBLIC_MAX_STRING_LENGTH
      ? `${value.slice(0, PUBLIC_MAX_STRING_LENGTH)}…[truncated]`
      : value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, PUBLIC_MAX_ARRAY_ITEMS)
      .map((entry) => sanitizePublicValue(entry, depth + 1));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, PUBLIC_MAX_OBJECT_KEYS)
      .filter(([key]) => !PUBLIC_SENSITIVE_KEY.test(key))
      .map(([key, entry]) => [key, sanitizePublicValue(entry, depth + 1)]),
  );
};

const makeProjectWorkGateway = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
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

  const read: ProjectWorkGatewayShape["read"] = (input) => {
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
                ...(exported.history === undefined ? {} : { history: exported.history }),
              });
            return ProjectWorkExport.buildProjectWorkJsonExport(exported.snapshot, {
              environmentId,
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
        contentGuard._tag === "Some"
          ? contentGuard.value
              .redact(value)
              .pipe(Effect.map(({ value: redacted }) => sanitizePublicValue(redacted)))
          : Effect.succeed(sanitizePublicValue(redactProjectWorkContent(value).value)),
      ),
    );
  };

  const write: ProjectWorkGatewayShape["write"] = (command, actor, source) =>
    Effect.gen(function* () {
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
        const approval = yield* repository
          .executeAuthorized(authorizedCommand, () =>
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
          )
          .pipe(
            Effect.mapError((cause) => {
              if (
                Schema.is(ProjectWorkAuthorizationError)(cause) ||
                Schema.is(EnvironmentAuth.ServerAuthProjectWorkApprovalError)(cause) ||
                cause instanceof ProjectWorkPolicyError ||
                isPersistenceError(cause)
              ) {
                return cause;
              }
              return toPersistenceSqlError("ProjectWorkGateway.write")(cause);
            }),
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
          ? yield* repository
              .executeAuthorized(authorizedCommand, ({ commandFingerprint }) =>
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
              )
              .pipe(
                Effect.mapError((cause) => {
                  if (
                    Schema.is(ProjectWorkAuthorizationError)(cause) ||
                    Schema.is(EnvironmentAuth.ServerAuthProjectWorkApprovalError)(cause) ||
                    cause instanceof ProjectWorkPolicyError ||
                    isPersistenceError(cause)
                  ) {
                    return cause;
                  }
                  return toPersistenceSqlError("ProjectWorkGateway.write")(cause);
                }),
              )
          : yield* repository.executeAuthorized(authorizedCommand, () =>
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

  return { read, write } satisfies ProjectWorkGatewayShape;
});

// Supplying the shared stateful guard/export service here keeps direct gateway
// tests and narrow adapters safe without requiring every caller to assemble
// the complete project-work service graph.
export const ProjectWorkGatewayLive = Layer.effect(ProjectWorkGateway, makeProjectWorkGateway);
