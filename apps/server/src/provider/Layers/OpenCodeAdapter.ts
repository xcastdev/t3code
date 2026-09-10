import {
  EventId,
  EnvironmentId,
  MessageId,
  type OpenCodeSettings,
  type ProviderSessionRecovery,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimePlanStepStatus,
  type ProviderRuntimeEvent,
  type ServerProviderSlashCommand,
  type ProviderSession,
  type RuntimeTaskUsage,
  type ThreadTokenUsageSnapshot,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { OpencodeClient, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import type { ProviderSessionSettlementInput } from "../Services/ProviderAdapter.ts";
import {
  projectMcpNativeKey,
  type ProviderAdapterSessionStartInput,
} from "../Services/ProviderAdapter.ts";
import * as OpenCodeExternalMcpCoordinator from "../OpenCodeExternalMcpCoordinator.ts";
import {
  OpenCodeExternalMcpUrlError,
  rebaseExternalMcpUrl,
  validateExternalMcpBaseUrl,
  validateExternalOpenCodeUrl,
} from "../OpenCodeExternalMcpUrl.ts";
import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";
import * as Option from "effect/Option";
export { expandOpenCodeCommandTemplate } from "./OpenCodeCommand.ts";

const PROVIDER = ProviderDriverKind.make("opencode");

/**
 * Version tag stamped into the OpenCode resume cursor. Bump if the cursor
 * shape changes so stale-shaped cursors written by older builds are ignored
 * rather than misread (mirrors GROK_RESUME_VERSION / CURSOR_RESUME_VERSION).
 */
const OPENCODE_RESUME_VERSION = 1 as const;

/**
 * Decode a persisted resume cursor into the upstream `ses_…` id. Anything
 * that isn't a current-version cursor with a non-empty id means "no resume"
 * rather than an error. Re-adopting the session id IS the resume mechanism —
 * OpenCode scopes a conversation's history by session id.
 */
function parseOpenCodeResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== OPENCODE_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: record.sessionId.trim() };
}

/**
 * Whether an error definitively reports a missing session. Only a confirmed
 * miss may silently start a fresh session; any other failure (the SDK client
 * is `throwOnError: true`, so `session.get` rejects on every non-2xx) must
 * propagate, or a transient blip resets a live thread to an empty one — the
 * #3604 silent context loss. Decides on structured signals only, never free
 * text: a numeric 404 or the exact `NotFoundError` name, found via a bounded walk
 * over `cause`/`body`/`error`/`data`. An explicit non-404 status seals its
 * subtree so a wrapped "NotFound" name can't reclassify a real failure.
 * Exported for unit testing.
 */
export function isOpenCodeNotFound(cause: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [cause];
  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();
    if (node === null || typeof node !== "object" || seen.has(node)) {
      continue;
    }
    seen.add(node);
    const record = node as Record<string, unknown>;

    const response = record.response;
    const statuses = [
      record.status,
      record.statusCode,
      response !== null && typeof response === "object"
        ? (response as { readonly status?: unknown }).status
        : undefined,
    ].filter((status): status is number => typeof status === "number");
    if (statuses.includes(404)) {
      return true;
    }
    if (statuses.length > 0) {
      continue;
    }

    const name = record.name;
    if (typeof name === "string" && name.toLowerCase() === "notfounderror") {
      return true;
    }

    for (const key of ["cause", "body", "error", "data"] as const) {
      if (record[key] !== undefined) {
        queue.push(record[key]);
      }
    }
  }
  return false;
}

/**
 * Whether two directory spellings name the same location. Raw string
 * equality misreads a trailing slash, `.`/`..` segment, or symlinked cwd
 * (macOS `/tmp` → `/private/tmp`) as a cwd change, needlessly forking the
 * session on every resume. Lexically equal paths short-circuit; otherwise
 * both sides go through `realPath`, each falling back to its lexical form
 * on failure (deleted directory, external-server path) — so the probe can
 * only widen matches, never split them. Takes the services as arguments so
 * adapter methods stay service-free. Exported for unit testing.
 */
export function isSameOpenCodeDirectory(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  left: string,
  right: string,
): Effect.Effect<boolean> {
  const lexicalLeft = path.resolve(left);
  const lexicalRight = path.resolve(right);
  if (lexicalLeft === lexicalRight) {
    return Effect.succeed(true);
  }
  const canonicalize = (lexical: string) =>
    fileSystem.realPath(lexical).pipe(Effect.orElseSucceed(() => lexical));
  return Effect.zipWith(
    canonicalize(lexicalLeft),
    canonicalize(lexicalRight),
    (canonicalLeft, canonicalRight) => canonicalLeft === canonicalRight,
  );
}

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

type OpenCodeToolStatus = Extract<Part, { readonly type: "tool" }>["state"]["status"];
type OpenCodeSubtaskPart = Extract<Part, { readonly type: "subtask" }>;

interface OpenCodeTaskState {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly parentAgentId?: string;
  readonly toolUseId?: string;
  description: string;
  role?: string;
  model?: string;
  terminal: boolean;
}

function normalizeOpenCodeTokenUsage(
  tokens:
    | {
        readonly total?: number;
        readonly input: number;
        readonly output: number;
        readonly reasoning: number;
        readonly cache: { readonly read: number };
      }
    | undefined,
): ThreadTokenUsageSnapshot | undefined {
  if (!tokens) {
    return undefined;
  }
  const inputTokens = Number.isFinite(tokens.input) && tokens.input >= 0 ? tokens.input : 0;
  const outputTokens = Number.isFinite(tokens.output) && tokens.output >= 0 ? tokens.output : 0;
  const reasoningOutputTokens =
    Number.isFinite(tokens.reasoning) && tokens.reasoning >= 0 ? tokens.reasoning : 0;
  const cachedInputTokens =
    Number.isFinite(tokens.cache.read) && tokens.cache.read >= 0 ? tokens.cache.read : 0;
  const total =
    typeof tokens.total === "number" && Number.isFinite(tokens.total) && tokens.total >= 0
      ? tokens.total
      : inputTokens + outputTokens + reasoningOutputTokens;
  if (total <= 0) {
    return undefined;
  }
  return {
    usedTokens: total,
    totalProcessedTokens: total,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    lastUsedTokens: total,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cachedInputTokens,
    lastOutputTokens: outputTokens,
    lastReasoningOutputTokens: reasoningOutputTokens,
  };
}

function normalizeOpenCodeTaskUsage(
  tokens:
    | {
        readonly total?: number;
        readonly input: number;
        readonly output: number;
        readonly reasoning: number;
        readonly cache: { readonly read: number };
      }
    | undefined,
): RuntimeTaskUsage | undefined {
  const usage = normalizeOpenCodeTokenUsage(tokens);
  if (!usage) {
    return undefined;
  }
  return {
    totalTokens: usage.usedTokens,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
  };
}

function openCodeTokenUsageSignature(usage: ThreadTokenUsageSnapshot): string {
  return [
    usage.usedTokens,
    usage.totalProcessedTokens,
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
  ].join(":");
}

const OpenCodeSessionStatusMap = Schema.Record(
  Schema.String,
  Schema.Struct({ type: Schema.String }),
);
const decodeOpenCodeSessionStatusMap = Schema.decodeUnknownOption(OpenCodeSessionStatusMap);

const OPENCODE_ABORT_ATTEMPT_TIMEOUT = "2 seconds";
const OPENCODE_ABORT_CONFIRM_TIMEOUT = "10 seconds";
const OPENCODE_ABORT_RETRY_DELAYS = [0, 250, 1_000] as const;

type OpenCodeContextCloseIntent = "detach" | "terminate";

interface OpenCodeCancellation {
  readonly turnId: TurnId | undefined;
  readonly completion: Deferred.Deferred<void, ProviderAdapterRequestError>;
}

interface OpenCodeIdleReconciliation {
  readonly turnId: TurnId;
  readonly promptGeneration: number;
  raw: unknown;
  warned: boolean;
  dirty: boolean;
  idleStatusConfirmations: number;
  fiber?: Fiber.Fiber<void, never>;
}

interface OpenCodePromptAdmission {
  readonly generation: number;
  readonly turnId: TurnId;
  readonly messageId: string;
  readonly nativeCommand: boolean;
  readonly priorAwaitingBusy: boolean;
  readonly priorIdle: { readonly turnId: TurnId; readonly raw: unknown } | undefined;
  idleDuringAdmission: { readonly turnId: TurnId; readonly raw: unknown } | undefined;
  idleObservedAfterMessage: boolean;
  messageObserved: boolean;
  busyObserved: boolean;
  idleStatusConfirmations: number;
  accepted: boolean;
  cancelled: boolean;
  readonly acceptance: Deferred.Deferred<void, ProviderAdapterRequestError>;
  readonly submissionSettled: Deferred.Deferred<void>;
  promptFiber?: Fiber.Fiber<void, ProviderAdapterRequestError>;
  recoveryFiber?: Fiber.Fiber<void, never>;
  recoveryRaw: unknown;
}

type OpenCodeTerminalRequestEvent = Extract<
  OpenCodeSubscribedEvent,
  {
    readonly type: "permission.replied" | "question.replied" | "question.rejected";
  }
>;

type OpenCodeAskedRequestEvent = Extract<
  OpenCodeSubscribedEvent,
  { readonly type: "permission.asked" | "question.asked" }
>;

type OpenCodeRoutedRequestEvent = OpenCodeAskedRequestEvent | OpenCodeTerminalRequestEvent;

interface OpenCodeRequestRelationRetry {
  warned: boolean;
  fiber?: Fiber.Fiber<void, never>;
}

interface OpenCodePendingRequestRecovery {
  warned: boolean;
  rerun: boolean;
}

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function formatOpenCodeDiff(
  diff: ReadonlyArray<{
    readonly file?: string;
    readonly patch?: string;
    readonly additions: number;
    readonly deletions: number;
    readonly status?: string;
  }>,
): string {
  return diff
    .map((entry) => {
      if (entry.patch?.trim()) {
        return entry.patch;
      }
      const file = entry.file ?? "unknown file";
      const status = entry.status ?? "modified";
      return `${status}: ${file} (+${entry.additions}/-${entry.deletions})`;
    })
    .join("\n\n");
}

function openCodeEventSessionId(event: OpenCodeSubscribedEvent): string | undefined {
  const properties = "properties" in event ? event.properties : undefined;
  if (!properties || typeof properties !== "object") {
    return undefined;
  }

  const sessionID = (properties as { readonly sessionID?: unknown }).sessionID;
  const sessionIDFromProperties = typeof sessionID === "string" ? sessionID : undefined;
  if (sessionIDFromProperties) {
    return sessionIDFromProperties;
  }

  const part = (properties as { readonly part?: { readonly sessionID?: unknown } }).part;
  if (part && typeof part.sessionID === "string") {
    return part.sessionID;
  }

  const info = (properties as { readonly info?: { readonly id?: unknown } }).info;
  return info && typeof info.id === "string" ? info.id : undefined;
}

function openCodeEventSessionTitle(event: OpenCodeSubscribedEvent): string | undefined {
  if (event.type !== "session.updated") {
    return undefined;
  }

  const title = trimText(event.properties.info.title);
  // OpenCode mints a placeholder title at session.create when no title was
  // provided, and re-emits it on every `session.updated`. Mirroring it would
  // overwrite the thread's real title (openCodeEventSessionTitle feeds the
  // `thread.metadata.updated` mirror). Ignore OpenCode's auto-generated
  // placeholders so the thread isn't locked onto them.
  if (!title || isOpenCodeDefaultTitle(title)) {
    return undefined;
  }

  return title;
}

function isOpenCodeAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "MessageAbortedError"
  );
}

function isOpenCodeChildRequestEvent(event: OpenCodeSubscribedEvent): boolean {
  switch (event.type) {
    case "permission.asked":
    case "permission.replied":
    case "question.asked":
    case "question.replied":
    case "question.rejected":
      return true;
    default:
      return false;
  }
}

const OPENCODE_DEFAULT_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isOpenCodeDefaultTitle(title: string): boolean {
  return OPENCODE_DEFAULT_TITLE_PATTERN.test(title);
}

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly relatedSessionIds: Set<string>;
  readonly resolvedRequestIds: Set<string>;
  readonly emittedTerminalRequestIds: Set<string>;
  readonly requestRelationRetries: Map<string, OpenCodeRequestRelationRetry>;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly partById: Map<string, Part>;
  readonly subtaskPartById: Map<string, OpenCodeSubtaskPart>;
  readonly tasksBySessionId: Map<string, OpenCodeTaskState>;
  readonly taskSessionByToolCallId: Map<string, string>;
  readonly pendingTextDeltasByPartId: Map<string, string>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly toolStatusByCallId: Map<string, OpenCodeToolStatus>;
  readonly completedAssistantPartIds: Set<string>;
  readonly turns: Array<OpenCodeTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  recovery: ProviderSessionRecovery | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  lastTokenUsageSignature: string | undefined;
  cancellation: OpenCodeCancellation | undefined;
  interruptedTurnId: TurnId | undefined;
  reconcileIdleStatus: boolean;
  reconcileRecoveredHistory: boolean;
  awaitingBusyAfterInterruption: boolean;
  pendingIdleReconciliation: OpenCodeIdleReconciliation | undefined;
  pendingRequestRecovery: OpenCodePendingRequestRecovery | undefined;
  recoveryReconciliationDeferred: boolean;
  promptGeneration: number;
  promptAdmission: OpenCodePromptAdmission | undefined;
  unpublished: boolean;
  closingIntent: OpenCodeContextCloseIntent | undefined;
  quarantined: boolean;
  readonly promptSemaphore: Semaphore.Semaphore;
  readonly firstConnection: Deferred.Deferred<void, ProviderAdapterRequestError>;
  /**
   * One-shot guard flipped by `closeOpenCodeContext` / `emitUnexpectedExit`.
   * The session lifecycle is owned by `sessionScope`; this Ref exists only
   * so concurrent callers can race the transition safely via `getAndSet`.
   */
  readonly stopped: Ref.Ref<boolean>;
  /**
   * Sole lifecycle handle for the session. Closing this scope:
   *   - aborts the `AbortController` registered as a finalizer
   *     (cancels the in-flight `event.subscribe` fetch),
   *   - interrupts the event-pump and server-exit fibers forked
   *     via `Effect.forkIn(sessionScope)`,
   *   - tears down the OpenCode server process for scope-owned servers.
   */
  readonly sessionScope: Scope.Closeable;
}

const isSameOpenCodeUpstreamSession = (
  existing: OpenCodeSessionContext,
  candidate: OpenCodeSessionContext,
): boolean => existing.openCodeSessionId === candidate.openCodeSessionId;

interface OpenCodeExternalMcpState {
  readonly lease: OpenCodeExternalMcpCoordinator.OpenCodeExternalMcpLease;
  readonly client: OpencodeClient;
  readonly directory: string;
  readonly attemptedNames: Set<string>;
  readonly cleanupDone: Deferred.Deferred<void, never>;
  cleanupStarted: boolean;
}

interface OpenCodeExternalMcpReadState {
  readonly config: Readonly<Record<string, unknown>>;
  readonly status: Readonly<Record<string, unknown>>;
}

export interface OpenCodeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environmentId?: EnvironmentId;
  readonly externalMcpCoordinator?: OpenCodeExternalMcpCoordinator.OpenCodeExternalMcpCoordinatorShape;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly commandCatalog?:
    | ReadonlyArray<ServerProviderSlashCommand>
    | ((directory: string) => ReadonlyArray<ServerProviderSlashCommand>);
  /** @deprecated Use commandCatalog. Kept for small adapter fixtures. */
  readonly commands?: ReadonlyArray<ServerProviderSlashCommand>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Map a tagged OpenCodeRuntimeError produced by {@link runOpenCodeSdk} into
 * the adapter-boundary `ProviderAdapterRequestError`. SDK-method-level call
 * sites pipe through this in `Effect.mapError` so they never build the error
 * shape by hand.
 */
const toRequestError = (cause: OpenCodeRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

const toExternalMcpRequestError = (method: string, cause: unknown): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail:
      cause instanceof OpenCodeExternalMcpUrlError
        ? cause.reason
        : cause instanceof OpenCodeExternalMcpCoordinator.OpenCodeExternalMcpCoordinatorError
          ? cause.detail
          : cause instanceof Error
            ? cause.message
            : String(cause),
    ...(cause === undefined ? {} : { cause }),
  });

type OpenCodeProjectMcpServer = NonNullable<
  ProviderAdapterSessionStartInput["projectMcpServers"]
>[number];

/**
 * Map a `Cause.squash`-ed failure into a `ProviderAdapterProcessError`. The
 * typed cause is usually an `OpenCodeRuntimeError` (from {@link runOpenCodeSdk}),
 * in which case we preserve its `detail`; otherwise we fall back to
 * {@link openCodeRuntimeErrorDetail} for unknown causes (defects, etc.).
 */
const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });

type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
};

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function normalizeOpenCodeTodoStatus(status: string): RuntimePlanStepStatus {
  switch (status) {
    case "in_progress":
    case "in-progress":
    case "inProgress":
      return "inProgress";
    case "completed":
    case "complete":
    case "done":
      return "completed";
    default:
      return "pending";
  }
}

function shouldEmitOpenCodeToolStatus(
  statuses: Map<string, OpenCodeToolStatus>,
  callId: string,
  status: OpenCodeToolStatus,
): boolean {
  const previous = statuses.get(callId);
  if (previous === "completed" || previous === "error") {
    return false;
  }
  if (previous === status) {
    return false;
  }
  // OpenCode can replay a pending snapshot after a live running update while
  // the session history catches up. Never regress a tool's lifecycle.
  if (previous === "running" && status === "pending") {
    return false;
  }
  statuses.set(callId, status);
  return true;
}

function openCodeToolCallKey(sessionId: string, callId: string): string {
  return `${sessionId}:${callId}`;
}

function openCodeRecordValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function openCodeStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function openCodeModelValue(value: unknown): string | undefined {
  const direct = openCodeStringValue(value);
  if (direct) {
    return direct;
  }
  const provider = openCodeStringValue(openCodeRecordValue(value, "providerID"));
  const model = openCodeStringValue(openCodeRecordValue(value, "modelID"));
  return provider && model ? `${provider}/${model}` : undefined;
}

function openCodeTaskStateFromToolPart(
  part: Extract<Part, { readonly type: "tool" }>,
  parentSessionId: string,
  subtask: OpenCodeSubtaskPart | undefined,
  existing: OpenCodeTaskState | undefined,
): OpenCodeTaskState | undefined {
  const metadata = part.state.status === "pending" ? undefined : part.state.metadata;
  const input = part.state.input;
  const childSessionId =
    openCodeStringValue(openCodeRecordValue(metadata, "sessionId")) ??
    openCodeStringValue(openCodeRecordValue(metadata, "sessionID")) ??
    openCodeStringValue(openCodeRecordValue(metadata, "childSessionId"));
  if (!childSessionId) {
    return existing;
  }
  const description =
    openCodeStringValue(openCodeRecordValue(metadata, "description")) ??
    openCodeStringValue(openCodeRecordValue(input, "description")) ??
    openCodeStringValue(openCodeRecordValue(input, "prompt")) ??
    subtask?.description ??
    existing?.description ??
    "OpenCode subtask";
  const role =
    openCodeStringValue(openCodeRecordValue(metadata, "agent")) ??
    openCodeStringValue(openCodeRecordValue(input, "agent")) ??
    subtask?.agent ??
    existing?.role;
  const model =
    openCodeModelValue(openCodeRecordValue(metadata, "model")) ??
    openCodeModelValue(openCodeRecordValue(input, "model")) ??
    (subtask?.model ? `${subtask.model.providerID}/${subtask.model.modelID}` : undefined) ??
    existing?.model;
  const metadataParentSessionId =
    openCodeStringValue(openCodeRecordValue(metadata, "parentSessionId")) ??
    openCodeStringValue(openCodeRecordValue(metadata, "parentSessionID"));
  return {
    sessionId: childSessionId,
    parentSessionId: metadataParentSessionId ?? existing?.parentSessionId ?? parentSessionId,
    ...(metadataParentSessionId && metadataParentSessionId !== parentSessionId
      ? { parentAgentId: metadataParentSessionId }
      : existing?.parentAgentId
        ? { parentAgentId: existing.parentAgentId }
        : {}),
    toolUseId: existing?.toolUseId ?? part.callID,
    description,
    ...(role ? { role } : {}),
    ...(model ? { model } : {}),
    terminal: existing?.terminal ?? false,
  };
}

