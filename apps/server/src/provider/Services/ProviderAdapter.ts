/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderUserInputResolution,
  ProviderUserInputResponseResult,
  ProviderApprovalResponseResult,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  RuntimeAgentKey,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@t3tools/contracts";
import type { McpIssuedProjectServer } from "../../mcp/McpProviderSession.ts";
import type { ProviderSkillPlan } from "../../skills/ProviderSkillAdapter.ts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProjectWorkRuntimeContext } from "../RuntimeInstructions.ts";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";
export type ProviderRemoteHttpMcpMode = "active-session" | "next-session" | "unsupported";
export type ProviderSessionMcpCatalogMode = "live" | "restart-required" | "unsupported";

export type ProviderAdapterSessionStartInput = ProviderSessionStartInput & {
  /** T3-issued proxy records only; upstream transport details stay server-side. */
  readonly projectMcpServers?: ReadonlyArray<McpIssuedProjectServer>;
  /** Bounded durable project-work context prepared by ProviderService. */
  readonly projectWork?: ProjectWorkRuntimeContext;
  /** Opaque to orchestration; only the selected provider may decode this session-local plan. */
  readonly skillPlan?: ProviderSkillPlan;
};

const encodeProjectMcpId = (id: Pick<McpIssuedProjectServer, "id">["id"]): string =>
  Array.from(String(id), (character) =>
    /^[A-Za-z0-9-]$/.test(character)
      ? character
      : `_${character.codePointAt(0)?.toString(16).toUpperCase() ?? "00"}_`,
  ).join("");

export const projectMcpNativeKey = (server: Pick<McpIssuedProjectServer, "id">): string =>
  `t3-project-${encodeProjectMcpId(server.id)}`;

export const projectMcpTokenEnvironmentKey = (server: Pick<McpIssuedProjectServer, "id">): string =>
  `T3_PROJECT_MCP_${encodeProjectMcpId(server.id).replaceAll("-", "_")}`;

/**
 * How ProviderService runs manual context compaction for an adapter.
 * Native adapters expose a start call and must emit a compacted thread state
 * when they finish. Slash-command adapters get the command sent as a turn.
 */
export type ProviderCompaction<TError> =
  | {
      readonly type: "native";
      readonly start: (
        threadId: ThreadId,
        modelSelection?: ProviderSendTurnInput["modelSelection"],
      ) => Effect.Effect<void, TError>;
    }
  | { readonly type: "slash-command"; readonly command: `/${string}` };

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  readonly remoteHttpMcp?: ProviderRemoteHttpMcpMode;
  readonly projectMcpProxy?: ProviderRemoteHttpMcpMode;
  readonly projectMcpUnsupportedReason?: string;
  readonly managedPreviewMcp?: ProviderRemoteHttpMcpMode;
  readonly sessionMcpCatalog?: ProviderSessionMcpCatalogMode;
  /** Starts a resumed turn with no synthetic user prompt. Omitted means the
      adapter needs an explicit continuation instruction. */
  readonly promptlessTurnContinuation?: boolean;
  /** Safe delivery into a running turn. Omitted means busy turns must be queued. */
  readonly activeTurnSteer?: boolean;
  /** False when native conversation history cannot be rewound. */
  readonly supportsConversationRollback?: boolean;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

/** One native child message/block ready for durable transcript projection. */
export interface ProviderAgentTranscriptItem {
  readonly nativeEntryId: string;
  readonly providerOrderKey: string;
  readonly createdAt: string;
  readonly role: "assistant" | "user" | "tool";
  readonly content: string;
  readonly status: "running" | "completed";
}

/** Bounded native-source page. Cursor ownership stays inside its provider adapter. */
export interface ProviderAgentTranscriptPage {
  readonly entries: ReadonlyArray<ProviderAgentTranscriptItem>;
  readonly nextSourceCursor?: string;
  readonly hasMore: boolean;
  readonly completeness: "complete" | "partial";
  readonly reason?: string;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderAdapterSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /** Send directly to one live, adapter-owned child session when supported. */
  readonly messageAgent?: (
    threadId: ThreadId,
    agentKey: RuntimeAgentKey,
    text: string,
  ) => Effect.Effect<"accepted" | "unknown", TError>;

  /** Stop only one live, adapter-owned child session when supported. */
  readonly stopAgent?: (
    threadId: ThreadId,
    agentKey: RuntimeAgentKey,
  ) => Effect.Effect<"completed" | "unknown", TError>;

  /** Validate the current session-generation-bound child control path. */
  readonly getAgentActionCapabilities?: (
    threadId: ThreadId,
    agentKey: RuntimeAgentKey,
  ) => Effect.Effect<
    {
      readonly message: "supported" | "unsupported" | "unverified";
      readonly answerRequests: "supported" | "unsupported" | "unverified";
      readonly stop: "supported" | "unsupported" | "unverified";
    },
    TError
  >;

  /** Read one bounded page from this provider's native child transcript. */
  readonly readAgentTranscriptPage?: (
    threadId: ThreadId,
    agentKey: RuntimeAgentKey,
    sourceCursor: string | undefined,
    limit: number,
  ) => Effect.Effect<ProviderAgentTranscriptPage, TError>;

  /** Omitted when this adapter does not support manual context compaction. */
  readonly compaction?: ProviderCompaction<TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void | ProviderApprovalResponseResult, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /** Resolve a tagged user-input request when the adapter can preserve its semantics. */
  readonly resolveUserInput?: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    resolution: ProviderUserInputResolution,
    attachmentsByQuestionId?: import("@t3tools/contracts").UserInputAttachments,
  ) => Effect.Effect<ProviderUserInputResponseResult, TError>;

  /** Implemented only when the provider has a native question-cancellation operation. */
  readonly cancelUserInput?: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
  ) => Effect.Effect<ProviderUserInputResponseResult, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * Remove MCP entries owned by this adapter before its issued credentials are
   * discarded. Only adapters that configure an external MCP host implement it.
   */
  readonly cleanupSessionMcp?: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;
  /** Clone native conversation history and return a cursor for the independent clone. */
  readonly forkThread?: (threadId: ThreadId) => Effect.Effect<unknown, TError>;

  /**
   * Upload a thread to the provider when the adapter supports feedback.
   */
  readonly uploadFeedback?: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
