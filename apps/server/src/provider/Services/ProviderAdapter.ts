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
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@t3tools/contracts";
import type { McpIssuedProjectServer } from "../../mcp/McpProviderSession.ts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";
export type ProviderRemoteHttpMcpMode = "active-session" | "next-session" | "unsupported";
export type ProviderSessionMcpCatalogMode = "live" | "restart-required" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /** Application timing for user-configured remote HTTP MCP servers. */
  readonly remoteHttpMcp: ProviderRemoteHttpMcpMode;
  /** Application timing for the T3-scoped project MCP proxy. */
  readonly projectMcpProxy?: ProviderRemoteHttpMcpMode;
  /** Human-readable reason when project MCP is unavailable for this adapter. */
  readonly projectMcpUnsupportedReason?: string;
  /** Application timing for the T3-managed preview MCP server. */
  readonly managedPreviewMcp: ProviderRemoteHttpMcpMode;
  /** Whether the resolved user catalog can change in the active session. */
  readonly sessionMcpCatalog?: ProviderSessionMcpCatalogMode;
}

export type ProviderAdapterSessionStartInput = ProviderSessionStartInput & {
  /** T3-issued proxy records only; upstream transport details never cross this seam. */
  readonly projectMcpServers?: ReadonlyArray<McpIssuedProjectServer>;
};

const encodeProjectMcpId = (id: Pick<McpIssuedProjectServer, "id">["id"]): string =>
  Array.from(String(id), (character) =>
    /^[A-Za-z0-9-]$/.test(character)
      ? character
      : `_${character.codePointAt(0)?.toString(16).toUpperCase() ?? "00"}_`,
  ).join("");

export const projectMcpNativeKey = (server: Pick<McpIssuedProjectServer, "id">): string =>
  `t3-project-${encodeProjectMcpId(server.id)}`;

export const projectMcpTokenEnvironmentKey = (
  server: Pick<McpIssuedProjectServer, "id">,
): string => {
  const suffix = Array.from(String(server.id), (character) =>
    /^[A-Za-z0-9]$/.test(character)
      ? character
      : `_${character.codePointAt(0)?.toString(16).toUpperCase() ?? "00"}_`,
  ).join("");
  return `T3_PROJECT_MCP_${suffix}`;
};

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderSessionSettlementInput {
  readonly threadId: ThreadId;
  readonly session: ProviderSession;
  readonly outcome: "commit" | "rollback";
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
   * Settle provider-native mutations made by a successful start after the
   * service decides whether its MCP replacement can commit. Adapters that do
   * not mutate an existing native session can omit this hook.
   */
  readonly settleStartedSession?: (
    input: ProviderSessionSettlementInput,
  ) => Effect.Effect<void, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

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
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * Release provider-owned MCP configuration before the native session stops.
   * Providers that do not manage external MCP servers omit this hook.
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