function openCodeTaskLinkage(state: OpenCodeTaskState) {
  return {
    taskId: RuntimeTaskId.make(state.sessionId),
    taskType: "subagent" as const,
    agentKind: "agent" as const,
    title: state.description,
    ...(state.role ? { role: state.role } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.toolUseId ? { toolUseId: state.toolUseId } : {}),
    ...(state.parentAgentId ? { parentAgentId: state.parentAgentId } : {}),
    timelineBypass: true as const,
  };
}

function parseOpenCodeCommandInput(
  text: string,
): { readonly command: string; readonly arguments?: string } | undefined {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const command = match[1];
  if (!command) {
    return undefined;
  }
  const argumentsText = match[2]?.trim();
  return {
    command,
    ...(argumentsText ? { arguments: argumentsText } : {}),
  };
}

function mapPermissionToRequestType(
  permission: string,
):
  | "command_execution_approval"
  | "file_read_approval"
  | "file_change_approval"
  | "dynamic_tool_call"
  | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      // OpenCode has more permission names than the canonical approval
      // vocabulary (for example `task`, `skill`, `grep`, and
      // `external_directory`). Keep those requests actionable. The client
      // renders `dynamic_tool_call` as a command-style approval, while the
      // native permission name and patterns remain in the request detail.
      return "dynamic_tool_call";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): OpenCodeTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: OpenCodeTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

const ensureSessionContext = Effect.fn("ensureSessionContext")(function* (
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
) {
  const session = sessions.get(threadId);
  if (!session) {
    return yield* new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  if (yield* Ref.get(session.stopped)) {
    return yield* new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  if (session.quarantined) {
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "session.settlement",
      detail:
        "OpenCode session is quarantined because native replacement state could not be restored.",
    });
  }
  return session;
});

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
} {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): {
  readonly nextText: string;
  readonly deltaToEmit: string;
} {
  return {
    nextText: previousText + delta,
    deltaToEmit: delta,
  };
}

const isoFromEpochMs = (value: number) =>
  DateTime.make(value).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data ? data.message : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): Effect.Effect<ProviderSession> {
  return Effect.gen(function* () {
    return applyProviderSessionUpdate(context, patch, options, yield* nowIso);
  });
}

function applyProviderSessionUpdate(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options:
    | {
        readonly clearActiveTurnId?: boolean;
        readonly clearLastError?: boolean;
      }
    | undefined,
  updatedAt: string,
): ProviderSession {
  const nextSession = {
    ...context.session,
    ...patch,
    updatedAt,
  } as ProviderSession & Record<string, unknown>;
  const mutableSession = nextSession as Record<string, unknown>;
  if (options?.clearActiveTurnId) {
    delete mutableSession.activeTurnId;
  }
  if (options?.clearLastError) {
    delete mutableSession.lastError;
  }
  context.session = nextSession;
  return nextSession;
}

const failPendingOpenCodeCancellation = Effect.fn("failPendingOpenCodeCancellation")(function* (
  context: OpenCodeSessionContext,
  detail: string,
) {
  const cancellation = context.cancellation;
  if (!cancellation) {
    return;
  }
  context.cancellation = undefined;
  yield* Deferred.fail(
    cancellation.completion,
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "session.abort",
      detail,
    }),
  ).pipe(Effect.ignore);
});

const abortOpenCodeSessionForTeardown = (context: OpenCodeSessionContext) =>
  runOpenCodeSdk("session.abort", (signal) =>
    context.client.session.abort({ sessionID: context.openCodeSessionId }, { signal }),
  ).pipe(Effect.timeout("1 second"), Effect.ignore({ log: true }));

const openCodeMcpConfig = (config: McpProviderSession.McpProviderSessionConfig) => ({
  type: "remote" as const,
  url: config.endpoint,
  headers: { Authorization: config.authorizationHeader },
  oauth: false as const,
});

type OpenCodeMcpConfig = NonNullable<
  NonNullable<Parameters<OpencodeClient["mcp"]["add"]>[0]>["config"]
>;
type OpenCodeMcpEntry = OpenCodeMcpConfig | { readonly enabled: boolean };

interface OpenCodeManagedReplacementSnapshot {
  readonly token: number;
  readonly context: OpenCodeSessionContext;
  readonly previousRuntimeMode: ProviderSession["runtimeMode"];
  readonly previousModel: ProviderSession["model"];
  previousManagedMcpConfig: OpenCodeMcpEntry | undefined;
  managedMcpConfigWasRead: boolean;
  permissionsUpdated: boolean;
  mcpConfigurationChanged: boolean;
  provisionalSession: ProviderSession | undefined;
}

const restoreManagedOpenCodeMcpConfigurationStrict = (
  client: OpencodeClient,
  server: OpenCodeServerConnection,
  previousConfig: OpenCodeMcpEntry | undefined,
  configWasRead: boolean,
) => {
  if (server.external || !configWasRead) {
    return Effect.void;
  }
  if (previousConfig !== undefined) {
    if ("enabled" in previousConfig) {
      return runOpenCodeSdk("config.update", () =>
        client.config.update({ config: { mcp: { "t3-code": previousConfig } } }),
      ).pipe(Effect.mapError(toRequestError), Effect.asVoid);
    }
    return runOpenCodeSdk("mcp.add", () =>
      client.mcp.add({ name: "t3-code", config: previousConfig }),
    ).pipe(Effect.mapError(toRequestError), Effect.asVoid);
  }
  return runOpenCodeSdk("config.get", () => client.config.get()).pipe(
    Effect.flatMap((response) => {
      const currentConfig = response.data;
      const currentMcp = currentConfig?.mcp;
      if (!currentMcp || !Object.hasOwn(currentMcp, "t3-code")) {
        return Effect.void;
      }
      const { ["t3-code"]: _removed, ...remainingMcp } = currentMcp;
      return runOpenCodeSdk("config.update", () =>
        client.config.update({ config: { ...currentConfig, mcp: remainingMcp } }),
      ).pipe(Effect.mapError(toRequestError), Effect.asVoid);
    }),
  );
};

const restoreManagedOpenCodeMcpConfiguration = (
  client: OpencodeClient,
  server: OpenCodeServerConnection,
  previousConfig: OpenCodeMcpEntry | undefined,
  configWasRead: boolean,
) =>
  restoreManagedOpenCodeMcpConfigurationStrict(client, server, previousConfig, configWasRead).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("OpenCode MCP configuration rollback failed", { cause }),
    ),
    Effect.asVoid,
  );

const cancelPendingOpenCodePrompt = Effect.fn("cancelPendingOpenCodePrompt")(function* (
  context: OpenCodeSessionContext,
) {
  const admission = context.promptAdmission;
  if (!admission) {
    return;
  }
  admission.cancelled = true;
  if (admission.promptFiber) {
    yield* Fiber.interrupt(admission.promptFiber);
  }
  yield* Deferred.await(admission.submissionSettled);
});

const closeStartingOpenCodeContext = Effect.fn("closeStartingOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
  intent: OpenCodeContextCloseIntent,
  settlePendingRequests: (
    context: OpenCodeSessionContext,
  ) => Effect.Effect<void, ProviderAdapterRequestError>,
  restoreMcpConfiguration: Effect.Effect<void> = Effect.void,
) {
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return;
  }
  yield* Deferred.fail(
    context.firstConnection,
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "event.subscribe",
      detail: "OpenCode session startup ended before the event stream connected.",
    }),
  ).pipe(Effect.ignore);
  yield* restoreMcpConfiguration;
  yield* cancelPendingOpenCodePrompt(context);
  yield* failPendingOpenCodeCancellation(context, "OpenCode session startup was cancelled.");
  context.promptAdmission = undefined;
  if (intent === "terminate") {
    yield* abortOpenCodeSessionForTeardown(context);
  }
  yield* settlePendingRequests(context);
  yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
});

const closeOpenCodeContext = Effect.fn("closeOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
  intent: OpenCodeContextCloseIntent,
  settlePendingRequests: (
    context: OpenCodeSessionContext,
  ) => Effect.Effect<void, ProviderAdapterRequestError>,
  options?: { readonly remoteTerminationConfirmed?: boolean },
) {
  // Race-safe one-shot: first caller flips the flag, everyone else no-ops.
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }
  yield* Deferred.fail(
    context.firstConnection,
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "event.subscribe",
      detail: "OpenCode session stopped before the event stream connected.",
    }),
  ).pipe(Effect.ignore);
  yield* cancelPendingOpenCodePrompt(context);
  yield* failPendingOpenCodeCancellation(
    context,
    intent === "detach"
      ? "OpenCode session detached while cancellation awaited remote confirmation."
      : "OpenCode session terminated while cancellation awaited remote confirmation.",
  );
  context.promptAdmission = undefined;

  // Scope close only tears down our local handles (the event pump and event
  // subscription). An externally configured OpenCode server owns its turn,
  // so detaching T3 must not abort that work. Explicit termination runs the
  // shared abort-and-confirm operation before this helper is called.
  const remoteTerminationConfirmed =
    intent === "terminate" && options?.remoteTerminationConfirmed === true;
  if (!context.server.external && !remoteTerminationConfirmed) {
    yield* abortOpenCodeSessionForTeardown(context);
  }
  yield* settlePendingRequests(context);

  // Closing the session scope interrupts every fiber forked into it and
  // runs each finalizer we registered — the `AbortController.abort()` call,
  // the child-process termination, etc.
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});

const detachExternalOpenCodeContext = Effect.fn("detachExternalOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  if (!context.server.external) {
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "session.detach",
      detail: "Managed OpenCode sessions must be reused or terminated, not detached.",
    });
  }
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }
  yield* Deferred.fail(
    context.firstConnection,
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "event.subscribe",
      detail: "OpenCode session detached before the event stream connected.",
    }),
  ).pipe(Effect.ignore);

  // A same-upstream handoff only gives the new local context ownership of the
  // subscription. The remote session remains live, so do not interrupt local
  // prompt/cancellation state or settle requests that the candidate will
  // recover from OpenCode.
  yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignoreCause);
  return true;
});

