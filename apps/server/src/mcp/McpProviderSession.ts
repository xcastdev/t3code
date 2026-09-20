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
  /** Provider-facing aggregate catalog endpoint, when live catalog updates are enabled. */
  readonly catalogEndpoint?: string;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  readonly projectServers?: ReadonlyArray<McpIssuedProjectServer>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
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
