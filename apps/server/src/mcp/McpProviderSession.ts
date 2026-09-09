import type { EnvironmentId, McpServerId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpIssuedProjectServer {
  readonly id: McpServerId;
  readonly name: string;
  readonly endpoint: URL;
  readonly authorizationHeader: string;
}

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly projectServers?: ReadonlyArray<McpIssuedProjectServer>;
}

export interface McpProviderSessionReplacement {
  readonly previous: McpProviderSessionConfig | undefined;
  readonly candidate: McpProviderSessionConfig | undefined;
  readonly accessWasDisabled: boolean;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();
const replacementsByThread = new Map<ThreadId, McpProviderSessionReplacement>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearMcpProviderSessionIf(threadId: ThreadId, providerSessionId: string): void {
  if (sessionsByThread.get(threadId)?.providerSessionId === providerSessionId) {
    sessionsByThread.delete(threadId);
  }
}

export function beginMcpProviderSessionReplacement(
  threadId: ThreadId,
  replacement: McpProviderSessionReplacement,
): void {
  replacementsByThread.set(threadId, replacement);
}

export function readMcpProviderSessionReplacement(
  threadId: ThreadId,
): McpProviderSessionReplacement | undefined {
  return replacementsByThread.get(threadId);
}

export function commitMcpProviderSessionReplacement(threadId: ThreadId): void {
  replacementsByThread.delete(threadId);
}

export function rollbackMcpProviderSessionReplacement(threadId: ThreadId): void {
  const replacement = replacementsByThread.get(threadId);
  if (!replacement) {
    return;
  }
  const current = sessionsByThread.get(threadId);
  const candidateId = replacement.candidate?.providerSessionId;
  if (
    candidateId === undefined ||
    current === undefined ||
    current.providerSessionId === candidateId
  ) {
    if (replacement.accessWasDisabled || replacement.previous === undefined) {
      sessionsByThread.delete(threadId);
    } else {
      sessionsByThread.set(threadId, replacement.previous);
    }
  }
  replacementsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
  replacementsByThread.clear();
}