export function makeOpenCodeAdapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sameDirectory = (left: string, right: string) =>
      isSameOpenCodeDirectory(fileSystem, path, left, right);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    // Only close loggers we created. If the caller passed one in via
    // `options.nativeEventLogger`, they own its lifecycle.
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeSessionContext>();
    const pendingInPlaceReplacementsBySession = new Map<
      ProviderSession,
      OpenCodeManagedReplacementSnapshot
    >();
    const pendingInPlaceReplacementsByContext = new Map<
      OpenCodeSessionContext,
      OpenCodeManagedReplacementSnapshot
    >();
    let nextInPlaceReplacementToken = 0;
    const removePendingInPlaceReplacement = (
      snapshot: OpenCodeManagedReplacementSnapshot,
    ): void => {
      if (
        snapshot.provisionalSession !== undefined &&
        pendingInPlaceReplacementsBySession.get(snapshot.provisionalSession) === snapshot
      ) {
        pendingInPlaceReplacementsBySession.delete(snapshot.provisionalSession);
      }
      if (pendingInPlaceReplacementsByContext.get(snapshot.context) === snapshot) {
        pendingInPlaceReplacementsByContext.delete(snapshot.context);
      }
    };
    const externalMcpStates = new Map<ThreadId, OpenCodeExternalMcpState>();
    const externalMcpCoordinator = options?.externalMcpCoordinator;
    const externalEnvironmentId = options?.environmentId;

    const nameHash = Effect.fn("OpenCodeExternalMcp.nameHash")(function* (value: string) {
      return yield* crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
        Effect.map((bytes) => Buffer.from(bytes).toString("hex").slice(0, 6)),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "crypto.digest",
              detail: "Failed to generate an external OpenCode MCP name.",
              cause,
            }),
        ),
      );
    });

    const readExternalMcpState = Effect.fn("OpenCodeExternalMcp.readState")(function* (
      client: OpencodeClient,
      directory: string,
    ): Effect.fn.Return<OpenCodeExternalMcpReadState, ProviderAdapterRequestError> {
      const configResponse = yield* runOpenCodeSdk("config.get", (signal) =>
        client.config.get({ directory }, { signal }),
      ).pipe(Effect.mapError(toRequestError));
      const statusResponse = yield* runOpenCodeSdk("mcp.status", (signal) =>
        client.mcp.status({ directory }, { signal }),
      ).pipe(Effect.mapError(toRequestError));
      const config =
        configResponse.data &&
        typeof configResponse.data === "object" &&
        !Array.isArray(configResponse.data) &&
        "mcp" in configResponse.data &&
        configResponse.data.mcp &&
        typeof configResponse.data.mcp === "object" &&
        !Array.isArray(configResponse.data.mcp)
          ? (configResponse.data.mcp as Record<string, unknown>)
          : {};
      const status =
        statusResponse.data &&
        typeof statusResponse.data === "object" &&
        !Array.isArray(statusResponse.data)
          ? (statusResponse.data as Record<string, unknown>)
          : {};
      return { config, status };
    });

    const configHeader = (entry: unknown, name: string): string | undefined => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
      const headers = (entry as Record<string, unknown>).headers;
      if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
        return undefined;
      }
      const value = (headers as Record<string, unknown>)[name];
      return typeof value === "string" ? value : undefined;
    };

    const isEnvironmentOwned = (entry: unknown, environmentId: EnvironmentId): boolean =>
      configHeader(entry, "X-T3-MCP-Owner") === String(environmentId);

    const isCurrentGeneration = (
      entry: unknown,
      environmentId: EnvironmentId,
      generation: string,
    ): boolean =>
      isEnvironmentOwned(entry, environmentId) &&
      configHeader(entry, "X-T3-MCP-Generation") === generation;

    const disconnectForRegistration = Effect.fn("OpenCodeExternalMcp.disconnectForRegistration")(
      function* (state: OpenCodeExternalMcpState, name: string) {
        state.attemptedNames.add(name);
        yield* runOpenCodeSdk("mcp.disconnect", (signal) =>
          state.client.mcp.disconnect({ name, directory: state.directory }, { signal }),
        ).pipe(
          Effect.timeout("2 seconds"),
          Effect.mapError((cause) => toExternalMcpRequestError("mcp.disconnect", cause)),
        );
        const after = yield* readExternalMcpState(state.client, state.directory);
        const status = after.status[name];
        if (status !== undefined && typeof status === "object" && status !== null) {
          const statusValue = (status as { readonly status?: unknown }).status;
          if (statusValue === "connected") {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "mcp.disconnect",
              detail: `OpenCode kept MCP server '${name}' connected after disconnect.`,
            });
          }
        }
      },
    );

    const attemptExternalDisconnect = Effect.fn("OpenCodeExternalMcp.attemptDisconnect")(function* (
      state: OpenCodeExternalMcpState,
      name: string,
    ) {
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          if (!(yield* externalMcpCoordinator!.isCurrent(state.lease))) {
            yield* Effect.logWarning(
              "Skipping external OpenCode MCP cleanup for an obsolete lease",
              {
                name,
                directory: state.directory,
                generation: state.lease.generation,
              },
            );
            return;
          }
          const before = yield* readExternalMcpState(state.client, state.directory);
          const entry = before.config[name];
          if (entry === undefined) {
            yield* Effect.logWarning("Skipping missing external OpenCode MCP cleanup entry", {
              name,
              directory: state.directory,
            });
            return;
          }
          if (!isCurrentGeneration(entry, state.lease.environmentId, state.lease.generation)) {
            yield* Effect.logWarning("Skipping foreign external OpenCode MCP cleanup entry", {
              name,
              directory: state.directory,
              generation: state.lease.generation,
            });
            return;
          }
          yield* runOpenCodeSdk("mcp.disconnect", (signal) =>
            state.client.mcp.disconnect({ name, directory: state.directory }, { signal }),
          ).pipe(Effect.catchIf(isOpenCodeNotFound, () => Effect.void));
          const after = yield* readExternalMcpState(state.client, state.directory);
          const status = after.status[name];
          if (
            status !== undefined &&
            typeof status === "object" &&
            status !== null &&
            (status as { readonly status?: unknown }).status === "connected"
          ) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "mcp.disconnect",
              detail: `OpenCode kept MCP server '${name}' connected after cleanup.`,
            });
          }
        }).pipe(Effect.timeout("2 seconds")),
      );
      if (Exit.isFailure(result)) {
        yield* Effect.logWarning("OpenCode external MCP cleanup verification failed", {
          name,
          directory: state.directory,
          cause: Cause.squash(result.cause),
        });
      }
    });

    const cleanupExternalMcpState = Effect.fn("OpenCodeExternalMcp.cleanupState")(function* (
      state: OpenCodeExternalMcpState,
    ) {
      if (externalMcpCoordinator === undefined) return;
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          if (state.cleanupStarted) {
            yield* Deferred.await(state.cleanupDone);
            return;
          }
          state.cleanupStarted = true;
          yield* Effect.ignoreCause(
            Effect.gen(function* () {
              yield* Effect.forEach(
                [...state.attemptedNames],
                (name) => attemptExternalDisconnect(state, name),
                { concurrency: "unbounded", discard: true },
              );
            }).pipe(
              Effect.ensuring(
                externalMcpCoordinator.release(state.lease).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      if (externalMcpStates.get(state.lease.threadId) === state) {
                        externalMcpStates.delete(state.lease.threadId);
                      }
                    }),
                  ),
                ),
              ),
            ),
          );
          yield* Deferred.succeed(state.cleanupDone, undefined);
        }),
      );
    });

    const cleanupExternalMcpForThread = Effect.fn("OpenCodeExternalMcp.cleanupThread")(function* (
      threadId: ThreadId,
    ) {
      const state = externalMcpStates.get(threadId);
      if (state !== undefined) yield* cleanupExternalMcpState(state);
    });

    const registerExternalMcp = Effect.fn("OpenCodeExternalMcp.register")(function* (
      state: OpenCodeExternalMcpState,
      mcpSession: McpProviderSession.McpProviderSessionConfig | undefined,
      projectMcpServers: ReadonlyArray<OpenCodeProjectMcpServer>,
    ) {
      const environmentId = state.lease.environmentId;
      const envHash = yield* nameHash(environmentId);
      const desired: Array<{
        readonly name: string;
        readonly url: string;
        readonly authorizationHeader: string;
      }> = [];
      if (mcpSession !== undefined) {
        const url = yield* Effect.try({
          try: () =>
            rebaseExternalMcpUrl({
              issuedEndpoint: mcpSession.endpoint,
              externalMcpBaseUrl: openCodeSettings.externalMcpBaseUrl,
              serverUrl: state.lease.target.serverUrl,
            }),
          catch: (cause) => toExternalMcpRequestError("startSession", cause),
        });
        desired.push({
          name: `t3-${envHash}-${state.lease.generation}-preview`,
          url,
          authorizationHeader: mcpSession.authorizationHeader,
        });
      }
      for (const projectMcpServer of projectMcpServers) {
        const serverHash = yield* nameHash(String(projectMcpServer.id));
        const url = yield* Effect.try({
          try: () =>
            rebaseExternalMcpUrl({
              issuedEndpoint: projectMcpServer.endpoint,
              externalMcpBaseUrl: openCodeSettings.externalMcpBaseUrl,
              serverUrl: state.lease.target.serverUrl,
            }),
          catch: (cause) => toExternalMcpRequestError("startSession", cause),
        });
        desired.push({
          name: `t3-${envHash}-${state.lease.generation}-project-${serverHash}`,
          url,
          authorizationHeader: projectMcpServer.authorizationHeader,
        });
      }

      let current = yield* readExternalMcpState(state.client, state.directory);
      const currentConfig = current.config;
      for (const [name, entry] of Object.entries(currentConfig)) {
        if (!isEnvironmentOwned(entry, environmentId)) continue;
        if (isCurrentGeneration(entry, environmentId, state.lease.generation)) continue;
        yield* disconnectForRegistration(state, name);
        current = yield* readExternalMcpState(state.client, state.directory);
      }

      for (const requested of desired) {
        current = yield* readExternalMcpState(state.client, state.directory);
        const existing = current.config[requested.name];
        if (
          existing !== undefined &&
          !isCurrentGeneration(existing, environmentId, state.lease.generation)
        ) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "mcp.add",
            detail: `OpenCode MCP name '${requested.name}' is already configured without T3's expected ownership markers. Rename the existing server before enabling external MCP management.`,
          });
        }

        state.attemptedNames.add(requested.name);
        const headers = {
          Authorization: requested.authorizationHeader,
          "X-T3-MCP-Owner": String(environmentId),
          "X-T3-MCP-Generation": state.lease.generation,
        };
        const response = yield* runOpenCodeSdk("mcp.add", (signal) =>
          state.client.mcp.add(
            {
              directory: state.directory,
              name: requested.name,
              config: {
                type: "remote",
                url: requested.url,
                headers,
                oauth: false,
              },
            },
            { signal },
          ),
        ).pipe(Effect.mapError(toRequestError));
        const addStatus = response.data?.[requested.name];
        if (addStatus?.status !== "connected") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "mcp.add",
            detail: `OpenCode MCP server '${requested.name}' did not connect. Reported status: ${
              typeof addStatus?.status === "string" ? addStatus.status : "missing"
            }.`,
          });
        }
        current = yield* readExternalMcpState(state.client, state.directory);
        const status = current.status[requested.name];
        if (
          status === undefined ||
          typeof status !== "object" ||
          status === null ||
          (status as { readonly status?: unknown }).status !== "connected"
        ) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "mcp.status",
            detail: `OpenCode MCP server '${requested.name}' was not connected by the follow-up status check.`,
          });
        }
      }
    });
    const deleteContextIfCurrent = (context: OpenCodeSessionContext) => {
      if (sessions.get(context.session.threadId) === context) {
        sessions.delete(context.session.threadId);
      }
      const pending = pendingInPlaceReplacementsByContext.get(context);
      if (pending) {
        removePendingInPlaceReplacement(pending);
      }
    };
    const settleStartedSession = (input: ProviderSessionSettlementInput) =>
      Effect.gen(function* () {
        const snapshot = pendingInPlaceReplacementsBySession.get(input.session);
        if (
          !snapshot ||
          snapshot.provisionalSession !== input.session ||
          snapshot.context.session.threadId !== input.threadId
        ) {
          return;
        }

        // A newer replacement owns the context. The older result is already
        // stale, so it must never restore over the newer native state.
        if (pendingInPlaceReplacementsByContext.get(snapshot.context) !== snapshot) {
          removePendingInPlaceReplacement(snapshot);
          return;
        }

        const context = snapshot.context;
        if (input.outcome === "commit") {
          removePendingInPlaceReplacement(snapshot);
          return;
        }
        if (sessions.get(input.threadId) !== context || (yield* Ref.get(context.stopped))) {
          removePendingInPlaceReplacement(snapshot);
          return;
        }

        context.quarantined = true;
        const restoreExit = yield* Effect.exit(
          Effect.gen(function* () {
            if (snapshot.mcpConfigurationChanged) {
              yield* restoreManagedOpenCodeMcpConfigurationStrict(
                context.client,
                context.server,
                snapshot.previousManagedMcpConfig,
                snapshot.managedMcpConfigWasRead,
              );
            }
            if (snapshot.permissionsUpdated) {
              yield* runOpenCodeSdk("session.update", () =>
                context.client.session.update({
                  sessionID: context.openCodeSessionId,
                  permission: buildOpenCodePermissionRules(snapshot.previousRuntimeMode),
                }),
              ).pipe(Effect.mapError(toRequestError));
            }
            const { model: _currentModel, ...sessionWithoutModel } = context.session;
            const restoredSession =
              snapshot.previousModel === undefined
                ? {
                    ...sessionWithoutModel,
                    runtimeMode: snapshot.previousRuntimeMode,
                    updatedAt: yield* nowIso,
                  }
                : {
                    ...context.session,
                    model: snapshot.previousModel,
                    runtimeMode: snapshot.previousRuntimeMode,
                    updatedAt: yield* nowIso,
                  };
            context.session = restoredSession;
          }),
        );
        removePendingInPlaceReplacement(snapshot);
        if (Exit.isFailure(restoreExit)) {
          context.quarantined = true;
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.settlement",
            detail: "Failed to restore native OpenCode state after a rejected replacement.",
            cause: Cause.squash(restoreExit.cause),
          });
        }
        context.quarantined = false;
      });
    const awaitOpenCodeContextReady = Effect.fn("awaitOpenCodeContextReady")(function* (
      context: OpenCodeSessionContext,
    ) {
      yield* Deferred.await(context.firstConnection);
      const current = yield* ensureSessionContext(sessions, context.session.threadId);
      if (current !== context) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: context.session.threadId,
        });
      }
      return current;
    });
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenCode runtime identifier.",
            cause,
          }),
      ),
    );
    let messageIdEpochMillis = -1;
    let messageIdCounter = 0;
    // Keep OpenCode's sortable native shape so equal-time messages retain their
    // upstream order while prompt admission can match the generated id.
    const makeOpenCodeMessageId = Effect.fn("makeOpenCodeMessageId")(function* () {
      const epochMillis = DateTime.toEpochMillis(yield* DateTime.now);
      if (epochMillis !== messageIdEpochMillis) {
        messageIdEpochMillis = epochMillis;
        messageIdCounter = 0;
      }
      messageIdCounter += 1;
      const encodedTime = BigInt.asUintN(
        48,
        BigInt(epochMillis) * 0x1000n + BigInt(messageIdCounter),
      )
        .toString(16)
        .padStart(12, "0");
      const randomBytes = yield* crypto.randomBytes(14).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "crypto/randomBytes",
              detail: "Failed to generate an OpenCode message identifier.",
              cause,
            }),
        ),
      );
      const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
      const random = Array.from(randomBytes, (byte) => alphabet[byte % alphabet.length]).join("");
      return `msg_${encodedTime}${random}`;
    });
    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "opencode.sdk.event" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Each session's `Scope.close` tears down its spawned OpenCode
    // server (via the `ChildProcessSpawner` finalizer installed in
    // `startOpenCodeServerProcess`) and interrupts the forked event/exit
    // fibers. Consumers that can't reason about Effect scopes therefore
    // cannot leak OpenCode child processes by forgetting to call `stopAll`.
    // Detach every session, then drop the MCP entries this adapter registered
    // on external OpenCode servers. Shared by `stopAll` and the layer
    // finalizer so both paths leave external servers in the same state.
    // `ignoreCause` swallows both typed failures (none here) and defects from
    // throwing scope finalizers so a sibling's death can't interrupt the
    // remaining cleanups.
    const closeAllSessions = Effect.gen(function* () {
      const contexts = [...sessions.values()];
      sessions.clear();
      yield* Effect.forEach(
        contexts,
        (context) =>
          Effect.ignoreCause(
            closeOpenCodeContext(context, "detach", settlePendingOpenCodeRequests),
          ),
        { concurrency: "unbounded", discard: true },
      );
      yield* Effect.forEach(
        [...externalMcpStates.values()],
        (state) => Effect.ignoreCause(cleanupExternalMcpState(state)),
        { concurrency: "unbounded", discard: true },
      );
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* closeAllSessions;
        // Close the logger AFTER session teardown so any final lifecycle
        // events emitted during shutdown still get written. `close` flushes
        // the `Logger.batched` window and closes each per-thread
        // `RotatingFileSink` handle owned by the logger's internal scope.
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

    const emitOpenCodeTokenUsage = Effect.fn("emitOpenCodeTokenUsage")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId | undefined,
      tokens:
        | {
            readonly total?: number;
            readonly input: number;
            readonly output: number;
            readonly reasoning: number;
            readonly cache: { readonly read: number };
          }
        | undefined,
      raw: unknown,
    ) {
      const usage = normalizeOpenCodeTokenUsage(tokens);
      if (!usage) {
        return;
      }
      const signature = openCodeTokenUsageSignature(usage);
      if (signature === context.lastTokenUsageSignature) {
        return;
      }
      context.lastTokenUsageSignature = signature;
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          raw,
        })),
        type: "thread.token-usage.updated",
        payload: { usage },
      });
    });

    const rehydrateOpenCodeContext = Effect.fn("rehydrateOpenCodeContext")(function* (
      context: OpenCodeSessionContext,
    ) {
      const messages = yield* runOpenCodeSdk("session.messages", () =>
        context.client.session.messages({
          sessionID: context.openCodeSessionId,
        }),
      );
      const entries = messages.data ?? [];
      const knownAssistantMessages = new Map(
        (context.recovery?.assistantMessages ?? []).map((message) => [message.messageId, message]),
      );
      let latestProviderUserMessageId: string | undefined;
      let latestProviderUserMessageCreated = -Infinity;
      for (const entry of entries) {
        if (
          entry.info.role === "user" &&
          entry.info.time.created >= latestProviderUserMessageCreated
        ) {
          latestProviderUserMessageId = entry.info.id;
          latestProviderUserMessageCreated = entry.info.time.created;
        }
      }

      // Seed ids and final values before the event stream can replay them.
      // For the recovered turn, seed only the text T3 has already projected;
      // the provider history can contain output that was generated while T3
      // was disconnected and still needs to be replayed.
      for (const entry of entries) {
        context.messageRoleById.set(entry.info.id, entry.info.role);
        const isRecoveredTurnAssistant =
          context.recovery !== undefined &&
          entry.info.role === "assistant" &&
          (entry.info.parentID === context.recovery.userMessageId ||
            entry.info.parentID === latestProviderUserMessageId ||
            entry.parts.some((part) =>
              knownAssistantMessages.has(MessageId.make(`assistant:${part.id}`)),
            ));
        if (entry.info.role === "assistant") {
          const usage = normalizeOpenCodeTokenUsage(entry.info.tokens);
          if (usage) {
            context.lastTokenUsageSignature = openCodeTokenUsageSignature(usage);
          }
        }
        for (const part of entry.parts) {
          context.partById.set(part.id, part);
          if (part.type === "subtask") {
            context.subtaskPartById.set(part.id, part);
          }
          if (part.type === "text" || part.type === "reasoning") {
            const projectedAssistantMessage = isRecoveredTurnAssistant
              ? knownAssistantMessages.get(MessageId.make(`assistant:${part.id}`))
              : undefined;
            const textAlreadyProjected = projectedAssistantMessage?.text;
            if (isRecoveredTurnAssistant) {
              if (textAlreadyProjected && textAlreadyProjected.length > 0) {
                context.emittedTextByPartId.set(part.id, textAlreadyProjected);
              }
            } else if (part.text.length > 0) {
              context.emittedTextByPartId.set(part.id, part.text);
            }
            if (
              part.time?.end !== undefined &&
              (!isRecoveredTurnAssistant || projectedAssistantMessage?.streaming === false)
            ) {
              context.completedAssistantPartIds.add(part.id);
            }
          }
          if (part.type === "tool") {
            context.toolStatusByCallId.set(
              openCodeToolCallKey(part.sessionID, part.callID),
              part.state.status,
            );
          }
        }
      }

      for (const entry of entries) {
        for (const part of entry.parts) {
          if (part.type !== "tool") {
            continue;
          }
          const existingTaskSessionId = context.taskSessionByToolCallId.get(part.callID);
          const existingTask = existingTaskSessionId
            ? context.tasksBySessionId.get(existingTaskSessionId)
            : undefined;
          const subtask = [...context.subtaskPartById.values()].findLast(
            (candidate) => candidate.messageID === part.messageID,
          );
          const task = openCodeTaskStateFromToolPart(
            part,
            context.openCodeSessionId,
            subtask,
            existingTask,
          );
          if (!task) {
            continue;
          }
          task.terminal =
            task.terminal || part.state.status === "completed" || part.state.status === "error";
          context.tasksBySessionId.set(task.sessionId, task);
          context.taskSessionByToolCallId.set(part.callID, task.sessionId);
          context.relatedSessionIds.add(task.sessionId);
        }
      }
    });

    const emitStoppedOpenCodeTask = (context: OpenCodeSessionContext, task: OpenCodeTaskState) => {
      if (task.terminal) {
        return Effect.void;
      }
      task.terminal = true;
      return Effect.gen(function* () {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            itemId: task.toolUseId,
            raw: { type: "session.exited", reason: "OpenCode session stopped." },
          })),
          type: "task.completed",
          payload: {
            ...openCodeTaskLinkage(task),
            status: "stopped" as const,
            summary: "OpenCode session stopped.",
          },
        });
      });
    };

    const settlePendingOpenCodeRequests = Effect.fn("settlePendingOpenCodeRequests")(function* (
      context: OpenCodeSessionContext,
    ) {
      const turnId = context.activeTurnId;
      const pendingPermissions = [...context.pendingPermissions.values()];
      const pendingQuestions = [...context.pendingQuestions.values()];

      // Stop relation retries before emitting terminal events. This prevents
      // a request discovered by a late ancestry lookup from being reopened
      // after the session has already been stopped.
      for (const retry of context.requestRelationRetries.values()) {
        if (retry.fiber) {
          yield* Fiber.interrupt(retry.fiber);
        }
      }
      context.requestRelationRetries.clear();

      for (const request of pendingPermissions) {
        if (context.emittedTerminalRequestIds.has(request.id)) {
          continue;
        }
        context.resolvedRequestIds.add(request.id);
        context.emittedTerminalRequestIds.add(request.id);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId: request.id,
            raw: request,
          })),
          type: "request.resolved",
          payload: {
            requestType: mapPermissionToRequestType(request.permission),
            decision: "cancel",
          },
        });
      }
      context.pendingPermissions.clear();

      for (const request of pendingQuestions) {
        if (context.emittedTerminalRequestIds.has(request.id)) {
          continue;
        }
        context.resolvedRequestIds.add(request.id);
        context.emittedTerminalRequestIds.add(request.id);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId: request.id,
            raw: request,
          })),
          type: "user-input.resolved",
          payload: { answers: {} },
        });
      }
      context.pendingQuestions.clear();

      // A session can be stopped while a Task tool is waiting on one of the
      // requests above. Terminalize every remaining child so the Agents fold
      // cannot leave a stale "working" row behind after teardown.
      for (const task of context.tasksBySessionId.values()) {
        yield* emitStoppedOpenCodeTask(context, task);
      }
    });

    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

    const cancelIdleReconciliation = Effect.fn("cancelIdleReconciliation")(function* (
      context: OpenCodeSessionContext,
    ) {
      const pending = context.pendingIdleReconciliation;
      context.pendingIdleReconciliation = undefined;
      if (pending?.fiber) {
        yield* Fiber.interrupt(pending.fiber);
      }
    });

    const hasPendingOpenCodeRequest = (context: OpenCodeSessionContext) =>
      context.pendingPermissions.size > 0 || context.pendingQuestions.size > 0;

    // `session.command` does not acknowledge submission until the command has
    // finished. A command-originated busy status, message, or input request is
    // stronger evidence that OpenCode accepted it, and lets T3 stop waiting on
    // Node's HTTP headers timeout while retaining the command fiber for Stop.
    const acceptNativeCommandAdmission = Effect.fn("acceptNativeCommandAdmission")(function* (
      context: OpenCodeSessionContext,
    ) {
      const admission = context.promptAdmission;
      if (
        !admission?.nativeCommand ||
        admission.accepted ||
        admission.cancelled ||
        context.activeTurnId !== admission.turnId
      ) {
        return;
      }
      admission.accepted = true;
      yield* Deferred.succeed(admission.acceptance, undefined).pipe(Effect.ignore);
    });

    const completeOpenCodeTurn = Effect.fn("completeOpenCodeTurn")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      promptGeneration: number,
      raw: unknown,
    ) {
      const updatedAt = yield* nowIso;
      const stopped = yield* Ref.get(context.stopped);
      if (
        stopped ||
        context.activeTurnId !== turnId ||
        context.promptGeneration !== promptGeneration ||
        context.cancellation?.turnId === turnId
      ) {
        return;
      }
      const pendingIdleReconciliation = context.pendingIdleReconciliation;
      if (
        pendingIdleReconciliation?.turnId === turnId &&
        pendingIdleReconciliation.promptGeneration === promptGeneration
      ) {
        context.pendingIdleReconciliation = undefined;
      }
      context.activeTurnId = undefined;
      context.recovery = undefined;
      context.activeAgent = undefined;
      context.activeVariant = undefined;
      context.interruptedTurnId = undefined;
      context.awaitingBusyAfterInterruption = false;
      context.reconcileIdleStatus = false;
      context.reconcileRecoveredHistory = false;
      applyProviderSessionUpdate(
        context,
        { status: "ready" },
        { clearActiveTurnId: true },
        updatedAt,
      );
      if (pendingIdleReconciliation?.fiber) {
        yield* Fiber.interrupt(pendingIdleReconciliation.fiber);
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          raw,
        })),
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });
    });

    const scheduleIdleReconciliation = Effect.fn("scheduleIdleReconciliation")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      raw: unknown,
    ) {
      const existing = context.pendingIdleReconciliation;
      if (existing?.turnId === turnId && existing.promptGeneration === context.promptGeneration) {
        existing.raw = raw;
        existing.dirty = true;
        return;
      }
      yield* cancelIdleReconciliation(context);

      const pending: OpenCodeIdleReconciliation = {
        turnId,
        promptGeneration: context.promptGeneration,
        raw,
        warned: false,
        dirty: false,
        idleStatusConfirmations: 0,
      };
      context.pendingIdleReconciliation = pending;
      const reconcile = Effect.gen(function* () {
        let retryCount = 0;
        while (context.pendingIdleReconciliation === pending) {
          if (
            context.activeTurnId !== turnId ||
            context.awaitingBusyAfterInterruption ||
            context.promptGeneration !== pending.promptGeneration ||
            hasPendingOpenCodeRequest(context)
          ) {
            context.pendingIdleReconciliation = undefined;
            return;
          }
          const result = yield* runOpenCodeSdk("session.status", (signal) =>
            context.client.session.status(undefined, { signal }),
          ).pipe(
            Effect.timeout("1 second"),
            Effect.retry({ times: 1 }),
            Effect.match({
              onFailure: (cause) => ({ type: "unknown" as const, cause }),
              onSuccess: (response) => {
                const data = Option.getOrUndefined(decodeOpenCodeSessionStatusMap(response.data));
                if (data === undefined) {
                  return { type: "unknown" as const, cause: undefined };
                }
                const status = data[context.openCodeSessionId];
                if (status === undefined || status.type === "idle") {
                  return { type: "idle" as const };
                }
                if (status.type === "busy" || status.type === "retry") {
                  return { type: "busy" as const };
                }
                return { type: "unknown" as const, cause: undefined };
              },
            }),
          );

          if (
            context.pendingIdleReconciliation !== pending ||
            context.activeTurnId !== turnId ||
            context.promptGeneration !== pending.promptGeneration
          ) {
            return;
          }
          if (result.type === "idle") {
            yield* reconcileOpenCodeMessageHistory(context, turnId, pending.raw).pipe(
              Effect.catchCause(() => Effect.void),
            );
            // Immediately after a recovered question/approval reply, OpenCode
            // can expose its previous idle status before the resumed agent
            // flips to busy. Require a second idle observation so that stale
            // snapshot cannot finish the original turn before its output.
            if (
              context.recovery?.turnId === turnId &&
              context.reconcileRecoveredHistory &&
              pending.idleStatusConfirmations === 0
            ) {
              pending.idleStatusConfirmations += 1;
              yield* Effect.sleep("250 millis");
              continue;
            }
            context.pendingIdleReconciliation = undefined;
            yield* completeOpenCodeTurn(context, turnId, pending.promptGeneration, pending.raw);
            return;
          }
          if (result.type === "busy") {
            pending.idleStatusConfirmations = 0;
            if (pending.dirty) {
              pending.dirty = false;
              continue;
            }
            if (context.reconcileRecoveredHistory) {
              yield* Effect.sleep("250 millis");
              continue;
            }
            context.pendingIdleReconciliation = undefined;
            return;
          }
          if (!pending.warned) {
            pending.warned = true;
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode turn completion is waiting for session status.",
                detail:
                  result.cause === undefined
                    ? "session.status returned missing or invalid status data."
                    : openCodeRuntimeErrorDetail(result.cause),
              },
            });
          }
          const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
          retryCount += 1;
          yield* Effect.sleep(`${delayMs} millis`);
        }
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            if (context.pendingIdleReconciliation === pending) {
              context.pendingIdleReconciliation = undefined;
            }
          }),
        ),
      );
      pending.fiber = yield* reconcile.pipe(Effect.forkIn(context.sessionScope));
    });

    const failPromptAdmissionRecovery = Effect.fn("failPromptAdmissionRecovery")(function* (
      context: OpenCodeSessionContext,
      promptAdmission: OpenCodePromptAdmission,
    ) {
      if (
        context.promptAdmission !== promptAdmission ||
        context.activeTurnId !== promptAdmission.turnId ||
        context.promptGeneration !== promptAdmission.generation
      ) {
        return;
      }
      const detail =
        "OpenCode accepted the prompt, but T3 Code could not confirm its message or session status.";
      const abortExit = yield* Effect.exit(
        runOpenCodeSdk("session.abort", (signal) =>
          context.client.session.abort({ sessionID: context.openCodeSessionId }, { signal }),
        ).pipe(Effect.timeout("1 second")),
      );
      if (Exit.isFailure(abortExit)) {
        yield* emitUnexpectedExit(
          context,
          `${detail} The cleanup abort also failed: ${openCodeRuntimeErrorDetail(Cause.squash(abortExit.cause))}`,
        );
        deleteContextIfCurrent(context);
        return;
      }
      context.promptAdmission = undefined;
      context.activeTurnId = undefined;
      context.activeAgent = undefined;
      context.activeVariant = undefined;
      context.awaitingBusyAfterInterruption = false;
      context.reconcileIdleStatus = false;
      yield* updateProviderSession(
        context,
        { status: "error", lastError: detail },
        { clearActiveTurnId: true },
      );
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: promptAdmission.turnId,
          raw: promptAdmission.recoveryRaw,
        })),
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage: detail,
        },
      });
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: promptAdmission.turnId,
          raw: promptAdmission.recoveryRaw,
        })),
        type: "runtime.error",
        payload: {
          message: detail,
          class: "transport_error",
        },
      });
    });

    const schedulePromptAdmissionRecovery = Effect.fn("schedulePromptAdmissionRecovery")(function* (
      context: OpenCodeSessionContext,
      raw: unknown,
    ) {
      const promptAdmission = context.promptAdmission;
      if (!promptAdmission || promptAdmission.cancelled) {
        return;
      }
      if (raw !== undefined) {
        promptAdmission.recoveryRaw = raw;
      }
      if (promptAdmission.recoveryFiber) {
        if (promptAdmission.recoveryFiber.pollUnsafe() === undefined) {
          return;
        }
        delete promptAdmission.recoveryFiber;
      }
      const recover = Effect.gen(function* () {
        yield* Deferred.await(promptAdmission.acceptance);
        for (let retryCount = 0; retryCount < 5; retryCount += 1) {
          if (
            context.promptAdmission !== promptAdmission ||
            context.activeTurnId !== promptAdmission.turnId ||
            context.promptGeneration !== promptAdmission.generation ||
            promptAdmission.cancelled ||
            (yield* Ref.get(context.stopped))
          ) {
            return;
          }

          // OpenCode reports idle while a command is waiting for a question
          // or approval. Keep the active turn until that request resolves so
          // the client can still stop it.
          if (hasPendingOpenCodeRequest(context)) {
            // This recovery is deliberately paused, rather than terminal.
            // Release its one-shot guard now so the terminal request event
            // can start a fresh reconciliation after the answer arrives.
            delete promptAdmission.recoveryFiber;
            return;
          }

          if (!promptAdmission.messageObserved) {
            const response = yield* runOpenCodeSdk("session.message", (signal) =>
              context.client.session.message(
                {
                  sessionID: context.openCodeSessionId,
                  messageID: promptAdmission.messageId,
                },
                { signal },
              ),
            ).pipe(Effect.timeout("1 second"), Effect.option);
            const stopped = yield* Ref.get(context.stopped);
            if (
              stopped ||
              sessions.get(context.session.threadId) !== context ||
              context.promptAdmission !== promptAdmission ||
              context.activeTurnId !== promptAdmission.turnId ||
              context.promptGeneration !== promptAdmission.generation ||
              promptAdmission.cancelled
            ) {
              return;
            }
            const message = Option.isSome(response) ? response.value.data : undefined;
            if (message?.info.id === promptAdmission.messageId && message.info.role === "user") {
              promptAdmission.messageObserved = true;
              context.messageRoleById.set(promptAdmission.messageId, "user");
            }
          }

          const statusResponse = yield* runOpenCodeSdk("session.status", (signal) =>
            context.client.session.status(undefined, { signal }),
          ).pipe(Effect.timeout("1 second"), Effect.option);
          const stopped = yield* Ref.get(context.stopped);
          if (
            stopped ||
            sessions.get(context.session.threadId) !== context ||
            context.promptAdmission !== promptAdmission ||
            context.activeTurnId !== promptAdmission.turnId ||
            context.promptGeneration !== promptAdmission.generation ||
            promptAdmission.cancelled
          ) {
            return;
          }
          const statusData = Option.isSome(statusResponse)
            ? Option.getOrUndefined(decodeOpenCodeSessionStatusMap(statusResponse.value.data))
            : undefined;
          const status = statusData?.[context.openCodeSessionId];
          const isIdle =
            statusData !== undefined && (status === undefined || status.type === "idle");
          const isBusy = status?.type === "busy" || status?.type === "retry";
          if (isBusy) {
            promptAdmission.busyObserved = true;
            promptAdmission.idleStatusConfirmations = 0;
            context.awaitingBusyAfterInterruption = false;
            context.promptAdmission = undefined;
            return;
          }

          const idle = promptAdmission.idleDuringAdmission ?? promptAdmission.priorIdle;
          if (
            isIdle &&
            idle !== undefined &&
            (promptAdmission.messageObserved || promptAdmission.busyObserved)
          ) {
            context.promptAdmission = undefined;
            context.awaitingBusyAfterInterruption = false;
            yield* scheduleIdleReconciliation(context, promptAdmission.turnId, idle.raw);
            return;
          }
          if (isIdle && promptAdmission.messageObserved) {
            promptAdmission.idleStatusConfirmations += 1;
            if (promptAdmission.idleStatusConfirmations >= 2) {
              context.promptAdmission = undefined;
              context.awaitingBusyAfterInterruption = false;
              yield* completeOpenCodeTurn(
                context,
                promptAdmission.turnId,
                promptAdmission.generation,
                {
                  type: "session.status.recovered",
                  status: statusData,
                },
              );
              return;
            }
          } else if (!isIdle) {
            promptAdmission.idleStatusConfirmations = 0;
          }
          if (
            isIdle &&
            promptAdmission.messageObserved &&
            promptAdmission.recoveryRaw !== undefined
          ) {
            context.promptAdmission = undefined;
            context.awaitingBusyAfterInterruption = false;
            yield* scheduleIdleReconciliation(
              context,
              promptAdmission.turnId,
              promptAdmission.recoveryRaw,
            );
            return;
          }

          const delayMs = Math.min(250 * 2 ** retryCount, 2_000);
          yield* Effect.sleep(`${delayMs} millis`);
        }
        yield* failPromptAdmissionRecovery(context, promptAdmission);
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            delete promptAdmission.recoveryFiber;
          }),
        ),
      );
      promptAdmission.recoveryFiber = yield* recover.pipe(Effect.forkIn(context.sessionScope));
    });

    const reconcileResolvedOpenCodeRequest = Effect.fn("reconcileResolvedOpenCodeRequest")(
      function* (context: OpenCodeSessionContext, raw: unknown) {
        const activeTurnId = context.activeTurnId;
        if (!activeTurnId || hasPendingOpenCodeRequest(context)) {
          return;
        }
        if (context.recovery?.turnId === activeTurnId) {
          context.reconcileRecoveredHistory = true;
        }
        if (context.promptAdmission?.nativeCommand) {
          context.promptAdmission = undefined;
          yield* scheduleIdleReconciliation(context, activeTurnId, raw);
          return;
        }
        if (!context.promptAdmission) {
          yield* scheduleIdleReconciliation(context, activeTurnId, raw);
          return;
        }
        yield* schedulePromptAdmissionRecovery(context, raw);
      },
    );

    const interruptOpenCodeTurn = Effect.fn("interruptOpenCodeTurn")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      raw?: unknown,
    ) {
      if (context.interruptedTurnId === turnId) {
        return;
      }
      yield* cancelIdleReconciliation(context);
      context.interruptedTurnId = turnId;
      context.reconcileIdleStatus = true;
      context.awaitingBusyAfterInterruption = false;
      const cancellation =
        context.cancellation?.turnId === turnId ? context.cancellation : undefined;
      if (cancellation) {
        context.cancellation = undefined;
      }
      if (context.activeTurnId === turnId) {
        context.activeTurnId = undefined;
        if (context.recovery?.turnId === turnId) {
          context.recovery = undefined;
        }
        context.activeAgent = undefined;
        context.activeVariant = undefined;
        yield* updateProviderSession(
          context,
          { status: "ready" },
          { clearActiveTurnId: true, clearLastError: true },
        );
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          raw,
        })),
        type: "turn.aborted",
        payload: {
          reason: "Interrupted by user.",
        },
      });
      if (cancellation) {
        yield* Deferred.succeed(cancellation.completion, undefined).pipe(Effect.ignore);
      }
    });

    const abortAndConfirmOpenCodeTurn = Effect.fn("abortAndConfirmOpenCodeTurn")(function* (
      context: OpenCodeSessionContext,
      cancellation: OpenCodeCancellation,
    ) {
      const confirm = Effect.gen(function* () {
        for (const delayMs of OPENCODE_ABORT_RETRY_DELAYS) {
          if (delayMs > 0) {
            yield* Effect.sleep(`${delayMs} millis`);
          }

          yield* Effect.exit(
            runOpenCodeSdk("session.abort", (signal) =>
              context.client.session.abort({ sessionID: context.openCodeSessionId }, { signal }),
            ).pipe(
              Effect.timeout(OPENCODE_ABORT_ATTEMPT_TIMEOUT),
              Effect.catchTags({
                OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
                TimeoutError: (cause) =>
                  Effect.fail(
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session.abort",
                      detail: "OpenCode session abort attempt timed out.",
                      cause,
                    }),
                  ),
              }),
            ),
          ).pipe(Effect.asVoid);

          const statusExit = yield* Effect.exit(
            runOpenCodeSdk("session.status", (signal) =>
              context.client.session.status(undefined, { signal }),
            ).pipe(
              Effect.timeout(OPENCODE_ABORT_ATTEMPT_TIMEOUT),
              Effect.catchTags({
                OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
                TimeoutError: (cause) =>
                  Effect.fail(
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session.status",
                      detail: "OpenCode session status query timed out while confirming abort.",
                      cause,
                    }),
                  ),
              }),
            ),
          );
          if (Exit.isFailure(statusExit)) {
            continue;
          }

          const statusData = decodeOpenCodeSessionStatusMap(statusExit.value.data);
          if (Option.isNone(statusData)) {
            continue;
          }
          const status = statusData.value[context.openCodeSessionId];
          const confirmed =
            status === undefined || (status.type !== "busy" && status.type !== "retry");
          if (!confirmed) {
            continue;
          }

          if (context.cancellation === cancellation) {
            if (cancellation.turnId !== undefined) {
              yield* interruptOpenCodeTurn(context, cancellation.turnId);
            } else {
              context.cancellation = undefined;
              context.reconcileIdleStatus = true;
              yield* Deferred.succeed(cancellation.completion, undefined).pipe(Effect.ignore);
            }
          }
          return;
        }

        // Keep the confirmation operation alive until the enclosing timeout.
        // This gives a late matching session.error or session.status event a
        // chance to confirm the abort after the bounded retry attempts.
        return yield* Effect.never;
      });

      return yield* Effect.raceFirst(
        Deferred.await(cancellation.completion).pipe(Effect.asVoid),
        confirm,
      ).pipe(
        Effect.timeout(OPENCODE_ABORT_CONFIRM_TIMEOUT),
        Effect.catchTags({
          TimeoutError: (cause) =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.abort",
                detail: "OpenCode session abort did not complete within 10 seconds.",
                cause,
              }),
            ),
        }),
      );
    });

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: OpenCodeSessionContext,
      message: string,
    ) {
      // Atomic one-shot: two fibers can race here (the event-pump on stream
      // failure and the server-exit watcher). `getAndSet` flips the flag in
      // a single step so the loser observes `true` and returns; a plain
      // `Ref.get` would let both racers slip past and emit duplicates.
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      const isUnpublishedReplacement =
        context.unpublished && sessions.get(context.session.threadId) !== context;
      yield* Deferred.fail(
        context.firstConnection,
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "event.subscribe",
          detail: "OpenCode session exited before the event stream connected.",
        }),
      ).pipe(Effect.ignore);
      yield* failPendingOpenCodeCancellation(
        context,
        "OpenCode session exited during cancellation.",
      );
      context.promptAdmission = undefined;
      const turnId = context.activeTurnId;
      if (!isUnpublishedReplacement && turnId !== undefined && context.recovery !== undefined) {
        context.activeTurnId = undefined;
        context.activeAgent = undefined;
        context.activeVariant = undefined;
        yield* updateProviderSession(
          context,
          { status: "error", lastError: message },
          { clearActiveTurnId: true },
        );
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
          })),
          type: "turn.completed",
          payload: {
            state: "failed",
            errorMessage: message,
          },
        }).pipe(Effect.ignore);
      }
      deleteContextIfCurrent(context);
      if (isUnpublishedReplacement) {
        yield* settlePendingOpenCodeRequests(context).pipe(Effect.ignore);
        // A replacement that never became current must not publish lifecycle
        // events for the incumbent thread. It still owns its own cleanup.
        if (!context.server.external) {
          yield* abortOpenCodeSessionForTeardown(context);
        }
        yield* Scope.close(context.sessionScope, Exit.void);
        return;
      }
      // Emit lifecycle events BEFORE tearing down the scope. Both call sites
      // run this inside a fiber forked via `Effect.forkIn(context.sessionScope)`;
      // closing that scope triggers the fiber-interrupt finalizer, so any
      // subsequent yield point would unwind and silently drop these emits.
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "runtime.error",
        payload: {
          message,
          class: "transport_error",
        },
      }).pipe(Effect.ignore);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "session.exited",
        payload: {
          reason: message,
          recoverable: false,
          exitKind: "error",
        },
      }).pipe(Effect.ignore);
      yield* settlePendingOpenCodeRequests(context).pipe(Effect.ignore);
      // Inline the teardown that `closeOpenCodeContext` would do; we can't
      // delegate to it because our `getAndSet` above already flipped the
      // one-shot guard, so the call would no-op.
      if (!context.server.external) {
        yield* abortOpenCodeSessionForTeardown(context);
      }
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    /** Emit content.delta and completion events for an assistant text part. */
    const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
      context: OpenCodeSessionContext,
      part: Part,
      turnId: TurnId | undefined,
      raw: unknown,
    ) {
      const text = textFromPart(part);
      if (text === undefined) {
        return;
      }
      const previousText = context.emittedTextByPartId.get(part.id);
      const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
      context.emittedTextByPartId.set(part.id, latestText);
      if (latestText !== text) {
        context.partById.set(
          part.id,
          (part.type === "text" || part.type === "reasoning"
            ? { ...part, text: latestText }
            : part) satisfies Part,
        );
      }
      if (deltaToEmit.length > 0) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt:
              (part.type === "text" || part.type === "reasoning") && part.time !== undefined
                ? isoFromEpochMs(part.time.start)
                : undefined,
            raw,
          })),
          type: "content.delta",
          payload: {
            streamKind: resolveTextStreamKind(part),
            delta: deltaToEmit,
          },
        });
      }

      if (
        (part.type === "text" || part.type === "reasoning") &&
        part.time?.end !== undefined &&
        !context.completedAssistantPartIds.has(part.id)
      ) {
        context.completedAssistantPartIds.add(part.id);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt: isoFromEpochMs(part.time.end),
            raw,
          })),
          type: "item.completed",
          payload: {
            itemType: part.type === "reasoning" ? "reasoning" : "assistant_message",
            status: "completed",
            title: part.type === "reasoning" ? "Reasoning" : "Assistant message",
            ...(latestText.length > 0 ? { detail: latestText } : {}),
          },
        });
      }
    });

    // A T3 websocket can be disconnected while OpenCode continues the turn.
    // The event stream does not replay those events when the client returns,
    // so recovered turns must reconcile the provider's durable message list
    // before an idle status is allowed to complete the turn.
    const reconcileOpenCodeMessageHistory = Effect.fn("reconcileOpenCodeMessageHistory")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      raw: unknown,
    ) {
      if (context.recovery === undefined) {
        return;
      }
      const messages = yield* runOpenCodeSdk("session.messages", () =>
        context.client.session.messages({
          sessionID: context.openCodeSessionId,
        }),
      );
      for (const entry of messages.data ?? []) {
        context.messageRoleById.set(entry.info.id, entry.info.role);
        if (entry.info.role !== "assistant") {
          continue;
        }
        yield* emitOpenCodeTokenUsage(context, turnId, entry.info.tokens, raw);
        for (const part of entry.parts) {
          context.partById.set(part.id, part);
          if (part.type === "subtask") {
            context.subtaskPartById.set(part.id, part);
          }
          yield* emitAssistantTextDelta(context, part, turnId, raw);
        }
      }
    });

    const emitOpenCodeTaskStarted = Effect.fn("emitOpenCodeTaskStarted")(function* (
      context: OpenCodeSessionContext,
      task: OpenCodeTaskState,
      turnId: TurnId | undefined,
      raw: unknown,
    ) {
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          itemId: task.toolUseId,
          raw,
        })),
        type: "task.started",
        payload: {
          description: task.description,
          ...openCodeTaskLinkage(task),
        },
      });
    });

    const emitOpenCodeTaskCompleted = Effect.fn("emitOpenCodeTaskCompleted")(function* (
      context: OpenCodeSessionContext,
      task: OpenCodeTaskState,
      turnId: TurnId | undefined,
      raw: unknown,
      status: "completed" | "failed" | "stopped",
      summary?: string,
    ) {
      if (task.terminal) {
        return;
      }
      task.terminal = true;
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          itemId: task.toolUseId,
          raw,
        })),
        type: "task.completed",
        payload: {
          ...openCodeTaskLinkage(task),
          status,
          ...(summary ? { summary } : {}),
        },
      });
    });

    const emitOpenCodeTaskProgress = Effect.fn("emitOpenCodeTaskProgress")(function* (
      context: OpenCodeSessionContext,
      task: OpenCodeTaskState,
      turnId: TurnId | undefined,
      raw: unknown,
      status: "pending" | "running" | "waiting" | "idle",
      summary?: string,
      typedUsage?: RuntimeTaskUsage,
      lastToolName?: string,
    ) {
      if (task.terminal) {
        return;
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          itemId: task.toolUseId,
          raw,
        })),
        type: "task.progress",
        payload: {
          ...openCodeTaskLinkage(task),
          description: task.description,
          status,
          ...(summary ? { summary } : {}),
          ...(typedUsage ? { typedUsage } : {}),
          ...(lastToolName ? { lastToolName } : {}),
        },
      });
    });

    const emitOpenCodeTaskChildEvent = Effect.fn("emitOpenCodeTaskChildEvent")(function* (
      context: OpenCodeSessionContext,
      task: OpenCodeTaskState,
      event: OpenCodeSubscribedEvent,
      turnId: TurnId | undefined,
    ) {
      switch (event.type) {
        case "session.status":
          if (event.properties.status.type === "busy") {
            yield* emitOpenCodeTaskProgress(context, task, turnId, event, "running");
          } else if (event.properties.status.type === "retry") {
            yield* emitOpenCodeTaskProgress(
              context,
              task,
              turnId,
              event,
              "waiting",
              event.properties.status.message,
            );
          } else {
            yield* emitOpenCodeTaskCompleted(context, task, turnId, event, "completed");
          }
          break;
        case "session.idle":
          yield* emitOpenCodeTaskCompleted(context, task, turnId, event, "completed");
          break;
        case "session.error":
          yield* emitOpenCodeTaskCompleted(
            context,
            task,
            turnId,
            event,
            "failed",
            sessionErrorMessage(event.properties.error),
          );
          break;
        case "session.deleted":
          yield* emitOpenCodeTaskCompleted(context, task, turnId, event, "stopped");
          break;
        case "message.updated":
          if (event.properties.info.role === "assistant") {
            yield* emitOpenCodeTaskProgress(
              context,
              task,
              turnId,
              event,
              "running",
              undefined,
              normalizeOpenCodeTaskUsage(event.properties.info.tokens),
            );
          }
          break;
        case "message.part.updated": {
          const part = event.properties.part;
          const summary =
            part.type === "text" || part.type === "reasoning"
              ? trimText(part.text)
              : part.type === "tool"
                ? trimText(part.state.status === "running" ? part.state.title : part.tool)
                : undefined;
          if (summary) {
            yield* emitOpenCodeTaskProgress(context, task, turnId, event, "running", summary);
          }
          if (part.type === "step-finish") {
            yield* emitOpenCodeTaskProgress(
              context,
              task,
              turnId,
              event,
              "running",
              undefined,
              normalizeOpenCodeTaskUsage(part.tokens),
            );
          }
          if (part.type === "retry") {
            yield* emitOpenCodeTaskProgress(
              context,
              task,
              turnId,
              event,
              "waiting",
              `OpenCode retry attempt ${part.attempt}.`,
            );
          }
          if (part.type === "tool") {
            const toolCallKey = openCodeToolCallKey(part.sessionID, part.callID);
            const previousStatus = context.toolStatusByCallId.get(toolCallKey);
            if (
              shouldEmitOpenCodeToolStatus(
                context.toolStatusByCallId,
                toolCallKey,
                part.state.status,
              )
            ) {
              const itemType = toToolLifecycleItemType(part.tool);
              const title =
                part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
              const detail = detailFromToolPart(part);
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: part.callID,
                  createdAt: toolStateCreatedAt(part),
                  raw: event,
                })),
                type:
                  part.state.status === "completed" || part.state.status === "error"
                    ? "item.completed"
                    : previousStatus === undefined
                      ? "item.started"
                      : "item.updated",
                payload: {
                  itemType,
                  status:
                    part.state.status === "error"
                      ? "failed"
                      : part.state.status === "completed"
                        ? "completed"
                        : "inProgress",
                  ...(title ? { title } : {}),
                  ...(detail ? { detail } : {}),
                  data: {
                    tool: part.tool,
                    state: part.state,
                  },
                  agentId: task.sessionId,
                  parentToolUseId: task.toolUseId,
                },
              });
            }
          }
          break;
        }
        default:
          break;
      }
    });

    const isRelatedOpenCodeSession = Effect.fn("isRelatedOpenCodeSession")(function* (
      context: OpenCodeSessionContext,
      candidateSessionId: string,
    ) {
      if (context.relatedSessionIds.has(candidateSessionId)) {
        return true;
      }

      const seen = new Set<string>();
      const getSession = (sessionID: string) =>
        runOpenCodeSdk("session.get", () => context.client.session.get({ sessionID })).pipe(
          Effect.catchIf(
            (cause) => isOpenCodeNotFound(cause),
            () => Effect.succeed(undefined),
          ),
        );
      let sessionId: string | undefined = candidateSessionId;
      for (let depth = 0; sessionId !== undefined && depth < 32; depth += 1) {
        if (context.relatedSessionIds.has(sessionId)) {
          context.relatedSessionIds.add(candidateSessionId);
          return true;
        }
        if (seen.has(sessionId)) {
          return false;
        }
        seen.add(sessionId);
        const currentSessionId: string = sessionId;
        const response = yield* getSession(currentSessionId);
        if (response === undefined) {
          return false;
        }
        if (!response.data) {
          return yield* new OpenCodeRuntimeError({
            operation: "session.get",
            detail: `OpenCode session.get returned no session payload for '${currentSessionId}'.`,
          });
        }
        sessionId = response.data.parentID;
      }
      return false;
    });

    const emitPendingOpenCodeRequest = Effect.fn("emitPendingOpenCodeRequest")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeAskedRequestEvent,
      raw: unknown,
    ) {
      if (context.resolvedRequestIds.has(event.properties.id)) {
        return;
      }
      if (event.type === "permission.asked") {
        const request = event.properties;
        if (context.pendingPermissions.has(request.id)) {
          return;
        }
        context.pendingPermissions.set(request.id, request);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            requestId: request.id,
            raw,
          })),
          type: "request.opened",
          payload: {
            requestType: mapPermissionToRequestType(request.permission),
            detail: request.patterns.length > 0 ? request.patterns.join("\n") : request.permission,
            args: request.metadata,
          },
        });
        return;
      }

      const request = event.properties;
      if (context.pendingQuestions.has(request.id)) {
        return;
      }
      context.pendingQuestions.set(request.id, request);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: request.id,
          raw,
        })),
        type: "user-input.requested",
        payload: { questions: normalizeQuestionRequest(request) },
      });
    });

    const resolvePendingOpenCodeRequest = Effect.fn("resolvePendingOpenCodeRequest")(function* (
      context: OpenCodeSessionContext,
      requestId: string,
    ) {
      context.resolvedRequestIds.add(requestId);
      const retry = context.requestRelationRetries.get(requestId);
      context.requestRelationRetries.delete(requestId);
      if (retry?.fiber) {
        yield* Fiber.interrupt(retry.fiber);
      }
    });

    const emitTerminalOpenCodeRequest = Effect.fn("emitTerminalOpenCodeRequest")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeTerminalRequestEvent,
    ) {
      const requestId = event.properties.requestID;
      if (context.emittedTerminalRequestIds.has(requestId)) {
        return;
      }
      context.emittedTerminalRequestIds.add(requestId);
      if (event.type === "permission.replied") {
        const request = context.pendingPermissions.get(requestId);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            requestId,
            raw: event,
          })),
          type: "request.resolved",
          payload: {
            requestType: request ? mapPermissionToRequestType(request.permission) : "unknown",
            decision: mapPermissionDecision(event.properties.reply),
          },
        });
        return;
      }

      const request = context.pendingQuestions.get(requestId);
      const answers =
        event.type === "question.replied" && request
          ? Object.fromEntries(
              request.questions.map((question, index) => [
                openCodeQuestionId(index, question),
                event.properties.answers[index]?.join(", ") ?? "",
              ]),
            )
          : {};
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId,
          raw: event,
        })),
        type: "user-input.resolved",
        payload: { answers },
      });
    });

    const scheduleRequestRelationRetry = Effect.fn("scheduleRequestRelationRetry")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeRoutedRequestEvent,
      raw: unknown = event,
    ) {
      const isAskedEvent = event.type === "permission.asked" || event.type === "question.asked";
      const requestId = isAskedEvent ? event.properties.id : event.properties.requestID;
      if (context.requestRelationRetries.has(requestId)) {
        return;
      }
      if (isAskedEvent && context.resolvedRequestIds.has(requestId)) {
        return;
      }
      const retry: OpenCodeRequestRelationRetry = { warned: false };
      context.requestRelationRetries.set(requestId, retry);
      const run = Effect.gen(function* () {
        let retryCount = 0;
        while (context.requestRelationRetries.get(requestId) === retry) {
          const relation = yield* isRelatedOpenCodeSession(
            context,
            event.properties.sessionID,
          ).pipe(
            Effect.match({
              onFailure: (cause) => ({ type: "unknown" as const, cause }),
              onSuccess: (related) => ({ type: "known" as const, related }),
            }),
          );
          if (context.requestRelationRetries.get(requestId) !== retry) {
            return;
          }
          if (relation.type === "known") {
            context.requestRelationRetries.delete(requestId);
            if (relation.related) {
              if (isAskedEvent) {
                yield* emitPendingOpenCodeRequest(context, event, raw);
              } else {
                yield* emitTerminalOpenCodeRequest(context, event);
              }
            }
            return;
          }
          if (!retry.warned) {
            retry.warned = true;
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                requestId,
              })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode request routing is waiting for session ancestry.",
                detail: openCodeRuntimeErrorDetail(relation.cause),
              },
            });
          }
          const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
          retryCount += 1;
          if (!isAskedEvent && retryCount >= 5) {
            return;
          }
          yield* Effect.sleep(`${delayMs} millis`);
        }
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            if (context.requestRelationRetries.get(requestId) === retry) {
              context.requestRelationRetries.delete(requestId);
            }
          }),
        ),
      );
      retry.fiber = yield* run.pipe(Effect.forkIn(context.sessionScope));
    });

    const schedulePendingRequestRecovery = Effect.fn("schedulePendingRequestRecovery")(function* (
      context: OpenCodeSessionContext,
      options?: { readonly maxRetries?: number },
    ) {
      if (context.pendingRequestRecovery) {
        context.pendingRequestRecovery.rerun = true;
        return;
      }
      const recovery: OpenCodePendingRequestRecovery = { warned: false, rerun: false };
      context.pendingRequestRecovery = recovery;
      const run = Effect.gen(function* () {
        let retryCount = 0;
        while (context.pendingRequestRecovery === recovery) {
          const responses = yield* Effect.all({
            permissions: runOpenCodeSdk("permission.list", () => context.client.permission.list()),
            questions: runOpenCodeSdk("question.list", () => context.client.question.list()),
          }).pipe(
            Effect.match({
              onFailure: (cause) => ({ type: "failure" as const, cause }),
              onSuccess: (value) => ({ type: "success" as const, value }),
            }),
          );
          if (context.pendingRequestRecovery !== recovery) {
            return;
          }
          if (responses.type === "failure") {
            if (!recovery.warned) {
              recovery.warned = true;
              yield* emit({
                ...(yield* buildEventBase({ threadId: context.session.threadId })),
                type: "runtime.warning",
                payload: {
                  message: "OpenCode pending request recovery failed and will retry.",
                  detail: openCodeRuntimeErrorDetail(responses.cause),
                },
              });
            }
            if (options?.maxRetries !== undefined && retryCount >= options.maxRetries) {
              yield* emitUnexpectedExit(
                context,
                `OpenCode pending request recovery failed after ${options.maxRetries + 1} attempts: ${openCodeRuntimeErrorDetail(responses.cause)}`,
              );
              return;
            }
            const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
            retryCount += 1;
            yield* Effect.sleep(`${delayMs} millis`);
            continue;
          }
          const permissions = responses.value.permissions.data;
          const questions = responses.value.questions.data;
          if (permissions === undefined || questions === undefined) {
            if (!recovery.warned) {
              recovery.warned = true;
              yield* emit({
                ...(yield* buildEventBase({ threadId: context.session.threadId })),
                type: "runtime.warning",
                payload: {
                  message: "OpenCode pending request recovery returned no data and will retry.",
                },
              });
            }
            if (options?.maxRetries !== undefined && retryCount >= options.maxRetries) {
              yield* emitUnexpectedExit(
                context,
                `OpenCode pending request recovery returned no data after ${options.maxRetries + 1} attempts.`,
              );
              return;
            }
            const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
            retryCount += 1;
            yield* Effect.sleep(`${delayMs} millis`);
            continue;
          }
          yield* Effect.forEach(
            permissions,
            (request) =>
              scheduleRequestRelationRetry(
                context,
                { id: `recovered:${request.id}`, type: "permission.asked", properties: request },
                { type: "permission.asked", properties: request, recovered: true },
              ),
            { discard: true },
          );
          yield* Effect.forEach(
            questions,
            (request) =>
              scheduleRequestRelationRetry(
                context,
                { id: `recovered:${request.id}`, type: "question.asked", properties: request },
                { type: "question.asked", properties: request, recovered: true },
              ),
            { discard: true },
          );
          if (recovery.rerun) {
            recovery.rerun = false;
            recovery.warned = false;
            continue;
          }
          context.pendingRequestRecovery = undefined;
          return;
        }
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            if (context.pendingRequestRecovery === recovery) {
              context.pendingRequestRecovery = undefined;
            }
          }),
        ),
      );
      yield* run.pipe(Effect.forkIn(context.sessionScope));
    });

    const reconcileRecoveredOpenCodeSession = Effect.fn("reconcileRecoveredOpenCodeSession")(
      function* (context: OpenCodeSessionContext) {
        const recovery = context.recovery;
        if (!recovery || context.activeTurnId !== recovery.turnId) {
          return;
        }

        const statusResponse = yield* runOpenCodeSdk("session.status", (signal) =>
          context.client.session.status(undefined, { signal }),
        ).pipe(Effect.timeout("1 second"), Effect.retry({ times: 2 }), Effect.option);
        const statusData = Option.isSome(statusResponse)
          ? Option.getOrUndefined(decodeOpenCodeSessionStatusMap(statusResponse.value.data))
          : undefined;
        if (statusData === undefined) {
          const message = "OpenCode recovery could not confirm the session status.";
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId: recovery.turnId,
            })),
            type: "runtime.warning",
            payload: {
              message: `${message} Retrying was exhausted; the restored turn has failed.`,
            },
          });
          yield* emitUnexpectedExit(context, message);
          return;
        }

        const status = statusData[context.openCodeSessionId];
        if (status?.type === "busy" || status?.type === "retry") {
          if (status.type === "retry") {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: recovery.turnId,
              })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode resumed a turn that is retrying.",
                detail: status,
              },
            });
          }
          context.reconcileRecoveredHistory = true;
          yield* updateProviderSession(context, {
            status: "running",
            activeTurnId: recovery.turnId,
          });
          yield* scheduleIdleReconciliation(context, recovery.turnId, {
            type: "session.status.recovered",
            status: statusData,
          });
          return;
        }

        const pendingRequests = yield* Effect.all({
          permissions: runOpenCodeSdk("permission.list", () => context.client.permission.list()),
          questions: runOpenCodeSdk("question.list", () => context.client.question.list()),
        }).pipe(Effect.timeout("1 second"), Effect.retry({ times: 2 }), Effect.option);
        if (
          Option.isNone(pendingRequests) ||
          pendingRequests.value.permissions.data === undefined ||
          pendingRequests.value.questions.data === undefined
        ) {
          const message = "OpenCode recovery could not list pending requests.";
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId: recovery.turnId,
            })),
            type: "runtime.warning",
            payload: {
              message: `${message} Retrying was exhausted; the restored turn has failed.`,
            },
          });
          yield* emitUnexpectedExit(context, message);
          return;
        }

        if (
          pendingRequests.value.permissions.data.length > 0 ||
          pendingRequests.value.questions.data.length > 0
        ) {
          yield* updateProviderSession(context, {
            status: "running",
            activeTurnId: recovery.turnId,
          });
          return;
        }

        const recoveredIdleEvent = {
          type: "session.status.recovered",
          status: statusData,
        };
        yield* reconcileOpenCodeMessageHistory(context, recovery.turnId, recoveredIdleEvent).pipe(
          Effect.catchCause(() => Effect.void),
        );
        yield* completeOpenCodeTurn(
          context,
          recovery.turnId,
          context.promptGeneration,
          recoveredIdleEvent,
        );
      },
    );

    const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      if (
        event.type !== "server.connected" &&
        context.unpublished &&
        sessions.get(context.session.threadId) !== context
      ) {
        return;
      }
      // Record every upstream stream event before relation checks or routing.
      // Canonical provider events retain this same payload in `raw`, so the
      // provider event log can correlate a translation by upstream event id.
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: yield* nowIso,
        event: {
          provider: PROVIDER,
          threadId: context.session.threadId,
          providerThreadId: context.openCodeSessionId,
          type: event.type,
          ...("id" in event && typeof event.id === "string" ? { sourceEventId: event.id } : {}),
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: event,
        },
      });
      if (event.type === "server.connected") {
        if (
          (yield* Ref.get(context.stopped)) ||
          (sessions.get(context.session.threadId) !== context && !context.unpublished)
        ) {
          return;
        }
        const isFirstConnection = !(yield* Deferred.isDone(context.firstConnection));
        if (isFirstConnection) {
          if (context.recovery !== undefined) {
            const deferRecoveryReconciliation =
              context.unpublished && sessions.get(context.session.threadId) !== context;
            if (deferRecoveryReconciliation) {
              // A replacement candidate may be connected to the same remote
              // session while the old context still owns the thread. Do not
              // reconcile or emit recovered-turn events until the candidate
              // has won the replacement handoff.
              context.recoveryReconciliationDeferred = true;
            } else {
              yield* reconcileRecoveredOpenCodeSession(context);
              if (
                (yield* Ref.get(context.stopped)) ||
                sessions.get(context.session.threadId) !== context
              ) {
                return;
              }
            }
          }
          const updatedAt = yield* nowIso;
          if (context.recovery === undefined) {
            applyProviderSessionUpdate(context, { status: "ready" }, undefined, updatedAt);
          }
          if (!(yield* Deferred.succeed(context.firstConnection, undefined))) {
            return;
          }
        }
        if (
          (context.recovery === undefined || context.activeTurnId !== undefined) &&
          !context.recoveryReconciliationDeferred
        ) {
          yield* schedulePendingRequestRecovery(
            context,
            context.recovery !== undefined ? { maxRetries: 3 } : undefined,
          );
        }
        if (!isFirstConnection) {
          yield* schedulePromptAdmissionRecovery(context, event);
        }
        return;
      }
      const terminalRequestId =
        event.type === "permission.replied" ||
        event.type === "question.replied" ||
        event.type === "question.rejected"
          ? event.properties.requestID
          : undefined;
      if (terminalRequestId !== undefined) {
        yield* resolvePendingOpenCodeRequest(context, terminalRequestId);
      }
      if (event.type === "session.created" || event.type === "session.updated") {
        const session = event.properties.info;
        if (session.parentID && context.relatedSessionIds.has(session.parentID)) {
          context.relatedSessionIds.add(session.id);
        }
      } else if (event.type === "session.deleted") {
        context.relatedSessionIds.delete(event.properties.info.id);
      }

      const payloadSessionId = openCodeEventSessionId(event);
      // OpenCode's session.error payload makes sessionID optional. A
      // session-scoped subscription can therefore deliver a parent failure
      // without an id; treating that event as unrelated leaves the turn stuck
      // in "running" forever.
      const isParentEvent =
        payloadSessionId === context.openCodeSessionId ||
        (payloadSessionId === undefined && event.type === "session.error");
      let isKnownPendingTerminalEvent = false;
      if (
        payloadSessionId !== undefined &&
        !context.relatedSessionIds.has(payloadSessionId) &&
        isOpenCodeChildRequestEvent(event)
      ) {
        if (event.type === "permission.asked") {
          yield* scheduleRequestRelationRetry(context, event);
        } else if (event.type === "question.asked") {
          yield* scheduleRequestRelationRetry(context, event);
        } else if (
          event.type === "permission.replied" ||
          event.type === "question.replied" ||
          event.type === "question.rejected"
        ) {
          const requestId = event.properties.requestID;
          isKnownPendingTerminalEvent =
            context.pendingPermissions.has(requestId) || context.pendingQuestions.has(requestId);
          if (!isKnownPendingTerminalEvent) {
            yield* scheduleRequestRelationRetry(context, event);
            return;
          }
        }
      }
      const isChildRequestEvent =
        payloadSessionId !== undefined &&
        isOpenCodeChildRequestEvent(event) &&
        (context.relatedSessionIds.has(payloadSessionId) || isKnownPendingTerminalEvent);
      let childTask =
        payloadSessionId !== undefined ? context.tasksBySessionId.get(payloadSessionId) : undefined;
      if (
        !isParentEvent &&
        payloadSessionId !== undefined &&
        childTask === undefined &&
        context.relatedSessionIds.has(payloadSessionId) &&
        event.type !== "session.created" &&
        event.type !== "session.updated" &&
        !isOpenCodeChildRequestEvent(event)
      ) {
        // Child status/message events can race the parent Task tool's first
        // metadata update. Create the task lazily on the first non-request
        // event so the request routing path remains compatible with clients
        // that expect the request row immediately after session startup.
        childTask = {
          sessionId: payloadSessionId,
          parentSessionId: context.openCodeSessionId,
          description: "OpenCode subtask",
          terminal: false,
        };
        context.tasksBySessionId.set(payloadSessionId, childTask);
        yield* emitOpenCodeTaskStarted(context, childTask, context.activeTurnId, event);
      }
      const isKnownChildTaskEvent = childTask !== undefined;
      if (!isParentEvent && !isChildRequestEvent && !isKnownChildTaskEvent) {
        return;
      }

      const turnId = context.activeTurnId;

      const suppressInterruptedParentOutput =
        isParentEvent &&
        ((context.activeTurnId === undefined &&
          (context.interruptedTurnId !== undefined || context.reconcileIdleStatus)) ||
          context.awaitingBusyAfterInterruption) &&
        (event.type === "message.part.delta" ||
          event.type === "message.part.updated" ||
          (event.type === "message.updated" && event.properties.info.role === "assistant"));
      if (suppressInterruptedParentOutput) {
        return;
      }

      if (
        !isParentEvent &&
        isKnownChildTaskEvent &&
        childTask !== undefined &&
        isChildRequestEvent
      ) {
        if (event.type === "permission.asked") {
          yield* emitOpenCodeTaskProgress(
            context,
            childTask,
            turnId,
            event,
            "waiting",
            `Permission requested: ${event.properties.permission}`,
          );
        } else if (event.type === "question.asked") {
          yield* emitOpenCodeTaskProgress(
            context,
            childTask,
            turnId,
            event,
            "waiting",
            trimText(event.properties.questions[0]?.question),
          );
        } else {
          yield* emitOpenCodeTaskProgress(context, childTask, turnId, event, "running");
        }
      }

      if (
        !isParentEvent &&
        isKnownChildTaskEvent &&
        childTask !== undefined &&
        !isChildRequestEvent
      ) {
        yield* emitOpenCodeTaskChildEvent(context, childTask, event, turnId);
        return;
      }

      switch (event.type) {
        case "todo.updated": {
          const plan = event.properties.todos.flatMap((todo) => {
            const step = trimText(todo.content);
            return step
              ? [
                  {
                    step,
                    status: normalizeOpenCodeTodoStatus(todo.status),
                  },
                ]
              : [];
          });
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "turn.plan.updated",
            payload: { plan },
          });
          break;
        }

        case "session.diff": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "turn.diff.updated",
            payload: { unifiedDiff: formatOpenCodeDiff(event.properties.diff) },
          });
          break;
        }

        case "session.compacted": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "thread.state.changed",
            payload: { state: "compacted" },
          });
          break;
        }

        case "session.updated": {
          const title = openCodeEventSessionTitle(event);
          if (title) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                raw: event,
              })),
              type: "thread.metadata.updated",
              payload: {
                name: title,
                metadata: {
                  sessionID: context.openCodeSessionId,
                },
              },
            });
          }
          break;
        }

        case "message.updated": {
          const promptAdmission = context.promptAdmission;
          if (
            event.properties.info.role === "user" &&
            promptAdmission?.messageId === event.properties.info.id
          ) {
            promptAdmission.messageObserved = true;
            yield* acceptNativeCommandAdmission(context);
            if (promptAdmission.accepted) {
              const idle = promptAdmission.idleDuringAdmission;
              context.awaitingBusyAfterInterruption = false;
              if (promptAdmission.nativeCommand) {
                // The command may be paused on a question after its user
                // message arrives. Keep its admission so the answer's
                // terminal event can reconcile the consumed idle status.
                yield* schedulePromptAdmissionRecovery(context, event);
              } else {
                context.promptAdmission = undefined;
                if (promptAdmission.recoveryFiber) {
                  yield* Fiber.interrupt(promptAdmission.recoveryFiber);
                }
                if (idle) {
                  yield* scheduleIdleReconciliation(context, idle.turnId, idle.raw);
                }
              }
            }
          }
          context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
          if (event.properties.info.role === "assistant") {
            yield* emitOpenCodeTokenUsage(context, turnId, event.properties.info.tokens, event);
            for (const part of context.partById.values()) {
              if (part.messageID !== event.properties.info.id) {
                continue;
              }
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }
          }
          break;
        }

        case "message.removed": {
          context.messageRoleById.delete(event.properties.messageID);
          break;
        }

        case "message.part.removed": {
          const removedPart = context.partById.get(event.properties.partID);
          if (removedPart?.type === "tool") {
            const taskSessionId = context.taskSessionByToolCallId.get(removedPart.callID);
            const task = taskSessionId ? context.tasksBySessionId.get(taskSessionId) : undefined;
            if (task) {
              yield* emitOpenCodeTaskCompleted(
                context,
                task,
                turnId,
                event,
                "stopped",
                "OpenCode task part was removed.",
              );
            }
          }
          context.partById.delete(event.properties.partID);
          context.subtaskPartById.delete(event.properties.partID);
          context.pendingTextDeltasByPartId.delete(event.properties.partID);
          context.emittedTextByPartId.delete(event.properties.partID);
          context.completedAssistantPartIds.delete(event.properties.partID);
          break;
        }

        case "message.part.delta": {
          const existingPart = context.partById.get(event.properties.partID);
          if (!existingPart) {
            context.pendingTextDeltasByPartId.set(
              event.properties.partID,
              `${context.pendingTextDeltasByPartId.get(event.properties.partID) ?? ""}${event.properties.delta}`,
            );
            break;
          }
          const role = messageRoleForPart(context, existingPart);
          if (role !== "assistant") {
            break;
          }
          const streamKind = resolveTextStreamKind(existingPart);
          const delta = event.properties.delta;
          if (delta.length === 0) {
            break;
          }
          const previousText =
            context.emittedTextByPartId.get(event.properties.partID) ??
            textFromPart(existingPart) ??
            "";
          const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
          if (deltaToEmit.length === 0) {
            break;
          }
          context.emittedTextByPartId.set(event.properties.partID, nextText);
          if (existingPart.type === "text" || existingPart.type === "reasoning") {
            context.partById.set(event.properties.partID, {
              ...existingPart,
              text: nextText,
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: event.properties.partID,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind,
              delta: deltaToEmit,
            },
          });
          break;
        }

        case "message.part.updated": {
          const rawPart = event.properties.part;
          const pendingDelta = context.pendingTextDeltasByPartId.get(rawPart.id);
          context.pendingTextDeltasByPartId.delete(rawPart.id);
          const part =
            pendingDelta && (rawPart.type === "text" || rawPart.type === "reasoning")
              ? {
                  ...rawPart,
                  text: rawPart.text.endsWith(pendingDelta)
                    ? rawPart.text
                    : `${rawPart.text}${pendingDelta}`,
                }
              : rawPart;
          context.partById.set(part.id, part);
          if (part.type === "subtask") {
            context.subtaskPartById.set(part.id, part);
          }
          const messageRole = messageRoleForPart(context, part);

          if (messageRole === "assistant") {
            yield* emitAssistantTextDelta(context, part, turnId, event);
          }

          if (part.type === "step-finish") {
            yield* emitOpenCodeTokenUsage(context, turnId, part.tokens, event);
          } else if (part.type === "retry") {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "runtime.warning",
              payload: {
                message: `OpenCode retry attempt ${part.attempt}.`,
                detail: part.error,
              },
            });
          } else if (part.type === "compaction") {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "thread.state.changed",
              payload: {
                state: "compacted",
                detail: { auto: part.auto, overflow: part.overflow },
              },
            });
          }

          if (part.type === "tool") {
            const toolCallKey = openCodeToolCallKey(part.sessionID, part.callID);
            const previousStatus = context.toolStatusByCallId.get(toolCallKey);
            const existingTaskSessionId = context.taskSessionByToolCallId.get(part.callID);
            const metadata = part.state.status === "pending" ? undefined : part.state.metadata;
            const hintedChildSessionId =
              openCodeStringValue(openCodeRecordValue(metadata, "sessionId")) ??
              openCodeStringValue(openCodeRecordValue(metadata, "sessionID")) ??
              openCodeStringValue(openCodeRecordValue(metadata, "childSessionId"));
            const existingTask =
              (existingTaskSessionId
                ? context.tasksBySessionId.get(existingTaskSessionId)
                : undefined) ??
              (hintedChildSessionId
                ? context.tasksBySessionId.get(hintedChildSessionId)
                : undefined);
            const subtask = [...context.subtaskPartById.values()].findLast(
              (candidate) => candidate.messageID === part.messageID,
            );
            const task = openCodeTaskStateFromToolPart(
              part,
              context.openCodeSessionId,
              subtask,
              existingTask,
            );
            if (task) {
              const wasNew = !existingTask;
              context.tasksBySessionId.set(task.sessionId, task);
              context.taskSessionByToolCallId.set(part.callID, task.sessionId);
              context.relatedSessionIds.add(task.sessionId);
              if (wasNew) {
                yield* emitOpenCodeTaskStarted(context, task, turnId, event);
              } else if (part.state.status === "running" && previousStatus !== part.state.status) {
                // A child event may have created a provisional row before
                // this parent Task snapshot arrived. Repeat the linkage on a
                // progress row so its real description/role/model replaces
                // the provisional metadata in the client fold.
                yield* emitOpenCodeTaskProgress(
                  context,
                  task,
                  turnId,
                  event,
                  "running",
                  trimText(part.state.title) ?? task.description,
                  undefined,
                  part.tool,
                );
              }
              if (part.state.status === "completed") {
                yield* emitOpenCodeTaskCompleted(
                  context,
                  task,
                  turnId,
                  event,
                  "completed",
                  trimText(part.state.output),
                );
              } else if (part.state.status === "error") {
                yield* emitOpenCodeTaskCompleted(
                  context,
                  task,
                  turnId,
                  event,
                  "failed",
                  trimText(part.state.error),
                );
              }
            }
            if (
              !shouldEmitOpenCodeToolStatus(
                context.toolStatusByCallId,
                toolCallKey,
                part.state.status,
              )
            ) {
              break;
            }
            const itemType = toToolLifecycleItemType(part.tool);
            const title =
              part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
            const detail = detailFromToolPart(part);
            const payload = {
              itemType,
              ...(part.state.status === "error"
                ? { status: "failed" as const }
                : part.state.status === "completed"
                  ? { status: "completed" as const }
                  : { status: "inProgress" as const }),
              ...(title ? { title } : {}),
              ...(detail ? { detail } : {}),
              data: {
                tool: part.tool,
                state: part.state,
              },
            };
            const runtimeEvent: ProviderRuntimeEvent = {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: part.callID,
                createdAt: toolStateCreatedAt(part),
                raw: event,
              })),
              type:
                part.state.status === "pending"
                  ? "item.started"
                  : part.state.status === "completed" || part.state.status === "error"
                    ? "item.completed"
                    : previousStatus === undefined
                      ? "item.started"
                      : "item.updated",
              payload,
            };
            appendTurnItem(context, turnId, part);
            yield* emit(runtimeEvent);
          }
          break;
        }

        case "permission.asked": {
          yield* emitPendingOpenCodeRequest(context, event, event);
          yield* acceptNativeCommandAdmission(context);
          break;
        }

        case "permission.replied": {
          yield* emitTerminalOpenCodeRequest(context, event);
          context.pendingPermissions.delete(event.properties.requestID);
          yield* reconcileResolvedOpenCodeRequest(context, event);
          break;
        }

        case "question.asked": {
          yield* emitPendingOpenCodeRequest(context, event, event);
          yield* acceptNativeCommandAdmission(context);
          break;
        }

        case "question.replied": {
          yield* emitTerminalOpenCodeRequest(context, event);
          context.pendingQuestions.delete(event.properties.requestID);
          yield* reconcileResolvedOpenCodeRequest(context, event);
          break;
        }

        case "question.rejected": {
          context.pendingQuestions.delete(event.properties.requestID);
          yield* emitTerminalOpenCodeRequest(context, event);
          yield* reconcileResolvedOpenCodeRequest(context, event);
          break;
        }

        case "session.status": {
          if (event.properties.status.type === "busy") {
            if (turnId === undefined) {
              break;
            }
            yield* cancelIdleReconciliation(context);
            context.awaitingBusyAfterInterruption = false;
            if (context.promptAdmission?.turnId === turnId) {
              context.promptAdmission.busyObserved = true;
              yield* acceptNativeCommandAdmission(context);
              yield* schedulePromptAdmissionRecovery(context, event);
            }
            yield* updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
          }

          if (event.properties.status.type === "retry") {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "runtime.warning",
              payload: {
                message: event.properties.status.message,
                detail: event.properties.status,
              },
            });
            break;
          }

          if (event.properties.status.type === "idle" && turnId) {
            if (hasPendingOpenCodeRequest(context)) {
              break;
            }
            if (context.cancellation?.turnId === turnId) {
              break;
            }
            if (context.promptAdmission?.turnId === turnId) {
              context.promptAdmission.idleDuringAdmission = { turnId, raw: event };
              context.promptAdmission.idleObservedAfterMessage =
                context.promptAdmission.messageObserved;
              yield* schedulePromptAdmissionRecovery(context, event);
              break;
            }
            if (context.awaitingBusyAfterInterruption) {
              break;
            }
            if (
              context.reconcileIdleStatus ||
              context.reconcileRecoveredHistory ||
              context.pendingIdleReconciliation?.turnId === turnId
            ) {
              yield* scheduleIdleReconciliation(context, turnId, event);
              break;
            }
            yield* completeOpenCodeTurn(context, turnId, context.promptGeneration, event);
          }
          break;
        }

        case "session.idle": {
          if (turnId === undefined) {
            break;
          }
          // `session.idle` is the concise lifecycle event emitted by newer
          // OpenCode servers. It must obey the same admission and interruption
          // guards as `session.status: idle`, otherwise a child/late idle can
          // complete the wrong turn.
          if (context.cancellation?.turnId === turnId) {
            break;
          }
          if (hasPendingOpenCodeRequest(context)) {
            break;
          }
          if (context.promptAdmission?.turnId === turnId) {
            context.promptAdmission.idleDuringAdmission = { turnId, raw: event };
            context.promptAdmission.idleObservedAfterMessage =
              context.promptAdmission.messageObserved;
            yield* schedulePromptAdmissionRecovery(context, event);
            break;
          }
          if (context.awaitingBusyAfterInterruption) {
            break;
          }
          if (
            context.reconcileIdleStatus ||
            context.reconcileRecoveredHistory ||
            context.pendingIdleReconciliation?.turnId === turnId
          ) {
            yield* scheduleIdleReconciliation(context, turnId, event);
            break;
          }
          yield* completeOpenCodeTurn(context, turnId, context.promptGeneration, event);
          break;
        }

        case "session.deleted":
          // A deleted parent session cannot accept a follow-up prompt. Treat
          // it as a terminal transport failure so the orchestration session
          // and Agents rows are released instead of remaining active forever.
          yield* emitUnexpectedExit(context, "OpenCode session was deleted.");
          break;

        case "session.error": {
          const message = sessionErrorMessage(event.properties.error);
          const activeTurnId = context.activeTurnId;
          const cancellation = context.cancellation;
          if (isOpenCodeAbortError(event.properties.error)) {
            if (cancellation !== undefined && cancellation.turnId === undefined) {
              context.cancellation = undefined;
              context.reconcileIdleStatus = true;
              yield* Deferred.succeed(cancellation.completion, undefined).pipe(Effect.ignore);
              break;
            }
            if (activeTurnId !== undefined && cancellation?.turnId === activeTurnId) {
              yield* interruptOpenCodeTurn(context, activeTurnId, event);
              break;
            }
            if (context.interruptedTurnId !== undefined || context.reconcileIdleStatus) {
              break;
            }
          }
          yield* cancelIdleReconciliation(context);
          if (activeTurnId !== undefined && cancellation?.turnId === activeTurnId) {
            context.cancellation = undefined;
            yield* Deferred.succeed(cancellation.completion, undefined).pipe(Effect.ignore);
          }
          context.activeTurnId = undefined;
          context.activeAgent = undefined;
          context.activeVariant = undefined;
          context.reconcileIdleStatus = false;
          yield* updateProviderSession(
            context,
            {
              status: "error",
              lastError: message,
            },
            { clearActiveTurnId: true },
          );
          if (activeTurnId) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: activeTurnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: message,
              },
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              raw: event,
            })),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
              detail: event.properties.error,
            },
          });
          break;
        }

        default:
          break;
      }
    });

    const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
      // One AbortController per session scope. The finalizer fires when
      // the scope closes (explicit stop, unexpected exit, or layer
      // shutdown) and cancels the in-flight `event.subscribe` fetch so
      // the async iterable unwinds cleanly.
      const eventsAbortController = new AbortController();
      yield* Scope.addFinalizer(
        context.sessionScope,
        Effect.sync(() => eventsAbortController.abort()),
      );

      // Fibers forked into `context.sessionScope` are interrupted
      // automatically when the scope closes — no bookkeeping required.
      yield* Effect.flatMap(
        runOpenCodeSdk("event.subscribe", () =>
          context.client.event.subscribe(undefined, {
            signal: eventsAbortController.signal,
          }),
        ),
        (subscription) =>
          Stream.fromAsyncIterable(
            subscription.stream,
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "event.subscribe",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          ).pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event))),
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            // Expected paths: caller aborted the fetch or the session
            // has already been marked stopped. Treat as a clean exit.
            if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
              return;
            }
            if (Exit.isFailure(exit)) {
              yield* emitUnexpectedExit(
                context,
                openCodeRuntimeErrorDetail(Cause.squash(exit.cause)),
              );
            }
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );

      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedExit(context, `OpenCode server exited unexpectedly (${code}).`);
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
    });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const binaryPath = openCodeSettings.binaryPath;
        const serverUrl = openCodeSettings.serverUrl;
        const serverPassword = openCodeSettings.serverPassword;
        const directory = input.cwd ?? serverConfig.cwd;
        const resumeSessionId = parseOpenCodeResume(input.resumeCursor)?.sessionId;
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const hasExternalMcpWork =
          mcpSession !== undefined || (input.projectMcpServers?.length ?? 0) > 0;
        if (serverUrl && openCodeSettings.manageExternalMcp) {
          yield* Effect.try({
            try: () => {
              validateExternalOpenCodeUrl(serverUrl);
              validateExternalMcpBaseUrl(openCodeSettings.externalMcpBaseUrl);
            },
            catch: (cause) => toExternalMcpRequestError("startSession", cause),
          });
        }
        const existing = sessions.get(input.threadId);
        let previousManagedMcpConfig: OpenCodeMcpEntry | undefined;
        let managedMcpConfigWasRead = false;
        const restoreMcpConfiguration = (
          client: OpencodeClient,
          server: OpenCodeServerConnection,
        ) =>
          restoreManagedOpenCodeMcpConfiguration(
            client,
            server,
            previousManagedMcpConfig,
            managedMcpConfigWasRead,
          );
        if (existing) {
          if (existing.session.status === "connecting" && !(yield* Ref.get(existing.stopped))) {
            return (yield* awaitOpenCodeContextReady(existing)).session;
          }
          if (yield* Ref.get(existing.stopped)) {
            deleteContextIfCurrent(existing);
          }
        }

        if (
          existing &&
          existing.server.external === false &&
          resumeSessionId === existing.openCodeSessionId
        ) {
          const requestedDirectoryMatches = yield* sameDirectory(existing.directory, directory);
          const isCurrentContext = () =>
            Effect.gen(function* () {
              return (
                sessions.get(input.threadId) === existing &&
                !(yield* Ref.get(existing.stopped)) &&
                !existing.quarantined
              );
            });

          if (requestedDirectoryMatches && (yield* isCurrentContext())) {
            const previousRuntimeMode = existing.session.runtimeMode;
            const pendingReplacement: OpenCodeManagedReplacementSnapshot = {
              token: ++nextInPlaceReplacementToken,
              context: existing,
              previousRuntimeMode,
              previousModel: existing.session.model,
              previousManagedMcpConfig: undefined,
              managedMcpConfigWasRead: false,
              permissionsUpdated: false,
              mcpConfigurationChanged: false,
              provisionalSession: undefined,
            } satisfies OpenCodeManagedReplacementSnapshot;
            pendingInPlaceReplacementsByContext.set(existing, pendingReplacement);
            let permissionsUpdated = false;
            const restorePermissions = Effect.gen(function* () {
              if (!permissionsUpdated || !(yield* isCurrentContext())) {
                return;
              }
              yield* runOpenCodeSdk("session.update", () =>
                existing.client.session.update({
                  sessionID: existing.openCodeSessionId,
                  permission: buildOpenCodePermissionRules(previousRuntimeMode),
                }),
              ).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("OpenCode permission rollback failed", { cause }),
                ),
                Effect.asVoid,
              );
            });
            const inPlaceResult = yield* Effect.gen(function* () {
              yield* runOpenCodeSdk("session.update", () =>
                existing.client.session.update({
                  sessionID: existing.openCodeSessionId,
                  permission: buildOpenCodePermissionRules(input.runtimeMode),
                }),
              ).pipe(Effect.mapError(toRequestError));
              permissionsUpdated = true;
              pendingReplacement.permissionsUpdated = true;
              if (!(yield* isCurrentContext())) {
                return undefined;
              }

              const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
              const mcpReplacement = McpProviderSession.readMcpProviderSessionReplacement(
                input.threadId,
              );
              if (mcpSession) {
                const currentConfig = yield* runOpenCodeSdk("config.get", () =>
                  existing.client.config.get(),
                ).pipe(Effect.mapError(toRequestError));
                previousManagedMcpConfig = currentConfig.data?.mcp?.["t3-code"];
                managedMcpConfigWasRead = true;
                pendingReplacement.previousManagedMcpConfig = previousManagedMcpConfig;
                pendingReplacement.managedMcpConfigWasRead = true;
                if (!(yield* isCurrentContext())) {
                  return undefined;
                }
                yield* runOpenCodeSdk("mcp.add", () =>
                  existing.client.mcp.add({
                    name: "t3-code",
                    config: openCodeMcpConfig(mcpSession),
                  }),
                ).pipe(Effect.mapError(toRequestError));
                pendingReplacement.mcpConfigurationChanged = true;
                if (!(yield* isCurrentContext())) {
                  return undefined;
                }
              } else if (
                mcpReplacement?.accessWasDisabled &&
                mcpReplacement.previous !== undefined
              ) {
                const currentConfig = yield* runOpenCodeSdk("config.get", () =>
                  existing.client.config.get(),
                ).pipe(Effect.mapError(toRequestError));
                previousManagedMcpConfig = currentConfig.data?.mcp?.["t3-code"];
                managedMcpConfigWasRead = true;
                pendingReplacement.previousManagedMcpConfig = previousManagedMcpConfig;
                pendingReplacement.managedMcpConfigWasRead = true;
                yield* runOpenCodeSdk("mcp.disconnect", () =>
                  existing.client.mcp.disconnect({ name: "t3-code" }),
                ).pipe(Effect.mapError(toRequestError));
                pendingReplacement.mcpConfigurationChanged = true;
                if (!(yield* isCurrentContext())) {
                  return undefined;
                }
              }

              const session = yield* updateProviderSession(existing, {
                runtimeMode: input.runtimeMode,
                ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
              });
              if (!(yield* isCurrentContext())) {
                return undefined;
              }
              if (input.recovery !== undefined) {
                yield* schedulePendingRequestRecovery(existing, { maxRetries: 3 });
              }
              return session;
            }).pipe(
              Effect.onError(() =>
                Effect.gen(function* () {
                  yield* restoreMcpConfiguration(existing.client, existing.server);
                  yield* restorePermissions;
                  removePendingInPlaceReplacement(pendingReplacement);
                }),
              ),
            );

            if (inPlaceResult !== undefined) {
              pendingReplacement.provisionalSession = inPlaceResult;
              pendingInPlaceReplacementsBySession.set(inPlaceResult, pendingReplacement);
              return inPlaceResult;
            }

            removePendingInPlaceReplacement(pendingReplacement);
            yield* restoreMcpConfiguration(existing.client, existing.server);
            const winner = sessions.get(input.threadId);
            if (winner && winner !== existing && !(yield* Ref.get(winner.stopped))) {
              return (yield* awaitOpenCodeContextReady(winner)).session;
            }
            if (yield* isCurrentContext()) {
              return existing.session;
            }
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
        }

        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          const startedExit = yield* Effect.exit(
            Effect.gen(function* () {
              // The runtime binds the server's lifetime to the Scope.Scope
              // we provide below — closing `sessionScope` kills the child
              // process automatically. No manual `server.close()` needed.
              const server = yield* openCodeRuntime.connectToOpenCodeServer({
                binaryPath,
                directory,
                serverUrl,
                ...(serverPassword ? { serverPassword } : {}),
                ...(options?.environment ? { environment: options.environment } : {}),
              });
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory,
                ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
              });
              let externalMcp: OpenCodeExternalMcpState | undefined;
              if (server.external && openCodeSettings.manageExternalMcp && hasExternalMcpWork) {
                if (externalMcpCoordinator === undefined || externalEnvironmentId === undefined) {
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "startSession",
                    detail:
                      "External OpenCode MCP management is not available because the server environment is not configured.",
                  });
                }
                const target = {
                  serverUrl: validateExternalOpenCodeUrl(server.url),
                  directory,
                };
                const lease = yield* externalMcpCoordinator
                  .acquire({
                    target,
                    environmentId: externalEnvironmentId,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                  })
                  .pipe(
                    Effect.mapError((cause) => toExternalMcpRequestError("mcp.acquire", cause)),
                  );
                externalMcp = {
                  lease,
                  client,
                  directory,
                  attemptedNames: new Set(),
                  cleanupDone: Deferred.makeUnsafe(),
                  cleanupStarted: false,
                };
                externalMcpStates.set(input.threadId, externalMcp);
                yield* registerExternalMcp(externalMcp, mcpSession, input.projectMcpServers ?? []);
              }
              if (mcpSession && !server.external) {
                const currentConfig = yield* runOpenCodeSdk("config.get", () =>
                  client.config.get(),
                );
                previousManagedMcpConfig = currentConfig.data?.mcp?.["t3-code"];
                managedMcpConfigWasRead = true;
                yield* runOpenCodeSdk("mcp.add", () =>
                  client.mcp.add({ name: "t3-code", config: openCodeMcpConfig(mcpSession) }),
                );
              }
              if (
                server.external &&
                !openCodeSettings.manageExternalMcp &&
                (input.projectMcpServers?.length ?? 0) > 0
              ) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "startSession",
                  issue:
                    "T3 cannot configure project MCP servers on externally managed OpenCode servers.",
                });
              }
              if (!server.external) {
                yield* Effect.forEach(input.projectMcpServers ?? [], (projectMcpServer) =>
                  runOpenCodeSdk("mcp.add", () =>
                    client.mcp.add({
                      name: projectMcpNativeKey(projectMcpServer),
                      config: {
                        type: "remote",
                        url: projectMcpServer.endpoint.toString(),
                        headers: {
                          Authorization: projectMcpServer.authorizationHeader,
                        },
                        oauth: false,
                      },
                    }),
                  ),
                );
              }
              // Resume: re-adopt the session named by the durable cursor —
              // OpenCode scopes history by session id. The probe recovers only
              // a confirmed not-found (start fresh); transport/auth/server
              // errors propagate instead of masking as a new empty session.
              const resolved = yield* Effect.gen(function* () {
                const adopted = resumeSessionId
                  ? yield* runOpenCodeSdk("session.get", () =>
                      client.session.get({ sessionID: resumeSessionId }),
                    ).pipe(
                      Effect.map((response) => response.data),
                      Effect.catchIf(
                        (cause) => isOpenCodeNotFound(cause),
                        () => Effect.void,
                      ),
                    )
                  : undefined;

                // Reuse in place only when the session still matches the
                // requested cwd; on a cwd change it is forked below instead.
                const reusable =
                  adopted &&
                  (!adopted.directory || (yield* sameDirectory(adopted.directory, directory)))
                    ? adopted
                    : undefined;

                if (reusable) {
                  // Resume skips `session.create`. External sessions defer
                  // the permission reassertion until the event stream proves
                  // this candidate is ready to win the handoff.
                  return {
                    openCodeSession: reusable,
                    created: false,
                    adopted: true,
                    permissionReassertionRequired: true,
                  };
                }

                if (input.recovery) {
                  if (adopted) {
                    return yield* new OpenCodeRuntimeError({
                      operation: "session.get",
                      detail:
                        "OpenCode recovery cannot reattach a turn after the session working directory changed.",
                    });
                  }
                  return yield* new OpenCodeRuntimeError({
                    operation: "session.get",
                    detail: `Upstream OpenCode session '${resumeSessionId ?? "unknown"}' no longer exists after restart.`,
                  });
                }

                // The session lives under a different cwd (e.g. the thread
                // moved into a git worktree). Fork it into the requested
                // directory instead of minting an empty one — the fork carries
                // the full history, so the follow-up keeps its context (#3604).
                if (adopted) {
                  yield* Effect.logInfo(
                    `OpenCode session '${adopted.id}' was created under a different working directory; forking into '${directory}' to preserve conversation history.`,
                  );
                  const forkedSession = yield* runOpenCodeSdk("session.fork", () =>
                    client.session.fork({ sessionID: adopted.id, directory }),
                  );
                  const forked = forkedSession.data;
                  if (!forked) {
                    return yield* new OpenCodeRuntimeError({
                      operation: "session.fork",
                      detail: "OpenCode session.fork returned no session payload.",
                    });
                  }
                  yield* runOpenCodeSdk("session.update", () =>
                    client.session.update({
                      sessionID: forked.id,
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                    }),
                  );
                  return {
                    openCodeSession: forked,
                    created: true,
                    adopted: false,
                    permissionReassertionRequired: false,
                  };
                }

                if (resumeSessionId) {
                  yield* Effect.logWarning(
                    `OpenCode session '${resumeSessionId}' no longer exists; starting a fresh session.`,
                  );
                }
                const createdSession = yield* runOpenCodeSdk("session.create", () =>
                  client.session.create({
                    ...(input.title ? { title: input.title } : {}),
                    permission: buildOpenCodePermissionRules(input.runtimeMode),
                  }),
                );
                if (!createdSession.data) {
                  return yield* new OpenCodeRuntimeError({
                    operation: "session.create",
                    detail: "OpenCode session.create returned no session payload.",
                  });
                }
                return {
                  openCodeSession: createdSession.data,
                  created: true,
                  adopted: false,
                  permissionReassertionRequired: false,
                };
              }).pipe(Effect.onError(() => restoreMcpConfiguration(client, server)));

              return {
                sessionScope,
                server,
                client,
                externalMcp,
                openCodeSession: resolved.openCodeSession,
                created: resolved.created,
                adopted: resolved.adopted,
                permissionReassertionRequired: resolved.permissionReassertionRequired,
              };
            }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
          );
          if (Exit.isFailure(startedExit)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            return yield* toProcessError(input.threadId, Cause.squash(startedExit.cause));
          }
          return startedExit.value;
        });

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          // ProviderService persists this cursor and feeds it back into
          // `startSession` after the in-memory session is lost (reaper /
          // restart), so follow-ups continue the same conversation (#3604).
          resumeCursor: {
            schemaVersion: OPENCODE_RESUME_VERSION,
            sessionId: started.openCodeSession.id,
          },
          ...(started.adopted && input.recovery ? { activeTurnId: input.recovery.turnId } : {}),
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCodeSessionContext = {
          session,
          client: started.client,
          server: started.server,
          directory,
          openCodeSessionId: started.openCodeSession.id,
          relatedSessionIds: new Set([started.openCodeSession.id]),
          resolvedRequestIds: new Set(),
          emittedTerminalRequestIds: new Set(),
          requestRelationRetries: new Map(),
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          partById: new Map(),
          subtaskPartById: new Map(),
          tasksBySessionId: new Map(),
          taskSessionByToolCallId: new Map(),
          pendingTextDeltasByPartId: new Map(),
          emittedTextByPartId: new Map(),
          toolStatusByCallId: new Map(),
          messageRoleById: new Map(),
          completedAssistantPartIds: new Set(),
          turns: [],
          activeTurnId: started.adopted ? input.recovery?.turnId : undefined,
          recovery: started.adopted ? input.recovery : undefined,
          activeAgent: undefined,
          activeVariant: undefined,
          lastTokenUsageSignature: undefined,
          cancellation: undefined,
          interruptedTurnId: undefined,
          reconcileIdleStatus: false,
          reconcileRecoveredHistory: false,
          awaitingBusyAfterInterruption: false,
          pendingIdleReconciliation: undefined,
          pendingRequestRecovery: undefined,
          recoveryReconciliationDeferred: false,
          promptGeneration: 0,
          promptAdmission: undefined,
          unpublished: true,
          closingIntent: undefined,
          quarantined: false,
          promptSemaphore: Semaphore.makeUnsafe(1),
          firstConnection: Deferred.makeUnsafe<void, ProviderAdapterRequestError>(),
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
        };
        if (context.recovery !== undefined) {
          yield* rehydrateOpenCodeContext(context).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("OpenCode session history rehydration failed", {
                cause: openCodeRuntimeErrorDetail(Cause.squash(cause)),
              }),
            ),
          );
        }
        const restoreMcpConfigurationForContext = restoreMcpConfiguration(
          context.client,
          context.server,
        );
        const cleanupStartingContext = closeStartingOpenCodeContext(
          context,
          started.created ? "terminate" : "detach",
          settlePendingOpenCodeRequests,
          restoreMcpConfigurationForContext,
        ).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (started.externalMcp !== undefined) {
                yield* cleanupExternalMcpState(started.externalMcp);
              }
              yield* Effect.sync(() => deleteContextIfCurrent(context));
            }),
          ),
        );
        if (existing === undefined) {
          sessions.set(input.threadId, context);
        }
        const connectionExit = yield* Effect.gen(function* () {
          yield* startEventPump(context);
          yield* Deferred.await(context.firstConnection).pipe(
            Effect.timeout("10 seconds"),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "event.subscribe",
                  detail: "OpenCode event stream did not connect within 10 seconds.",
                  cause,
                }),
            ),
          );
        }).pipe(
          Effect.onInterrupt(() => cleanupStartingContext),
          Effect.exit,
        );
        if (Exit.isFailure(connectionExit)) {
          yield* cleanupStartingContext;
          return yield* Effect.failCause(connectionExit.cause);
        }

        const raceWinner = sessions.get(input.threadId);
        if (raceWinner && raceWinner !== existing && raceWinner !== context) {
          // Another start published while this candidate was connecting. A
          // newly created remote session belongs to this loser; a resumed
          // session is shared upstream state.
          yield* cleanupStartingContext;
          return (yield* awaitOpenCodeContextReady(raceWinner)).session;
        }

        if (started.permissionReassertionRequired) {
          const currentOwner = sessions.get(input.threadId);
          const candidateStopped = yield* Ref.get(context.stopped);
          const existingStopped = existing ? yield* Ref.get(existing.stopped) : false;
          const canReassertPermissions =
            (!candidateStopped && existing === undefined && currentOwner === context) ||
            (!candidateStopped &&
              existing !== undefined &&
              existing.server.external &&
              isSameOpenCodeUpstreamSession(existing, context) &&
              ((currentOwner === existing && !existingStopped) ||
                (currentOwner === undefined && existingStopped)));

          if (!canReassertPermissions) {
            yield* cleanupStartingContext;
            const winner = sessions.get(input.threadId);
            if (winner && winner !== context) {
              return (yield* awaitOpenCodeContextReady(winner)).session;
            }
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }

          yield* runOpenCodeSdk("session.update", () =>
            context.client.session.update({
              sessionID: context.openCodeSessionId,
              permission: buildOpenCodePermissionRules(input.runtimeMode),
            }),
          ).pipe(
            Effect.mapError(toRequestError),
            Effect.onError(() => cleanupStartingContext.pipe(Effect.ignoreCause)),
          );
        }

        if (yield* Ref.get(context.stopped)) {
          yield* cleanupStartingContext;
          const winner = sessions.get(input.threadId);
          if (winner && winner !== context) {
            return (yield* awaitOpenCodeContextReady(winner)).session;
          }
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }

        const handoffWinner = sessions.get(input.threadId);
        if (existing === undefined && handoffWinner !== context) {
          yield* cleanupStartingContext;
          if (handoffWinner) {
            return (yield* awaitOpenCodeContextReady(handoffWinner)).session;
          }
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        if (handoffWinner && handoffWinner !== existing && handoffWinner !== context) {
          yield* cleanupStartingContext;
          return (yield* awaitOpenCodeContextReady(handoffWinner)).session;
        }

        if (existing && handoffWinner === existing && !(yield* Ref.get(existing.stopped))) {
          const handoff = isSameOpenCodeUpstreamSession(existing, context)
            ? detachExternalOpenCodeContext(existing)
            : terminateOpenCodeContext(existing);
          const handoffExit = yield* Effect.exit(handoff);
          if (Exit.isFailure(handoffExit)) {
            yield* cleanupStartingContext;
            return yield* Effect.failCause(handoffExit.cause);
          }
        } else if (existing && handoffWinner === existing) {
          deleteContextIfCurrent(existing);
        }

        context.unpublished = false;
        sessions.set(input.threadId, context);
        yield* awaitOpenCodeContextReady(context);
        if (context.recoveryReconciliationDeferred) {
          context.recoveryReconciliationDeferred = false;
          yield* reconcileRecoveredOpenCodeSession(context);
          if (
            (yield* Ref.get(context.stopped)) ||
            sessions.get(context.session.threadId) !== context
          ) {
            yield* restoreMcpConfigurationForContext;
          }
          // Reconciliation can fail the candidate and remove it from the
          // session map. Do not publish lifecycle events for that failed
          // startup.
          yield* awaitOpenCodeContextReady(context);
          if (context.activeTurnId !== undefined) {
            yield* schedulePendingRequestRecovery(context, { maxRetries: 3 });
          }
        }
        if (!started.created && input.recovery === undefined) {
          yield* schedulePendingRequestRecovery(context);
        }

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.openCodeSession.id,
          },
        });

        return context.session;
      },
    );

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = yield* ensureSessionContext(sessions, input.threadId);
      yield* awaitOpenCodeContextReady(context);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OpenCode model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode model selection must use the 'provider/model' format.",
        });
      }

      const text = input.input?.trim();
      // OpenCode ingests images, text, and PDFs natively; formats its model
      // paths reject ride only as the prompt's file path line.
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });
      if ((!text || text.length === 0) && fileParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode turns require text input or at least one attachment.",
        });
      }

      return yield* context.promptSemaphore.withPermit(
        Effect.gen(function* () {
          const freshTurnId = TurnId.make(`opencode-turn-${yield* randomUUIDv4}`);
          const messageId = yield* makeOpenCodeMessageId();
          const pendingCancellation = context.cancellation;
          if (pendingCancellation) {
            const cancellationResult = yield* Deferred.await(pendingCancellation.completion).pipe(
              Effect.result,
            );
            if (
              (yield* Ref.get(context.stopped)) ||
              context.closingIntent !== undefined ||
              sessions.get(input.threadId) !== context
            ) {
              return yield* Effect.interrupt;
            }
            if (cancellationResult._tag === "Failure") {
              return yield* cancellationResult.failure;
            }
          }
          if (
            sessions.get(input.threadId) !== context ||
            (yield* Ref.get(context.stopped)) ||
            context.closingIntent !== undefined
          ) {
            return yield* Effect.interrupt;
          }
          // A sendTurn while a turn is active is a steer. OpenCode queues the
          // prompt into the running session, so the active turn id is reused.
          const steeringTurnId = context.activeTurnId;
          if (steeringTurnId === undefined) {
            context.recovery = undefined;
          }
          const turnId = steeringTurnId ?? freshTurnId;
          const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
          const variant = getModelSelectionStringOptionValue(modelSelection, "variant");
          const pendingIdleReconciliation = context.pendingIdleReconciliation;
          const priorAwaitingBusy = context.awaitingBusyAfterInterruption;
          const priorIdleCandidate = pendingIdleReconciliation
            ? {
                turnId: pendingIdleReconciliation.turnId,
                raw: pendingIdleReconciliation.raw,
              }
            : undefined;
          context.pendingIdleReconciliation = undefined;
          const promptGeneration = context.promptGeneration + 1;
          const nativeCommand = text ? parseOpenCodeCommandInput(text) : undefined;
          const promptAdmission: OpenCodePromptAdmission = {
            generation: promptGeneration,
            turnId,
            messageId,
            nativeCommand: nativeCommand !== undefined,
            priorAwaitingBusy,
            priorIdle: priorIdleCandidate,
            idleDuringAdmission: undefined,
            idleObservedAfterMessage: false,
            // `session.command` has a synchronous lifecycle response instead
            // of prompt_async's enqueue acknowledgement. Its return confirms
            // the command reached OpenCode, even when it creates no user
            // message to observe (for example, /init).
            messageObserved: nativeCommand !== undefined,
            busyObserved: false,
            idleStatusConfirmations: 0,
            accepted: false,
            cancelled: false,
            acceptance: Deferred.makeUnsafe<void, ProviderAdapterRequestError>(),
            submissionSettled: Deferred.makeUnsafe<void>(),
            recoveryRaw: undefined,
          };
          context.promptGeneration = promptGeneration;
          context.promptAdmission = promptAdmission;
          context.reconcileRecoveredHistory = false;

          context.activeTurnId = turnId;
          context.activeAgent = agent ?? (input.interactionMode === "plan" ? "plan" : undefined);
          context.activeVariant = variant;
          if (steeringTurnId === undefined) {
            context.awaitingBusyAfterInterruption = context.interruptedTurnId !== undefined;
          }
          if (pendingIdleReconciliation?.fiber) {
            yield* Fiber.interrupt(pendingIdleReconciliation.fiber);
          }
          yield* updateProviderSession(
            context,
            {
              status: "running",
              activeTurnId: turnId,
              model: modelSelection?.model ?? context.session.model,
            },
            { clearLastError: true },
          );

          if (steeringTurnId === undefined) {
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "turn.started",
              payload: {
                model: modelSelection?.model ?? context.session.model,
                ...(variant ? { effort: variant } : {}),
              },
            });
          }

          if (promptAdmission.cancelled || (yield* Ref.get(context.stopped))) {
            yield* Deferred.succeed(promptAdmission.submissionSettled, undefined).pipe(
              Effect.ignore,
            );
            const cancellation = context.cancellation;
            if (cancellation?.turnId === turnId) {
              yield* Deferred.await(cancellation.completion).pipe(Effect.result);
            }
            return yield* Effect.interrupt;
          }

          let promptTimedOut = false;
          const submitPrompt = runOpenCodeSdk(
            nativeCommand ? "session.command" : "session.promptAsync",
            async (signal) => {
              if (nativeCommand) {
                await context.client.session.command(
                  {
                    sessionID: context.openCodeSessionId,
                    messageID: messageId,
                    command: nativeCommand.command,
                    arguments: nativeCommand.arguments ?? "",
                    model: `${parsedModel.providerID}/${parsedModel.modelID}`,
                    ...(context.activeAgent ? { agent: context.activeAgent } : {}),
                    ...(context.activeVariant ? { variant: context.activeVariant } : {}),
                    parts: fileParts,
                  },
                  { signal },
                );
                return;
              }
              await context.client.session.promptAsync(
                {
                  sessionID: context.openCodeSessionId,
                  messageID: messageId,
                  model: parsedModel,
                  ...(context.activeAgent ? { agent: context.activeAgent } : {}),
                  ...(context.activeVariant ? { variant: context.activeVariant } : {}),
                  parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
                },
                { signal },
              );
            },
          );
          // `prompt_async` is an acknowledgement endpoint, while a native
          // command can stay open while its command is waiting for user input.
          // Timing out the latter locally detaches OpenCode's eventual
          // question from its still-running turn and makes Stop target stale
          // session state.
          const promptEffect = (
            nativeCommand
              ? submitPrompt.pipe(
                  Effect.catchTags({
                    OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
                  }),
                )
              : submitPrompt.pipe(
                  Effect.timeout("10 seconds"),
                  Effect.catchTags({
                    OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
                    TimeoutError: (cause) => {
                      promptTimedOut = true;
                      return Effect.fail(
                        new ProviderAdapterRequestError({
                          provider: PROVIDER,
                          method: "session.promptAsync",
                          detail: "OpenCode prompt submission did not complete within 10 seconds.",
                          cause,
                        }),
                      );
                    },
                  }),
                )
          ).pipe(
            Effect.tap(() => (nativeCommand ? acceptNativeCommandAdmission(context) : Effect.void)),
            Effect.tapError((requestError) =>
              context.promptAdmission !== promptAdmission || context.activeTurnId !== turnId
                ? Effect.void
                : Effect.gen(function* () {
                    // A native command can produce an OpenCode lifecycle event
                    // while its synchronous HTTP request is still open. Once
                    // that event admitted the turn, a later client-side fetch
                    // timeout is not a command failure and must not abort it.
                    if (nativeCommand && promptAdmission.accepted) {
                      return;
                    }
                    yield* Deferred.fail(promptAdmission.acceptance, requestError).pipe(
                      Effect.ignore,
                    );
                    if (!promptTimedOut) {
                      if (steeringTurnId !== undefined) {
                        context.promptAdmission = undefined;
                        context.awaitingBusyAfterInterruption = promptAdmission.priorAwaitingBusy;
                        const idle =
                          promptAdmission.idleDuringAdmission ?? promptAdmission.priorIdle;
                        if (idle) {
                          yield* scheduleIdleReconciliation(context, idle.turnId, idle.raw);
                        }
                        return;
                      }
                      context.promptAdmission = undefined;
                      context.activeTurnId = undefined;
                      context.activeAgent = undefined;
                      context.activeVariant = undefined;
                      yield* updateProviderSession(
                        context,
                        {
                          status: "ready",
                          model: modelSelection?.model ?? context.session.model,
                          lastError: requestError.detail,
                        },
                        { clearActiveTurnId: true },
                      );
                      yield* emit({
                        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                        type: "turn.aborted",
                        payload: { reason: requestError.detail },
                      });
                      return;
                    }
                    const cleanupExit = yield* Effect.exit(
                      runOpenCodeSdk("session.abort", (signal) =>
                        context.client.session.abort(
                          { sessionID: context.openCodeSessionId },
                          { signal },
                        ),
                      ).pipe(Effect.timeout("1 second")),
                    );
                    if (Exit.isFailure(cleanupExit)) {
                      yield* emit({
                        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                        type: "runtime.warning",
                        payload: {
                          message:
                            "OpenCode prompt submission failed and its cleanup abort did not complete.",
                          detail: openCodeRuntimeErrorDetail(Cause.squash(cleanupExit.cause)),
                        },
                      });
                      yield* schedulePromptAdmissionRecovery(context, {
                        requestError,
                        cleanupError: Cause.squash(cleanupExit.cause),
                      });
                      return;
                    }
                    context.promptAdmission = undefined;
                    context.activeTurnId = undefined;
                    context.activeAgent = undefined;
                    context.activeVariant = undefined;
                    context.awaitingBusyAfterInterruption = false;
                    context.reconcileIdleStatus = false;
                    yield* updateProviderSession(
                      context,
                      {
                        status: "ready",
                        model: modelSelection?.model ?? context.session.model,
                        lastError: requestError.detail,
                      },
                      { clearActiveTurnId: true },
                    );
                    yield* emit({
                      ...(yield* buildEventBase({
                        threadId: input.threadId,
                        turnId,
                      })),
                      type: "turn.aborted",
                      payload: {
                        reason: requestError.detail,
                      },
                    });
                  }),
            ),
            Effect.catchIf(
              () => nativeCommand !== undefined && promptAdmission.accepted,
              () => Effect.void,
            ),
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(promptAdmission.submissionSettled, undefined).pipe(
                  Effect.ignore,
                );
                if (Exit.isFailure(exit)) {
                  yield* Deferred.succeed(promptAdmission.acceptance, undefined).pipe(
                    Effect.ignore,
                  );
                }
              }),
            ),
            Effect.asVoid,
          );
          const promptFiber = yield* promptEffect.pipe(Effect.forkIn(context.sessionScope));
          promptAdmission.promptFiber = promptFiber;
          const promptExit = nativeCommand
            ? yield* Effect.exit(Deferred.await(promptAdmission.acceptance))
            : yield* Effect.exit(Fiber.join(promptFiber));
          if (!nativeCommand) {
            delete promptAdmission.promptFiber;
          }

          const intentionallyCancelled =
            promptAdmission.cancelled ||
            (yield* Ref.get(context.stopped)) ||
            sessions.get(input.threadId) !== context;
          if (Exit.isFailure(promptExit) && !intentionallyCancelled) {
            return yield* Effect.failCause(promptExit.cause);
          }
          const cancelled =
            intentionallyCancelled ||
            context.activeTurnId !== turnId ||
            context.promptGeneration !== promptAdmission.generation;
          if (cancelled) {
            const cancellation = context.cancellation;
            if (cancellation?.turnId === turnId) {
              yield* Deferred.await(cancellation.completion).pipe(Effect.result);
            }
            if (context.promptAdmission === promptAdmission) {
              context.promptAdmission = undefined;
            }
            return yield* Effect.interrupt;
          }
          promptAdmission.accepted = true;
          yield* Deferred.succeed(promptAdmission.acceptance, undefined).pipe(Effect.ignore);
          if (promptAdmission.nativeCommand) {
            // Native commands do not use prompt_async's acknowledgement
            // lifecycle. Retain the admission until a status reconciliation
            // observes their actual completion; a question can otherwise
            // consume the sole idle event and strand the turn forever.
            yield* schedulePromptAdmissionRecovery(context, promptAdmission.recoveryRaw);
          } else if (
            context.promptAdmission === promptAdmission &&
            context.activeTurnId === turnId &&
            context.promptGeneration === promptAdmission.generation &&
            promptAdmission.messageObserved
          ) {
            context.awaitingBusyAfterInterruption = false;
            const idle = promptAdmission.idleDuringAdmission;
            if (idle && !promptAdmission.idleObservedAfterMessage) {
              yield* schedulePromptAdmissionRecovery(context, idle.raw);
            } else {
              context.promptAdmission = undefined;
            }
            if (idle && promptAdmission.idleObservedAfterMessage) {
              yield* scheduleIdleReconciliation(context, turnId, idle.raw);
            }
          } else {
            yield* schedulePromptAdmissionRecovery(context, promptAdmission.recoveryRaw);
          }

          const stopped = yield* Ref.get(context.stopped);
          const finalCancellation = context.cancellation;
          if (
            stopped ||
            sessions.get(input.threadId) !== context ||
            promptAdmission.cancelled ||
            context.activeTurnId !== turnId ||
            context.promptGeneration !== promptAdmission.generation ||
            finalCancellation?.turnId === turnId
          ) {
            if (finalCancellation?.turnId === turnId) {
              yield* Deferred.await(finalCancellation.completion).pipe(Effect.result);
            }
            if (context.promptAdmission === promptAdmission) {
              context.promptAdmission = undefined;
            }
            return yield* Effect.interrupt;
          }

          return {
            threadId: input.threadId,
            turnId,
            // Re-surface the durable cursor on every turn so the persisted binding
            // is refreshed alongside last-seen/runtime state (mirrors Grok/Codex).
            ...(context.session.resumeCursor !== undefined
              ? { resumeCursor: context.session.resumeCursor }
              : {}),
          };
        }),
      );
    });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const activeTurnId = context.activeTurnId;
        if (turnId !== undefined && activeTurnId !== turnId) {
          return;
        }
        const interruptedTurnId = turnId ?? activeTurnId;
        yield* cancelIdleReconciliation(context);
        if (interruptedTurnId && context.interruptedTurnId === interruptedTurnId) {
          return;
        }
        const existingCancellation = context.cancellation;
        if (
          existingCancellation !== undefined &&
          existingCancellation.turnId === interruptedTurnId
        ) {
          return yield* Deferred.await(existingCancellation.completion);
        }
        const cancellation: OpenCodeCancellation = {
          turnId: interruptedTurnId,
          completion: Deferred.makeUnsafe<void, ProviderAdapterRequestError>(),
        };
        context.cancellation = cancellation;
        const promptAdmission = context.promptAdmission;
        if (promptAdmission !== undefined && promptAdmission.turnId === interruptedTurnId) {
          promptAdmission.cancelled = true;
          if (promptAdmission.promptFiber) {
            yield* Fiber.interrupt(promptAdmission.promptFiber);
          }
          yield* Deferred.await(promptAdmission.submissionSettled);
        }

        const abortExit = yield* Effect.exit(abortAndConfirmOpenCodeTurn(context, cancellation));
        if (Exit.isFailure(abortExit)) {
          if (context.cancellation === cancellation) {
            context.cancellation = undefined;
          }
          yield* Deferred.done(cancellation.completion, abortExit).pipe(Effect.ignore);
          return yield* Effect.failCause(abortExit.cause);
        }
        yield* Deferred.succeed(cancellation.completion, undefined).pipe(Effect.ignore);
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = yield* ensureSessionContext(sessions, threadId);
      if (!context.pendingPermissions.has(requestId)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("permission.reply", () =>
        context.client.permission.reply({
          requestID: requestId,
          reply: toOpenCodePermissionReply(decision),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = yield* ensureSessionContext(sessions, threadId);
      const request = context.pendingQuestions.get(requestId);
      if (!request) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "question.reply",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("question.reply", () =>
        context.client.question.reply({
          requestID: requestId,
          answers: toOpenCodeQuestionAnswers(request, answers),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const terminateOpenCodeContext = Effect.fn("terminateOpenCodeContext")(function* (
      context: OpenCodeSessionContext,
    ) {
      context.closingIntent = "terminate";
      if (context.quarantined) {
        const closeExit = yield* Effect.exit(
          closeOpenCodeContext(context, "terminate", settlePendingOpenCodeRequests),
        );
        if (Exit.isFailure(closeExit)) {
          context.closingIntent = undefined;
          return yield* Effect.failCause(closeExit.cause);
        }
        deleteContextIfCurrent(context);
        return closeExit.value;
      }
      const activeTurnId = context.activeTurnId;
      const interruptExit =
        activeTurnId === undefined
          ? Exit.succeed(undefined)
          : yield* Effect.exit(interruptTurn(context.session.threadId, activeTurnId));
      if (Exit.isFailure(interruptExit)) {
        context.closingIntent = undefined;
        return yield* Effect.failCause(interruptExit.cause);
      }

      const closeExit = yield* Effect.exit(
        closeOpenCodeContext(context, "terminate", settlePendingOpenCodeRequests, {
          remoteTerminationConfirmed: activeTurnId !== undefined,
        }),
      );
      if (Exit.isFailure(closeExit)) {
        context.closingIntent = undefined;
        return yield* Effect.failCause(closeExit.cause);
      }
      deleteContextIfCurrent(context);
      return closeExit.value;
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const stopped = yield* terminateOpenCodeContext(context);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
      },
    );

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((context) => !context.quarantined)
          .map((context) => context.session),
      );

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.quarantined;
      });

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const turns: Array<OpenCodeTurnSnapshot> = [];
        for (const entry of messages.data ?? []) {
          if (entry.info.role === "assistant") {
            turns.push({
              id: TurnId.make(entry.info.id),
              items: [entry.info, ...entry.parts],
            });
          }
        }

        return {
          threadId,
          turns,
        };
      },
    );

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const assistantMessages = (messages.data ?? []).filter(
          (entry) => entry.info.role === "assistant",
        );
        const targetIndex = assistantMessages.length - numTurns - 1;
        const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null;
        yield* runOpenCodeSdk("session.revert", () =>
          context.client.session.revert({
            sessionID: context.openCodeSessionId,
            ...(target ? { messageID: target.info.id } : {}),
          }),
        ).pipe(Effect.mapError(toRequestError));

        return yield* readThread(threadId);
      },
    );

    const stopAll: OpenCodeAdapterShape["stopAll"] = () => closeAllSessions;

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        remoteHttpMcp:
          openCodeSettings.serverUrl && !openCodeSettings.manageExternalMcp
            ? "unsupported"
            : "next-session",
        projectMcpProxy:
          openCodeSettings.serverUrl && !openCodeSettings.manageExternalMcp
            ? "unsupported"
            : "next-session",
        sessionMcpCatalog:
          openCodeSettings.serverUrl && !openCodeSettings.manageExternalMcp
            ? "unsupported"
            : "restart-required",
        ...(openCodeSettings.serverUrl && !openCodeSettings.manageExternalMcp
          ? {
              projectMcpUnsupportedReason:
                "T3 cannot configure externally managed OpenCode servers.",
            }
          : {}),
        managedPreviewMcp:
          openCodeSettings.serverUrl && !openCodeSettings.manageExternalMcp
            ? "unsupported"
            : "next-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      settleStartedSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      cleanupSessionMcp: cleanupExternalMcpForThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
