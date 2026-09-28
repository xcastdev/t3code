/**
 * TerminalManager - Terminal session orchestration service interface.
 *
 * Owns terminal lifecycle operations, output fanout, and session state
 * transitions for thread-scoped terminals.
 *
 * @module TerminalManager
 */
import {
  DEFAULT_TERMINAL_ID,
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type ResourceMonitorProcessTableEntry,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSummary,
  type TerminalWriteInput,
  type ProjectTerminalCreateInput,
  type ProjectTerminalHandle,
  type ProjectTerminalKillInput,
  type ProjectTerminalResizeInput,
  type ProjectTerminalSummary,
  type ProjectTerminalWriteInput,
  type TerminalReadInput,
  type TerminalReadResult,
  TerminalToolError,
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerConfig from "../config.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../observability/Metrics.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as PtyAdapter from "./PtyAdapter.ts";
import { BoundedTerminalHistory } from "./History.ts";
import { searchTerminalOutput } from "./OutputSearch.ts";
import {
  type ProjectTerminalRuntimeEvent,
  type TerminalOwner,
  type TerminalTarget,
  projectTerminalTarget,
  terminalTargetKey,
  threadTerminalTarget,
} from "./RuntimeTypes.ts";

export {
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
};

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_HISTORY_BYTE_LIMIT = 8 * 1024 * 1024;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const MAX_SUBPROCESS_POLL_INTERVAL_MS = 60_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const MAX_TERMINAL_LABEL_LENGTH = 128;
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

const TerminalReadCursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  projectId: Schema.String,
  terminalId: Schema.String,
  generation: Schema.String,
  mode: Schema.Literals(["stream", "search"]),
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  searchText: Schema.optional(Schema.String),
  ignoreCase: Schema.optional(Schema.Boolean),
});
type TerminalReadCursorPayload = typeof TerminalReadCursorPayload.Type;
const decodeTerminalReadCursorPayload = Schema.decodeUnknownOption(TerminalReadCursorPayload);

const encodeTerminalReadCursor = (payload: TerminalReadCursorPayload): string =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

const decodeTerminalReadCursor = (cursor: string): Option.Option<TerminalReadCursorPayload> => {
  if (cursor.length > 4_096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return Option.none();
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) return Option.none();
    return decodeTerminalReadCursorPayload(JSON.parse(decoded));
  } catch {
    return Option.none();
  }
};

class TerminalSubprocessCheckError extends Schema.TaggedError<TerminalSubprocessCheckError>()(
  "TerminalSubprocessCheckError",
  {
    cause: Schema.optional(Schema.Defect()),
    command: Schema.Literals(["powershell", "ps", "resource-monitor"]),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    timedOut: Schema.optional(Schema.Boolean),
    stdoutTruncated: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    const details = [
      this.exitCode !== undefined && this.exitCode !== null ? `exit code ${this.exitCode}` : null,
      this.timedOut ? "timed out" : null,
      this.stdoutTruncated ? "output truncated" : null,
    ]
      .filter((detail) => detail !== null)
      .join(", ");
    return `Failed to inspect terminal subprocesses with ${this.command}${details.length > 0 ? ` (${details})` : ""}`;
  }
}

class TerminalProcessSignalError extends Schema.TaggedError<TerminalProcessSignalError>()(
  "TerminalProcessSignalError",
  {
    cause: Schema.optional(Schema.Defect()),
    signal: Schema.Literals(["SIGTERM", "SIGKILL"]),
    terminalPid: Schema.Number,
  },
) {
  override get message(): string {
    return `Failed to send ${this.signal} to terminal process ${this.terminalPid}`;
  }
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends Context.Service<
  TerminalManager,
  {
    /**
     * Open or attach to a terminal session.
     *
     * Reuses an existing session for the same thread/terminal id and restores
     * persisted history on first open.
     */
    readonly open: (
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /**
     * Attach to a terminal and stream its initial snapshot followed by live events.
     *
     * Returns an unsubscribe function.
     */
    readonly attachStream: (
      input: TerminalAttachInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void, TerminalError>;

    /**
     * Write input bytes to a terminal session.
     */
    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

    /**
     * Resize the PTY backing a terminal session.
     */
    readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

    /**
     * Clear terminal output history.
     */
    readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

    /**
     * Restart a terminal session in place.
     *
     * Always resets history before spawning the new process.
     */
    readonly restart: (
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /**
     * Close an active terminal session.
     *
     * When `terminalId` is omitted, closes all sessions for the thread.
     */
    readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

    /**
     * Subscribe to terminal runtime events with a direct callback.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribe: (
      listener: (event: TerminalEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;

    /**
     * Subscribe to lightweight terminal metadata with an initial full snapshot.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribeMetadata: (
      listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;

    readonly createProject: (
      input: ProjectTerminalCreateInput,
    ) => Effect.Effect<ProjectTerminalSummary, TerminalToolError>;
    readonly listProject: (
      projectId: string,
    ) => Effect.Effect<ReadonlyArray<ProjectTerminalSummary>>;
    readonly readProject: (
      input: TerminalReadInput,
    ) => Effect.Effect<TerminalReadResult, TerminalToolError>;
    readonly writeProject: (
      input: ProjectTerminalWriteInput,
    ) => Effect.Effect<void, TerminalToolError>;
    readonly resizeProject: (
      input: ProjectTerminalResizeInput,
    ) => Effect.Effect<void, TerminalToolError>;
    readonly killProjectTerminal: (
      input: ProjectTerminalKillInput,
    ) => Effect.Effect<void, TerminalToolError>;
    readonly closeProject: (projectId: string) => Effect.Effect<void, TerminalToolError>;
    readonly subscribeProjectEvents: (
      listener: (event: ProjectTerminalRuntimeEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
    readonly subscribeProjectTerminal: (
      input: ProjectTerminalHandle,
      listener: (event: ProjectTerminalRuntimeEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
  }
>()("t3/terminal/Manager/TerminalManager") {}

interface TerminalSubprocessInspectResult {
  readonly hasRunningSubprocess: boolean;
  readonly childCommand: string | null;
  readonly processIds: ReadonlyArray<number>;
}

interface TerminalSubprocessInspector {
  (
    terminalPid: number,
  ): Effect.Effect<TerminalSubprocessInspectResult, TerminalSubprocessCheckError>;
}

const resizePtyProcess = (
  session: TerminalSessionState,
  process: PtyAdapter.PtyProcess,
  cols: number,
  rows: number,
) =>
  Effect.try({
    try: () => process.resize(cols, rows),
    catch: (cause) =>
      new TerminalResizeError({
        threadId: threadIdOf(session),
        terminalId: session.terminalId,
        terminalPid: process.pid,
        cols,
        rows,
        cause,
      }),
  });

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput {
  cwd: string;
  worktreePath?: string | null;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  command?: string;
  args?: ReadonlyArray<string>;
}

interface TerminalSessionState {
  owner: TerminalOwner;
  terminalId: string;
  creatingThreadId: string | null;
  title: string | null;
  command: string | null;
  args: ReadonlyArray<string>;
  cwd: string;
  worktreePath: string | null;
  status: TerminalRuntimeStatus;
  pid: number | null;
  history: BoundedTerminalHistory;
  pendingHistoryControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  processEventDrainRunning: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  eventSequence: number;
  cols: number;
  rows: number;
  process: PtyAdapter.PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  /** Normalized child command name when `hasRunningSubprocess`; cleared when idle. */
  childCommandLabel: string | null;
  runtimeEnv: Record<string, string> | null;
  terminationRequested: boolean;
  cleanupAfterExit: boolean;
  exitFinalized: Deferred.Deferred<void> | null;
  exitHistoryPersisted: boolean;
  killFailure: TerminalProcessSignalError | null;
}

type TerminalRuntimeStatus = TerminalSessionStatus | "stopping" | "killed";

interface PersistHistoryRequest {
  target: TerminalTarget;
  history: BoundedTerminalHistory;
  immediate: boolean;
}

type PendingProcessEvent =
  | { type: "output"; data: string }
  | { type: "exit"; event: PtyAdapter.PtyExitEvent };

type DrainProcessEventAction =
  | { type: "idle" }
  | {
      type: "output";
      target: TerminalTarget;
      sequence: number;
      history: BoundedTerminalHistory | null;
      data: string;
    }
  | {
      type: "exit";
      process: PtyAdapter.PtyProcess | null;
      target: TerminalTarget;
      sequence: number;
      status: "exited" | "killed";
      cleanupAfterExit: boolean;
      exitCode: number | null;
      exitSignal: number | null;
    };

interface TerminalManagerState {
  sessions: Map<string, TerminalSessionState>;
  killFibers: Map<PtyAdapter.PtyProcess, Fiber.Fiber<void, TerminalProcessSignalError>>;
}

function truncateTerminalWireLabel(value: string): string {
  if (value.length <= MAX_TERMINAL_LABEL_LENGTH) return value;
  return value.slice(0, MAX_TERMINAL_LABEL_LENGTH);
}

function normalizeChildCommandName(raw: string, platform: NodeJS.Platform): string | null {
  let trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  const firstToken = (trimmed.split(/\s+/)[0] ?? trimmed).trim();
  if (firstToken.length === 0) return null;
  const separators = platform === "win32" ? /[\\/]/ : /\//;
  const base = firstToken.split(separators).at(-1) ?? firstToken;
  const withoutExe =
    platform === "win32" && base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
  return withoutExe.length > 0 ? withoutExe : null;
}

function terminalWireLabel(session: TerminalSessionState): string {
  if (session.hasRunningSubprocess && session.childCommandLabel) {
    const trimmed = session.childCommandLabel.trim();
    if (trimmed.length > 0) {
      return truncateTerminalWireLabel(trimmed);
    }
  }
  return truncateTerminalWireLabel(getTerminalLabel(session.terminalId));
}

function threadIdOf(session: TerminalSessionState): string {
  if (session.owner.kind !== "thread") {
    throw new Error("A project terminal cannot be used by the thread terminal API.");
  }
  return session.owner.threadId;
}

function terminalTargetOf(session: TerminalSessionState): TerminalTarget {
  return { owner: session.owner, terminalId: session.terminalId };
}

function wireStatus(status: TerminalRuntimeStatus): TerminalSessionStatus {
  return status === "stopping" || status === "killed" ? "exited" : status;
}

function snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
  return {
    threadId: threadIdOf(session),
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: wireStatus(session.status),
    pid: session.pid,
    history: session.history.value(),
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
    sequence: session.eventSequence,
  };
}

function summary(session: TerminalSessionState): TerminalSummary {
  return {
    threadId: threadIdOf(session),
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: wireStatus(session.status),
    pid: session.pid,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    hasRunningSubprocess: session.hasRunningSubprocess,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
  };
}

function projectSummary(session: TerminalSessionState): ProjectTerminalSummary {
  if (session.owner.kind !== "project" || session.creatingThreadId === null) {
    throw new Error(
      "Project terminal metadata requires project ownership and creator attribution.",
    );
  }
  return {
    projectId: session.owner.projectId,
    terminalId: session.terminalId,
    title: session.title,
    command: session.command,
    args: [...session.args],
    cwd: session.cwd,
    creatingThreadId: session.creatingThreadId as ProjectTerminalSummary["creatingThreadId"],
    label: truncateTerminalWireLabel(
      session.title ?? session.command ?? getTerminalLabel(session.terminalId),
    ),
    status: session.status,
    pid: session.pid,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    updatedAt: session.updatedAt,
  };
}

function shouldPublishTerminalMetadataEvent(event: TerminalEvent): boolean {
  switch (event.type) {
    case "started":
    case "restarted":
    case "exited":
    case "closed":
    case "error":
    case "activity":
      return true;
    case "output":
    case "cleared":
      return false;
  }
}

function terminalEventToAttachEvent(event: TerminalEvent): TerminalAttachStreamEvent | null {
  switch (event.type) {
    case "started":
      return {
        type: "snapshot",
        snapshot: event.snapshot,
      };
    case "output":
    case "exited":
    case "closed":
    case "error":
    case "cleared":
    case "restarted":
    case "activity":
      return event;
  }
}

function isDuplicateAttachSnapshotEvent(
  event: TerminalEvent,
  initialSnapshot: TerminalSessionSnapshot,
) {
  return typeof event.sequence === "number" && typeof initialSnapshot.sequence === "number"
    ? event.sequence <= initialSnapshot.sequence
    : event.type === "started" &&
        event.snapshot.threadId === initialSnapshot.threadId &&
        event.snapshot.terminalId === initialSnapshot.terminalId &&
        event.snapshot.updatedAt <= initialSnapshot.updatedAt;
}

function advanceEventSequence(session: TerminalSessionState): {
  readonly updatedAt: string;
  readonly sequence: number;
} {
  const updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
  session.eventSequence += 1;
  session.updatedAt = updatedAt;
  return { updatedAt, sequence: session.eventSequence };
}

function cleanupProcessHandles(session: TerminalSessionState): void {
  session.unsubscribeData?.();
  session.unsubscribeData = null;
  session.unsubscribeExit?.();
  session.unsubscribeExit = null;
}

function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
): boolean {
  if (
    !session.process ||
    (session.status !== "running" && session.status !== "stopping") ||
    session.pid !== expectedPid
  ) {
    return false;
  }

  session.pendingProcessEvents.push(event);
  if (session.processEventDrainRunning) {
    return false;
  }

  session.processEventDrainRunning = true;
  return true;
}

function defaultShellResolver(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    return "pwsh.exe";
  }
  return env.SHELL ?? "bash";
}

function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function basenameForPlatform(command: string, platform: NodeJS.Platform): string {
  const normalized =
    platform === "win32" ? command.replaceAll("/", "\\") : command.replaceAll("\\", "/");
  const parts = normalized
    .split(platform === "win32" ? /\\+/ : /\/+/)
    .filter((part) => part.length > 0);
  return parts.at(-1) ?? normalized;
}

function joinWindowsPath(...parts: ReadonlyArray<string>): string {
  return parts
    .map((part, index) => {
      if (index === 0) return part.replace(/[\\/]+$/g, "");
      return part.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter((part) => part.length > 0)
    .join("\\");
}

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = basenameForPlatform(command, platform).toLowerCase();
  if (platform === "win32" && (shellName === "pwsh.exe" || shellName === "powershell.exe")) {
    return { shell: command, args: ["-NoLogo"] };
  }
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(windowsSystemRoot(env), "System32", "cmd.exe");
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(
  shellResolver: () => string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ShellCandidate[] {
  const requested = shellCandidateFromCommand(
    normalizeShellCommand(shellResolver(), platform),
    platform,
  );

  if (platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand("pwsh.exe", platform),
      shellCandidateFromCommand(windowsPowerShellPath(env), platform),
      shellCandidateFromCommand("powershell.exe", platform),
      shellCandidateFromCommand(env.ComSpec ?? null, platform),
      shellCandidateFromCommand(windowsCmdPath(env), platform),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(env.SHELL, platform), platform),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
}

function isRetryableShellSpawnError(error: PtyAdapter.PtySpawnError): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause) {
        queue.push(current.cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

interface TerminalProcessTableSnapshot {
  readonly childrenByParent: ReadonlyMap<number, ReadonlyArray<number>>;
  readonly commandById: ReadonlyMap<number, string>;
}

export function subprocessSnapshotPollDelayMs(
  pollIntervalMs: number,
  failureCount: number,
): number {
  return Math.min(pollIntervalMs * 2 ** failureCount, MAX_SUBPROCESS_POLL_INTERVAL_MS);
}

function parsePosixProcessTable(stdout: string): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/g)) {
    // `comm=` is the final column and may itself contain spaces, so only the
    // first two tokens are structural.
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    commandById.set(pid, (match[3] ?? "").trim());
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  return { childrenByParent, commandById };
}

function processTableSnapshotFromProcesses(
  processes: ReadonlyArray<ResourceMonitorProcessTableEntry>,
): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const process of processes) {
    const { pid, ppid: parentPid, name } = process;
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    commandById.set(pid, name.trim());
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  return { childrenByParent, commandById };
}

function deriveSubprocessInspectResult(
  snapshot: TerminalProcessTableSnapshot,
  terminalPid: number,
  platform: NodeJS.Platform,
): TerminalSubprocessInspectResult {
  const childPid = (snapshot.childrenByParent.get(terminalPid) ?? [])[0];
  if (childPid === undefined) {
    return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
  }
  const processIds = new Set<number>([terminalPid]);
  const pending = [terminalPid];
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (parentPid === undefined) continue;
    for (const pid of snapshot.childrenByParent.get(parentPid) ?? []) {
      if (processIds.has(pid)) continue;
      processIds.add(pid);
      pending.push(pid);
    }
  }
  const normalized = normalizeChildCommandName(snapshot.commandById.get(childPid) ?? "", platform);
  return {
    hasRunningSubprocess: true,
    childCommand: normalized ? truncateTerminalWireLabel(normalized) : null,
    processIds: [...processIds],
  };
}

const POSIX_PS_ABSOLUTE_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;

// Resolve `ps` to an absolute path once at startup. Spawning by bare name
// walks every PATH entry per spawn (one failed posix_spawn per directory
// until the hit), which is measurable at a 1s poll cadence on long PATHs.
const resolvePosixPsCommand = Effect.fn("terminal.resolvePosixPsCommand")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of POSIX_PS_ABSOLUTE_PATHS) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return "ps";
});

const posixProcessTableSnapshot = Effect.fn("terminal.posixProcessTableSnapshot")(function* (
  psCommand: string,
): Effect.fn.Return<
  TerminalProcessTableSnapshot,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: psCommand,
      args: ["-eo", "pid=,ppid=,comm="],
      timeout: "1 second",
      maxOutputBytes: 524_288,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            cause,
            command: "ps",
          }),
      ),
    );
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
    // Not authoritative: an empty or partial table would mark every terminal
    // idle and clear its registered process ids. Failing skips the tick.
    return yield* new TerminalSubprocessCheckError({
      command: "ps",
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
  return parsePosixProcessTable(result.stdout);
});

const windowsProcessTableSnapshot = Effect.fn("terminal.windowsProcessTableSnapshot")(
  function* (): Effect.fn.Return<
    TerminalProcessTableSnapshot,
    TerminalSubprocessCheckError,
    ProcessRunner.ProcessRunner
  > {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const command =
      'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }';
    const result = yield* processRunner
      .run({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
        timeout: "1500 millis",
        maxOutputBytes: 262_144,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(
          (cause) => new TerminalSubprocessCheckError({ cause, command: "powershell" }),
        ),
      );
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
      return yield* new TerminalSubprocessCheckError({
        command: "powershell",
        exitCode: result.code,
        timedOut: result.timedOut,
        stdoutTruncated: result.stdoutTruncated,
      });
    }
    const processes = result.stdout.split(/\r?\n/g).flatMap((line) => {
      const [pidRaw, ppidRaw, name = ""] = line.trim().split("|", 3);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      return Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid)
        ? [{ pid, ppid, name }]
        : [];
    });
    return processTableSnapshotFromProcesses(processes);
  },
);

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) {
    return true;
  }
  // DECRQM mode queries (…$p) and DECRPM replies (…$y): replaying a stored
  // query makes the terminal answer again, and the shell echoes the answer as
  // junk at the prompt. The `$` guard keeps setters like DECSTR (!p) and
  // DECSCL ("p) intact.
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body)) {
    return true;
  }
  // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) {
    return true;
  }
  // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
  if (finalByte === "u" && body.startsWith("?")) {
    return true;
  }
  return false;
}

// DECRQSS ($q) and XTGETTCAP (+q) queries plus their replies ([01]$r / [01]+r):
// pure request/response traffic with no visual value, and replaying a stored
// query triggers a fresh reply.
function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
}

function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) {
      return index + 1;
    }
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content)) ||
          (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (!strip) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      append(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const strip =
        (codePoint === 0x9d && shouldStripOscSequence(content)) ||
        (codePoint === 0x90 && shouldStripDcsSequence(content));
      if (!strip) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    append(input[index] ?? "");
    index += 1;
  }

  return { visibleText, pendingControlSequence: "" };
}

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

function toSessionKey(threadId: string, terminalId: string): string {
  return terminalTargetKey(threadTerminalTarget(threadId, terminalId));
}

function ownerLockKey(owner: TerminalOwner): string {
  return owner.kind === "thread"
    ? JSON.stringify(["thread", owner.threadId])
    : JSON.stringify(["project", owner.projectId]);
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("T3CODE_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

// Marker variables the AppImage runtime injects into the process it launches.
// They describe the AppImage itself, not the user's session, so terminals must
// not inherit them.
const APPIMAGE_RUNTIME_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;
// Colon-separated search-path variables the AppImage runtime points at its
// temporary mount (e.g. /tmp/.mount_T3-XXXX/usr/bin, the bundled glib schemas,
// and an $APPDIR/usr/share XDG data entry). Only the mount segments are
// dropped; the user's real entries are preserved. When nothing but mount
// segments remain the variable is removed entirely so consumers fall back to
// their platform default (e.g. gsettings finds the host schemas instead of
// reporting "No schemas installed"). See issues #1699 and #5059.
const APPIMAGE_PATH_LIKE_ENV_KEYS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
] as const;

function isPathSegmentUnderAppDir(segment: string, appDir: string): boolean {
  return segment === appDir || segment.startsWith(`${appDir}/`);
}

// On Linux AppImage builds the runtime mounts the app under a temporary dir and
// injects APPIMAGE/APPDIR/ARGV0/OWD plus mount entries on PATH/LD_LIBRARY_PATH.
// The integrated terminal inherits the server process environment, so without
// this scrub those leak into the PTY and tools resolve against the AppImage
// mount instead of the user's real environment (e.g. `php` reporting
// PHP_BINARY as the AppImage path). See issue #1699. The scrub is gated on an
// actual AppImage launch so non-AppImage environments are left untouched.
function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;

  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_RUNTIME_ENV_KEYS) {
    delete scrubbed[key];
  }

  const appDir = env.APPDIR?.replace(/\/+$/, "");
  if (appDir) {
    for (const key of APPIMAGE_PATH_LIKE_ENV_KEYS) {
      const value = scrubbed[key];
      if (value === undefined) continue;
      const kept = value
        .split(":")
        .filter((segment) => segment.length > 0 && !isPathSegmentUnderAppDir(segment, appDir));
      if (kept.length > 0) {
        scrubbed[key] = kept.join(":");
      } else {
        delete scrubbed[key];
      }
    }
  }

  return scrubbed;
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] =
        key === "CODEX_HOME" || key === "CLAUDE_CONFIG_DIR" ? expandHomePath(value) : value;
    }
  }
  // Both PTY backends feed truecolor-capable terminal clients.
  if (spawnEnv.COLORTERM === undefined || spawnEnv.COLORTERM === "") {
    spawnEnv.COLORTERM = "truecolor";
  }
  return stripAppImageRuntimeEnv(spawnEnv);
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

interface TerminalManagerOptions {
  logsDir: string;
  historyLineLimit?: number;
  historyByteLimit?: number;
  ptyAdapter: PtyAdapter.PtyAdapter["Service"];
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: TerminalSubprocessInspector;
  processTable?: Effect.Effect<
    ReadonlyArray<ResourceMonitorProcessTableEntry>,
    TerminalSubprocessCheckError
  >;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  registerTerminalProcesses?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly processIds: ReadonlyArray<number>;
  }) => Effect.Effect<void>;
  unregisterTerminal?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<void>;
  resolveProviderInstanceEnvironment?: (
    providerInstanceId: string,
    env: Record<string, string> | undefined,
  ) => Effect.Effect<
    Record<string, string>,
    TerminalProviderInstanceNotFoundError | TerminalProviderEnvironmentError
  >;
}

export const resolveProviderInstanceTerminalEnvironment = Effect.fn(
  "terminal.resolveProviderInstanceTerminalEnvironment",
)(function* (input: {
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly path: Path.Path;
  readonly rawProviderInstanceId: string;
  readonly env: Record<string, string> | undefined;
}) {
  const providerInstanceId = ProviderInstanceId.make(input.rawProviderInstanceId);
  const settings = yield* input.serverSettings.getSettings.pipe(
    Effect.mapError((cause) => new TerminalProviderEnvironmentError({ providerInstanceId, cause })),
  );
  const instance = deriveProviderInstanceConfigMap(settings)[providerInstanceId];
  if (instance === undefined) {
    return yield* new TerminalProviderInstanceNotFoundError({ providerInstanceId });
  }

  let resolved = mergeProviderInstanceEnvironment(instance.environment, input.env ?? {});
  if (instance.driver === "codex") {
    const config = decodeCodexSettings(instance.config ?? {});
    if (Option.isSome(config)) {
      const layout = yield* resolveCodexHomeLayout(config.value).pipe(
        Effect.provideService(Path.Path, input.path),
      );
      if (layout.effectiveHomePath)
        resolved = { ...resolved, CODEX_HOME: layout.effectiveHomePath };
    }
  } else if (instance.driver === "claudeAgent") {
    const config = decodeClaudeSettings(instance.config ?? {});
    if (Option.isSome(config)) {
      resolved = yield* makeClaudeEnvironment(config.value, resolved).pipe(
        Effect.provideService(Path.Path, input.path),
      );
    }
  }

  return Object.fromEntries(
    Object.entries(resolved).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("TerminalManager.make")(function* () {
  const { terminalLogsDir } = yield* ServerConfig.ServerConfig;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const portDiscovery = yield* PortScanner.PortDiscovery;
  const nativeTelemetry = yield* NativeTelemetryClient.NativeTelemetryClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const resolveProviderInstanceEnvironment = Effect.fn(
    "terminal.resolveProviderInstanceEnvironment",
  )((rawProviderInstanceId: string, env: Record<string, string> | undefined) =>
    resolveProviderInstanceTerminalEnvironment({
      serverSettings,
      path,
      rawProviderInstanceId,
      env,
    }),
  );
  return yield* makeWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
    processTable: nativeTelemetry.processTable.pipe(
      Effect.mapError(
        (cause) => new TerminalSubprocessCheckError({ cause, command: "resource-monitor" }),
      ),
    ),
    registerTerminalProcesses: portDiscovery.registerTerminalProcesses,
    unregisterTerminal: portDiscovery.unregisterTerminal,
    resolveProviderInstanceEnvironment,
  });
});

export const makeWithOptions = Effect.fn("TerminalManager.makeWithOptions")(function* (
  options: TerminalManagerOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const logsDir = options.logsDir;
  const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
  const historyByteLimit = options.historyByteLimit ?? DEFAULT_HISTORY_BYTE_LIMIT;
  const platform = yield* HostProcessPlatform;
  // Terminals must inherit the user's full environment (minus the blocklist
  // applied in createTerminalSpawnEnv) — an allowlist here silently strips
  // things like PSModulePath, DISPLAY, proxies, and toolchain variables.
  // `options.env` is the test seam.
  const baseEnv = options.env ?? process.env;
  const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const resolveLaunchInputEnvironment = Effect.fn("terminal.resolveLaunchInputEnvironment")(
    function* <
      Input extends
        | TerminalOpenInput
        | TerminalAttachInput
        | TerminalRestartInput
        | ProjectTerminalCreateInput,
    >(
      input: Input,
    ): Effect.fn.Return<
      Input,
      TerminalProviderInstanceNotFoundError | TerminalProviderEnvironmentError
    > {
      if (input.providerInstanceId === undefined) return input;
      const resolver = options.resolveProviderInstanceEnvironment;
      if (resolver === undefined) {
        return yield* new TerminalProviderInstanceNotFoundError({
          providerInstanceId: ProviderInstanceId.make(input.providerInstanceId),
        });
      }
      const env = yield* resolver(input.providerInstanceId, input.env);
      return { ...input, env };
    },
  );
  // One process-table snapshot per poll tick, shared across every terminal.
  // Per-terminal `pgrep`/`ps` calls multiply spawn load by terminal count and
  // can exhaust the PID space on hosts with many sessions (#6332).
  const fallbackProcessTableSnapshot = (
    platform === "win32"
      ? windowsProcessTableSnapshot()
      : posixProcessTableSnapshot(yield* resolvePosixPsCommand())
  ).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner));
  const fetchProcessTableSnapshot: Effect.Effect<
    {
      readonly snapshot: TerminalProcessTableSnapshot;
      /**
       * False when the sidecar snapshot failed and this table came from the
       * spawned fallback. The data is still applied, but the tick counts as
       * a failure so polling backs off instead of hot-looping the fallback.
       */
      readonly snapshotSucceeded: boolean;
    },
    TerminalSubprocessCheckError
  > = options.processTable
    ? options.processTable.pipe(
        Effect.map((entries) => ({
          snapshot: processTableSnapshotFromProcesses(entries),
          snapshotSucceeded: true,
        })),
        Effect.catch(() =>
          fallbackProcessTableSnapshot.pipe(
            Effect.map((snapshot) => ({ snapshot, snapshotSucceeded: false })),
          ),
        ),
      )
    : fallbackProcessTableSnapshot.pipe(
        Effect.map((snapshot) => ({ snapshot, snapshotSucceeded: true })),
      );
  const customSubprocessInspector = options.subprocessInspector;
  const acquireSubprocessInspector: Effect.Effect<
    {
      readonly inspector: TerminalSubprocessInspector;
      readonly snapshotSucceeded: boolean;
    },
    TerminalSubprocessCheckError
  > =
    customSubprocessInspector !== undefined
      ? Effect.succeed({ inspector: customSubprocessInspector, snapshotSucceeded: true })
      : Effect.map(
          fetchProcessTableSnapshot,
          ({
            snapshot,
            snapshotSucceeded,
          }): {
            readonly inspector: TerminalSubprocessInspector;
            readonly snapshotSucceeded: boolean;
          } => ({
            inspector: (terminalPid) =>
              Effect.succeed(deriveSubprocessInspectResult(snapshot, terminalPid, platform)),
            snapshotSucceeded,
          }),
        );
  const subprocessPollIntervalMs =
    options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
  const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
  const maxRetainedInactiveSessions =
    options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
  const registerTerminalProcesses = options.registerTerminalProcesses ?? (() => Effect.void);
  const unregisterTerminal = options.unregisterTerminal ?? (() => Effect.void);

  yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);

  const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
    sessions: new Map(),
    killFibers: new Map(),
  });
  const ownerLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const projectCloseInFlight = new Map<
    string,
    Deferred.Deferred<Exit.Exit<void, TerminalToolError>>
  >();
  const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const projectEventListeners = new Set<
    (event: ProjectTerminalRuntimeEvent) => Effect.Effect<void>
  >();
  const workerScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

  const publishEvent = (event: TerminalEvent) =>
    Effect.gen(function* () {
      for (const listener of terminalEventListeners) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
    });

  const publishProjectEvent = (event: ProjectTerminalRuntimeEvent) =>
    Effect.gen(function* () {
      for (const listener of projectEventListeners) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
    });

  const historyPath = (threadId: string, terminalId: string) => {
    const threadPart = toSafeThreadId(threadId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(logsDir, `${threadPart}.log`);
    }
    return path.join(logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
  };

  const projectHistoryDirectory = (projectId: string) =>
    path.join(logsDir, "projects", toSafeTerminalId(projectId));

  const historyPathForTarget = (target: TerminalTarget) =>
    target.owner.kind === "thread"
      ? historyPath(target.owner.threadId, target.terminalId)
      : path.join(
          projectHistoryDirectory(target.owner.projectId),
          `terminal_${toSafeTerminalId(target.terminalId)}.log`,
        );

  const legacyHistoryPath = (threadId: string) =>
    path.join(logsDir, `${legacySafeThreadId(threadId)}.log`);

  const readManagerState = SynchronizedRef.get(managerStateRef);

  const modifyManagerState = <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => SynchronizedRef.modify(managerStateRef, f);

  const getOwnerSemaphore = (owner: TerminalOwner) =>
    SynchronizedRef.modifyEffect(ownerLocksRef, (current) => {
      const key = ownerLockKey(owner);
      const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(current.get(key));
      return Option.match(existing, {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(key, semaphore);
              return [semaphore, next] as const;
            }),
          ),
        onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
      });
    });

  const withOwnerLock = <A, E, R>(
    owner: TerminalOwner,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(getOwnerSemaphore(owner), (semaphore) => semaphore.withPermit(effect));

  const withThreadLock = <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => withOwnerLock({ kind: "thread", threadId }, effect);

  const clearKillFiber = Effect.fn("terminal.clearKillFiber")(function* (
    process: PtyAdapter.PtyProcess | null,
  ) {
    if (!process) return;
    const fiber: Option.Option<Fiber.Fiber<void, TerminalProcessSignalError>> =
      yield* modifyManagerState<Option.Option<Fiber.Fiber<void, TerminalProcessSignalError>>>(
        (state) => {
          const existing: Option.Option<Fiber.Fiber<void, TerminalProcessSignalError>> =
            Option.fromNullishOr(state.killFibers.get(process));
          if (Option.isNone(existing)) {
            return [Option.none<Fiber.Fiber<void, TerminalProcessSignalError>>(), state] as const;
          }
          const killFibers = new Map(state.killFibers);
          killFibers.delete(process);
          return [existing, { ...state, killFibers }] as const;
        },
      );
    if (Option.isSome(fiber)) {
      yield* Fiber.interrupt(fiber.value).pipe(Effect.ignore);
    }
  });

  const registerKillFiber = Effect.fn("terminal.registerKillFiber")(function* (
    process: PtyAdapter.PtyProcess,
    fiber: Fiber.Fiber<void, TerminalProcessSignalError>,
  ) {
    yield* modifyManagerState((state) => {
      const killFibers = new Map(state.killFibers);
      killFibers.set(process, fiber);
      return [undefined, { ...state, killFibers }] as const;
    });
  });

  const runKillEscalation = Effect.fn("terminal.runKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    target: TerminalTarget,
    sigtermAlreadySent = false,
  ) {
    const terminated = sigtermAlreadySent
      ? true
      : yield* Effect.try({
          try: () => process.kill("SIGTERM"),
          catch: (cause) =>
            new TerminalProcessSignalError({
              cause,
              signal: "SIGTERM",
              terminalPid: process.pid,
            }),
        }).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("failed to kill terminal process", {
              target,
              signal: "SIGTERM",
              cause: error,
            }).pipe(Effect.as(false)),
          ),
        );
    if (!terminated) {
      return;
    }

    yield* Effect.sleep(processKillGraceMs);

    yield* Effect.try({
      try: () => process.kill("SIGKILL"),
      catch: (cause) =>
        new TerminalProcessSignalError({
          cause,
          signal: "SIGKILL",
          terminalPid: process.pid,
        }),
    });
  });

  const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    target: TerminalTarget,
    sigtermAlreadySent = false,
  ) {
    const existing = yield* readManagerState.pipe(
      Effect.map((state) => state.killFibers.has(process)),
    );
    if (existing) return;

    const start = yield* Deferred.make<void>();
    const fiber = yield* Deferred.await(start).pipe(
      Effect.andThen(runKillEscalation(process, target, sigtermAlreadySent)),
      Effect.tapError((error) =>
        modifyManagerState((state) => {
          const session = state.sessions.get(terminalTargetKey(target));
          if (session?.process === process) session.killFailure = error;
          return [undefined, state] as const;
        }).pipe(
          Effect.andThen(
            Effect.logWarning("failed to escalate terminal process termination", {
              target,
              signal: error.signal,
              cause: error,
            }),
          ),
        ),
      ),
      Effect.ensuring(
        modifyManagerState((state) => {
          if (!state.killFibers.has(process)) {
            return [undefined, state] as const;
          }
          const killFibers = new Map(state.killFibers);
          killFibers.delete(process);
          return [undefined, { ...state, killFibers }] as const;
        }),
      ),
      Effect.forkIn(workerScope),
    );

    yield* registerKillFiber(process, fiber);
    yield* Deferred.succeed(start, undefined).pipe(Effect.asVoid);
  });

  const awaitKillFiber = Effect.fn("terminal.awaitKillFiber")(function* (
    process: PtyAdapter.PtyProcess,
  ) {
    const fiber = yield* readManagerState.pipe(
      Effect.map((state) => Option.fromNullishOr(state.killFibers.get(process))),
    );
    if (Option.isSome(fiber)) yield* Fiber.await(fiber.value);
  });

  const persistWorker = yield* makeKeyedCoalescingWorker<
    string,
    PersistHistoryRequest,
    never,
    never
  >({
    merge: (current, next) => ({
      target: next.target,
      history: next.history,
      immediate: current.immediate || next.immediate,
    }),
    process: Effect.fn("terminal.persistHistoryWorker")(function* (_sessionKey, request) {
      if (!request.immediate) {
        yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS);
      }

      yield* Effect.gen(function* () {
        if (request.target.owner.kind === "project") {
          yield* fileSystem.makeDirectory(projectHistoryDirectory(request.target.owner.projectId), {
            recursive: true,
          });
        }
        yield* fileSystem.writeFileString(
          historyPathForTarget(request.target),
          request.history.value(),
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to persist terminal history", {
            target: request.target,
            error,
          }),
        ),
      );
    }),
  });

  const queuePersistTarget = Effect.fn("terminal.queuePersistTarget")(function* (
    target: TerminalTarget,
    history: BoundedTerminalHistory,
  ) {
    yield* persistWorker.enqueue(terminalTargetKey(target), {
      target,
      history,
      immediate: false,
    });
  });

  const flushPersistTarget = Effect.fn("terminal.flushPersistTarget")(function* (
    target: TerminalTarget,
  ) {
    yield* persistWorker.drainKey(terminalTargetKey(target));
  });

  const flushPersist = Effect.fn("terminal.flushPersist")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* flushPersistTarget(threadTerminalTarget(threadId, terminalId));
  });

  const persistHistoryTarget = Effect.fn("terminal.persistHistoryTarget")(function* (
    target: TerminalTarget,
    history: BoundedTerminalHistory,
  ) {
    yield* persistWorker.enqueue(terminalTargetKey(target), {
      target,
      history,
      immediate: true,
    });
    yield* flushPersistTarget(target);
  });

  const persistHistory = Effect.fn("terminal.persistHistory")(function* (
    threadId: string,
    terminalId: string,
    history: BoundedTerminalHistory,
  ) {
    yield* persistHistoryTarget(threadTerminalTarget(threadId, terminalId), history);
  });

  const readHistoryTail = Effect.fn("terminal.readHistoryTail")(function* (filePath: string) {
    const file = yield* fileSystem.open(filePath, { flag: "r" });
    const info = yield* file.stat;
    const limit = BigInt(historyByteLimit);
    const offset = info.size > limit ? info.size - limit : 0n;
    yield* file.seek(offset, "start");
    const bytes = new Uint8Array(Number(info.size - offset));
    let length = 0;
    while (length < bytes.length) {
      const read = Number(yield* file.read(bytes.subarray(length)));
      if (read === 0) break;
      length += read;
    }
    let start = 0;
    if (offset > 0n) {
      // A tail read can start inside a UTF-8 code point. Skip its remaining bytes.
      while (start < length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
    }
    return {
      history: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(start, length)),
      truncated: offset > 0n,
    };
  });

  const readHistory = Effect.fn("terminal.readHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    const nextPath = historyPath(threadId, terminalId);
    if (
      yield* fileSystem
        .exists(nextPath)
        .pipe(
          Effect.mapError(
            (cause) => new TerminalHistoryError({ operation: "read", threadId, terminalId, cause }),
          ),
        )
    ) {
      const { history: raw, truncated } = yield* readHistoryTail(nextPath).pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) => new TerminalHistoryError({ operation: "read", threadId, terminalId, cause }),
        ),
      );
      const history = new BoundedTerminalHistory(historyLineLimit, raw, historyByteLimit);
      const capped = history.value();
      if (truncated || capped !== raw) {
        yield* fileSystem
          .writeFileString(nextPath, capped)
          .pipe(
            Effect.mapError(
              (cause) =>
                new TerminalHistoryError({ operation: "truncate", threadId, terminalId, cause }),
            ),
          );
      }
      return history;
    }

    if (terminalId !== DEFAULT_TERMINAL_ID) {
      return new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit);
    }

    const legacyPath = legacyHistoryPath(threadId);
    if (
      !(yield* fileSystem
        .exists(legacyPath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
          ),
        ))
    ) {
      return new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit);
    }

    const { history: raw } = yield* readHistoryTail(legacyPath).pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) => new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
      ),
    );
    const history = new BoundedTerminalHistory(historyLineLimit, raw, historyByteLimit);
    const capped = history.value();
    yield* fileSystem
      .writeFileString(nextPath, capped)
      .pipe(
        Effect.mapError(
          (cause) =>
            new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
        ),
      );
    yield* fileSystem.remove(legacyPath, { force: true }).pipe(
      Effect.catch((cleanupError) =>
        Effect.logWarning("failed to remove legacy terminal history", {
          threadId,
          error: cleanupError,
        }),
      ),
    );
    return history;
  });

  const deleteHistory = Effect.fn("terminal.deleteHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* fileSystem.remove(historyPath(threadId, terminalId), { force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to delete terminal history", {
          threadId,
          terminalId,
          error,
        }),
      ),
    );
    if (terminalId === DEFAULT_TERMINAL_ID) {
      yield* fileSystem.remove(legacyHistoryPath(threadId), { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to delete terminal history", {
            threadId,
            terminalId,
            error,
          }),
        ),
      );
    }
  });

  const deleteHistoryForTarget = Effect.fn("terminal.deleteHistoryForTarget")(function* (
    target: TerminalTarget,
  ) {
    if (target.owner.kind === "project") {
      yield* fileSystem.remove(historyPathForTarget(target), { force: true });
      return;
    }
    yield* fileSystem
      .remove(historyPathForTarget(target), { force: true })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to delete terminal history", { target, error }),
        ),
      );
    if (target.terminalId === DEFAULT_TERMINAL_ID) {
      yield* fileSystem
        .remove(legacyHistoryPath(target.owner.threadId), { force: true })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to delete terminal history", { target, error }),
          ),
        );
    }
  });

  const deleteAllHistoryForThread = Effect.fn("terminal.deleteAllHistoryForThread")(function* (
    threadId: string,
  ) {
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    const entries = yield* fileSystem
      .readDirectory(logsDir, { recursive: false })
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    yield* Effect.forEach(
      entries.filter(
        (name) =>
          name === `${toSafeThreadId(threadId)}.log` ||
          name === `${legacySafeThreadId(threadId)}.log` ||
          name.startsWith(threadPrefix),
      ),
      (name) =>
        fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to delete terminal histories for thread", {
              threadId,
              error,
            }),
          ),
        ),
      { discard: true },
    );
  });

  const assertValidCwd = Effect.fn("terminal.assertValidCwd")(function* (cwd: string) {
    const stats = yield* fileSystem.stat(cwd).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? new TerminalCwdNotFoundError({ cwd })
            : new TerminalCwdStatError({ cwd, cause }),
      }),
    );
    if (stats.type !== "Directory") {
      return yield* new TerminalCwdNotDirectoryError({ cwd });
    }
  });

  const getSessionByTarget = Effect.fn("terminal.getSessionByTarget")(function* (
    target: TerminalTarget,
  ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
    return yield* Effect.map(readManagerState, (state) =>
      Option.fromNullishOr(state.sessions.get(terminalTargetKey(target))),
    );
  });

  const getSession = Effect.fn("terminal.getSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
    return yield* getSessionByTarget(threadTerminalTarget(threadId, terminalId));
  });

  const requireSession = Effect.fn("terminal.requireSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<TerminalSessionState, TerminalSessionLookupError> {
    return yield* Effect.flatMap(getSession(threadId, terminalId), (session) =>
      Option.match(session, {
        onNone: () =>
          Effect.fail(
            new TerminalSessionLookupError({
              threadId,
              terminalId,
            }),
          ),
        onSome: Effect.succeed,
      }),
    );
  });

  const sessionsForThread = Effect.fn("terminal.sessionsForThread")(function* (threadId: string) {
    return yield* readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()].filter(
          (session) => session.owner.kind === "thread" && session.owner.threadId === threadId,
        ),
      ),
    );
  });

  const evictInactiveSessionsIfNeeded = Effect.fn("terminal.evictInactiveSessionsIfNeeded")(
    function* () {
      yield* modifyManagerState((state) => {
        const inactiveSessions = [...state.sessions.values()].filter(
          (session) =>
            session.status !== "running" &&
            session.status !== "starting" &&
            session.status !== "stopping" &&
            !session.cleanupAfterExit,
        );
        if (inactiveSessions.length <= maxRetainedInactiveSessions) {
          return [undefined, state] as const;
        }

        inactiveSessions.sort(
          (left, right) =>
            left.updatedAt.localeCompare(right.updatedAt) ||
            ownerLockKey(left.owner).localeCompare(ownerLockKey(right.owner)) ||
            left.terminalId.localeCompare(right.terminalId),
        );

        const sessions = new Map(state.sessions);

        const toEvict = inactiveSessions.length - maxRetainedInactiveSessions;
        for (const session of inactiveSessions.slice(0, toEvict)) {
          const key = terminalTargetKey(terminalTargetOf(session));
          sessions.delete(key);
        }

        return [undefined, { ...state, sessions }] as const;
      });
    },
  );

  const drainProcessEvents = Effect.fn("terminal.drainProcessEvents")(function* (
    session: TerminalSessionState,
    expectedPid: number,
  ) {
    while (true) {
      const action: DrainProcessEventAction = yield* Effect.sync(() => {
        if (
          session.pid !== expectedPid ||
          !session.process ||
          (session.status !== "running" && session.status !== "stopping")
        ) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        const nextEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
        if (!nextEvent) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        session.pendingProcessEventIndex += 1;
        if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
        }

        if (nextEvent.type === "output") {
          const sanitized = sanitizeTerminalHistoryChunk(
            session.pendingHistoryControlSequence,
            nextEvent.data,
          );
          session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
          if (sanitized.visibleText.length > 0) {
            session.history.append(sanitized.visibleText);
          }
          const eventStamp = advanceEventSequence(session);

          return {
            type: "output",
            target: terminalTargetOf(session),
            sequence: eventStamp.sequence,
            history: sanitized.visibleText.length > 0 ? session.history : null,
            data: nextEvent.data,
          } as const;
        }

        const process = session.process;
        session.history.finalizePendingCodePoint();
        cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.killFailure = null;
        session.status = session.terminationRequested ? "killed" : "exited";
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        session.exitCode = Number.isInteger(nextEvent.event.exitCode)
          ? nextEvent.event.exitCode
          : null;
        session.exitSignal = Number.isInteger(nextEvent.event.signal)
          ? nextEvent.event.signal
          : null;
        const eventStamp = advanceEventSequence(session);

        return {
          type: "exit",
          process,
          target: terminalTargetOf(session),
          sequence: eventStamp.sequence,
          status: session.status,
          cleanupAfterExit: session.cleanupAfterExit,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
        } as const;
      });

      if (action.type === "idle") {
        return;
      }

      if (action.type === "output") {
        if (action.history !== null) {
          yield* queuePersistTarget(action.target, action.history);
        }

        if (action.target.owner.kind === "thread") {
          yield* publishEvent({
            type: "output",
            threadId: action.target.owner.threadId,
            terminalId: action.target.terminalId,
            sequence: action.sequence,
            data: action.data,
          });
        } else {
          yield* publishProjectEvent({
            type: "output",
            target: action.target,
            sequence: action.sequence,
            data: action.data,
          });
        }
        continue;
      }

      yield* clearKillFiber(action.process);
      // An exit observer can close the session and delete its log during publication. Commit
      // the final snapshot first so no worker write can recreate history after that cleanup.
      yield* persistHistoryTarget(action.target, session.history);
      if (action.target.owner.kind === "project") {
        session.exitHistoryPersisted = true;
      }
      if (action.target.owner.kind === "thread") {
        yield* unregisterTerminal({
          threadId: action.target.owner.threadId,
          terminalId: action.target.terminalId,
        });
        yield* publishEvent({
          type: "exited",
          threadId: action.target.owner.threadId,
          terminalId: action.target.terminalId,
          sequence: action.sequence,
          exitCode: action.exitCode,
          exitSignal: action.exitSignal,
        });
      } else {
        yield* publishProjectEvent({
          type: "exited",
          target: action.target,
          sequence: action.sequence,
          status: action.status,
          exitCode: action.exitCode,
          exitSignal: action.exitSignal,
        });
      }
      // Keep the legacy exit receipt and retention eviction adjacent. Consumers may reopen a
      // just-exited terminal as soon as they observe that receipt.
      yield* evictInactiveSessionsIfNeeded();
      if (action.cleanupAfterExit && action.target.owner.kind === "project") {
        const cleanupResult = yield* Effect.exit(deleteHistoryForTarget(action.target));
        if (Exit.isFailure(cleanupResult)) {
          yield* Effect.logWarning("failed to clean up project terminal history", {
            target: action.target,
            cause: cleanupResult.cause,
          });
        } else {
          const key = terminalTargetKey(action.target);
          yield* modifyManagerState((state) => {
            if (!state.sessions.has(key)) return [undefined, state] as const;
            const sessions = new Map(state.sessions);
            sessions.delete(key);
            return [undefined, { ...state, sessions }] as const;
          });
          yield* publishProjectEvent({
            type: "closed",
            target: action.target,
            sequence: action.sequence + 1,
          });
        }
      }
      if (session.exitFinalized) {
        yield* Deferred.succeed(session.exitFinalized, undefined).pipe(Effect.asVoid);
      }
      return;
    }
  });

  const stopProcess = Effect.fn("terminal.stopProcess")(function* (session: TerminalSessionState) {
    const process = session.process;
    if (!process) return;

    const updatedAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      cleanupProcessHandles(session);
      session.process = null;
      session.pid = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      session.status = "exited";
      session.pendingHistoryControlSequence = "";
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = updatedAt;
      return [undefined, state] as const;
    });

    yield* clearKillFiber(process);
    if (session.owner.kind === "thread") {
      yield* unregisterTerminal({
        threadId: session.owner.threadId,
        terminalId: session.terminalId,
      });
    }
    yield* startKillEscalation(process, terminalTargetOf(session));
    yield* evictInactiveSessionsIfNeeded();
  });

  const trySpawn = Effect.fn("terminal.trySpawn")(function* (
    shellCandidates: ReadonlyArray<ShellCandidate>,
    spawnEnv: NodeJS.ProcessEnv,
    session: TerminalSessionState,
    index = 0,
    lastError: PtyAdapter.PtySpawnError | null = null,
  ): Effect.fn.Return<
    { process: PtyAdapter.PtyProcess; shellLabel: string },
    PtyAdapter.PtySpawnError
  > {
    if (index >= shellCandidates.length) {
      return yield* new PtyAdapter.PtySpawnError({
        adapter: "terminal-manager",
        attemptedShells: shellCandidates.map((candidate) => formatShellCandidate(candidate)),
        ...(lastError ? { cause: lastError } : {}),
      });
    }

    const candidate = shellCandidates[index];
    if (!candidate) {
      return yield* (
        lastError ??
          new PtyAdapter.PtySpawnError({
            adapter: "terminal-manager",
            attemptedShells: [],
          })
      );
    }

    const attempt = yield* Effect.result(
      options.ptyAdapter.spawn({
        shell: candidate.shell,
        ...(candidate.args ? { args: candidate.args } : {}),
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        env: spawnEnv,
      }),
    );

    if (attempt._tag === "Success") {
      return {
        process: attempt.success,
        shellLabel: formatShellCandidate(candidate),
      };
    }

    const spawnError = attempt.failure;
    if (!isRetryableShellSpawnError(spawnError)) {
      return yield* spawnError;
    }

    return yield* trySpawn(shellCandidates, spawnEnv, session, index + 1, spawnError);
  });

  const startSession = Effect.fn("terminal.startSession")(function* (
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
  ) {
    yield* stopProcess(session);
    yield* Effect.annotateCurrentSpan({
      ...(session.owner.kind === "thread" ? { "terminal.thread_id": session.owner.threadId } : {}),
      "terminal.id": session.terminalId,
      "terminal.event_type": eventType,
      "terminal.cwd": input.cwd,
    });

    const startingAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      session.status = "starting";
      session.cwd = input.cwd;
      session.worktreePath = input.worktreePath ?? null;
      session.command = input.command ?? null;
      session.args = [...(input.args ?? [])];
      session.cols = input.cols;
      session.rows = input.rows;
      session.exitCode = null;
      session.exitSignal = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.terminationRequested = false;
      session.cleanupAfterExit = false;
      session.exitHistoryPersisted = false;
      session.updatedAt = startingAt;
      return [undefined, state] as const;
    });

    let ptyProcess: PtyAdapter.PtyProcess | null = null;
    let startedShell: string | null = null;

    const startResult = yield* Effect.result(
      increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const terminalEnv = createTerminalSpawnEnv(baseEnv, session.runtimeEnv);
            const spawnResult =
              input.command === undefined
                ? yield* trySpawn(
                    resolveShellCandidates(shellResolver, platform, baseEnv),
                    terminalEnv,
                    session,
                  )
                : yield* options.ptyAdapter
                    .spawn({
                      shell: input.command,
                      ...(input.args ? { args: [...input.args] } : {}),
                      cwd: session.cwd,
                      cols: session.cols,
                      rows: session.rows,
                      env: terminalEnv,
                    })
                    .pipe(Effect.map((process) => ({ process, shellLabel: input.command! })));
            ptyProcess = spawnResult.process;
            startedShell = spawnResult.shellLabel;

            const processPid = ptyProcess.pid;
            const exitFinalized =
              session.owner.kind === "project" ? yield* Deferred.make<void>() : null;
            const unsubscribeData = ptyProcess.onData((data) => {
              if (!enqueueProcessEvent(session, processPid, { type: "output", data })) {
                return;
              }
              runFork(drainProcessEvents(session, processPid));
            });
            const unsubscribeExit = ptyProcess.onExit((event) => {
              if (!enqueueProcessEvent(session, processPid, { type: "exit", event })) {
                return;
              }
              runFork(drainProcessEvents(session, processPid));
            });

            let eventStamp: ReturnType<typeof advanceEventSequence> = {
              updatedAt: session.updatedAt,
              sequence: session.eventSequence,
            };
            yield* modifyManagerState((state) => {
              session.process = ptyProcess;
              session.pid = processPid;
              session.status = "running";
              session.exitFinalized = exitFinalized;
              session.exitHistoryPersisted = false;
              session.killFailure = null;
              session.unsubscribeData = unsubscribeData;
              session.unsubscribeExit = unsubscribeExit;
              eventStamp = advanceEventSequence(session);
              return [undefined, state] as const;
            });

            if (session.owner.kind === "thread") {
              yield* publishEvent({
                type: eventType,
                threadId: session.owner.threadId,
                terminalId: session.terminalId,
                sequence: eventStamp.sequence,
                snapshot: snapshot(session),
              });
            }
          }),
        ),
      ),
    );

    if (startResult._tag === "Success") {
      return false;
    }

    {
      const error = startResult.failure;
      if (ptyProcess) {
        yield* startKillEscalation(ptyProcess, terminalTargetOf(session));
      }

      yield* modifyManagerState((state) => {
        cleanupProcessHandles(session);
        session.status = "error";
        session.pid = null;
        session.process = null;
        session.exitFinalized = null;
        session.exitHistoryPersisted = false;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        advanceEventSequence(session);
        return [undefined, state] as const;
      });
      if (session.owner.kind === "thread") {
        yield* unregisterTerminal({
          threadId: session.owner.threadId,
          terminalId: session.terminalId,
        });
      }

      yield* evictInactiveSessionsIfNeeded();

      const message = error.message;
      if (session.owner.kind === "thread") {
        yield* publishEvent({
          type: "error",
          threadId: session.owner.threadId,
          terminalId: session.terminalId,
          sequence: session.eventSequence,
          message,
        });
      }
      yield* Effect.logError("failed to start terminal", {
        target: terminalTargetOf(session),
        terminalId: session.terminalId,
        cause: error,
        ...(startedShell ? { shell: startedShell } : {}),
      });
      return true;
    }
  });

  const closeSession = Effect.fn("terminal.closeSession")(function* (
    threadId: string,
    terminalId: string,
    deleteHistoryOnClose: boolean,
  ) {
    const key = toSessionKey(threadId, terminalId);
    const session = yield* getSession(threadId, terminalId);
    const closedEventSequence = Option.isSome(session) ? session.value.eventSequence + 1 : 0;

    if (Option.isSome(session)) {
      yield* stopProcess(session.value);
      yield* unregisterTerminal({ threadId, terminalId });
      yield* persistHistory(threadId, terminalId, session.value.history);
    }

    yield* flushPersist(threadId, terminalId);

    const removed = yield* modifyManagerState((state) => {
      if (!state.sessions.has(key)) {
        return [false, state] as const;
      }
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [true, { ...state, sessions }] as const;
    });

    if (removed) {
      yield* publishEvent({
        type: "closed",
        threadId,
        terminalId,
        sequence: closedEventSequence,
      });
    }

    if (deleteHistoryOnClose) {
      yield* deleteHistory(threadId, terminalId);
    }
  });

  const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* () {
    const state = yield* readManagerState;
    const runningSessions = [...state.sessions.values()].filter(
      (
        session,
      ): session is TerminalSessionState & {
        owner: { kind: "thread"; threadId: string };
        pid: number;
      } =>
        session.owner.kind === "thread" &&
        session.status === "running" &&
        Number.isInteger(session.pid),
    );

    if (runningSessions.length === 0) {
      return true;
    }

    const inspectorOption = yield* acquireSubprocessInspector.pipe(
      Effect.map(Option.some),
      Effect.catch((reason) =>
        Effect.logWarning("failed to snapshot processes for terminal subprocess polling", {
          reason,
        }).pipe(
          Effect.as(
            Option.none<{
              readonly inspector: TerminalSubprocessInspector;
              readonly snapshotSucceeded: boolean;
            }>(),
          ),
        ),
      ),
    );

    if (Option.isNone(inspectorOption)) {
      return false;
    }

    const { inspector: subprocessInspector, snapshotSucceeded } = inspectorOption.value;

    const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
      session: TerminalSessionState & {
        owner: { kind: "thread"; threadId: string };
        pid: number;
      },
    ) {
      const terminalPid = session.pid;
      const inspectResult = yield* subprocessInspector(terminalPid).pipe(
        Effect.map(Option.some),
        Effect.catch((reason) =>
          Effect.logWarning("failed to check terminal subprocess activity", {
            threadId: session.owner.threadId,
            terminalId: session.terminalId,
            terminalPid,
            reason,
          }).pipe(Effect.as(Option.none<TerminalSubprocessInspectResult>())),
        ),
      );

      if (Option.isNone(inspectResult)) {
        return;
      }

      const next = inspectResult.value;
      yield* registerTerminalProcesses({
        threadId: session.owner.threadId,
        terminalId: session.terminalId,
        processIds: next.processIds,
      });
      const nextChildLabel = next.hasRunningSubprocess ? next.childCommand : null;
      const event = yield* modifyManagerState((state) => {
        const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
          state.sessions.get(toSessionKey(session.owner.threadId, session.terminalId)),
        );
        if (
          Option.isNone(liveSession) ||
          liveSession.value.status !== "running" ||
          liveSession.value.pid !== terminalPid ||
          (liveSession.value.hasRunningSubprocess === next.hasRunningSubprocess &&
            liveSession.value.childCommandLabel === nextChildLabel)
        ) {
          return [Option.none(), state] as const;
        }

        liveSession.value.hasRunningSubprocess = next.hasRunningSubprocess;
        liveSession.value.childCommandLabel = nextChildLabel;
        const eventStamp = advanceEventSequence(liveSession.value);

        return [
          Option.some({
            type: "activity" as const,
            threadId: threadIdOf(liveSession.value),
            terminalId: liveSession.value.terminalId,
            sequence: eventStamp.sequence,
            hasRunningSubprocess: next.hasRunningSubprocess,
            label: terminalWireLabel(liveSession.value),
          }),
          state,
        ] as const;
      });

      if (Option.isSome(event)) {
        yield* publishEvent(event.value);
      }
    });

    yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
      concurrency: "unbounded",
      discard: true,
    });
    return snapshotSucceeded;
  });

  const hasRunningSessions = readManagerState.pipe(
    Effect.map((state) =>
      [...state.sessions.values()].some(
        (session) => session.owner.kind === "thread" && session.status === "running",
      ),
    ),
  );

  let subprocessSnapshotFailureCount = 0;
  yield* Effect.forever(
    hasRunningSessions.pipe(
      Effect.flatMap((active) =>
        active
          ? pollSubprocessActivity().pipe(
              Effect.flatMap((snapshotSucceeded) => {
                subprocessSnapshotFailureCount = snapshotSucceeded
                  ? 0
                  : Math.min(subprocessSnapshotFailureCount + 1, 30);
                const delayMs = subprocessSnapshotPollDelayMs(
                  subprocessPollIntervalMs,
                  subprocessSnapshotFailureCount,
                );
                return Effect.sleep(delayMs);
              }),
            )
          : Effect.sync(() => {
              subprocessSnapshotFailureCount = 0;
            }).pipe(Effect.flatMap(() => Effect.sleep(subprocessPollIntervalMs))),
      ),
    ),
  ).pipe(Effect.forkIn(workerScope));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const sessions = yield* modifyManagerState(
        (state) =>
          [
            [...state.sessions.values()],
            {
              ...state,
              sessions: new Map(),
            },
          ] as const,
      );

      const cleanupSession = Effect.fn("terminal.cleanupSession")(function* (
        session: TerminalSessionState,
      ) {
        cleanupProcessHandles(session);
        if (session.owner.kind === "thread") {
          yield* unregisterTerminal({
            threadId: session.owner.threadId,
            terminalId: session.terminalId,
          });
        }
        if (!session.process) return;
        yield* clearKillFiber(session.process);
        yield* runKillEscalation(session.process, terminalTargetOf(session));
      });

      yield* Effect.forEach(sessions, cleanupSession, {
        concurrency: "unbounded",
        discard: true,
      });
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  const openLocked = Effect.fn("terminal.openLocked")(function* (input: TerminalOpenInput) {
    const terminalId = input.terminalId;
    yield* assertValidCwd(input.cwd);

    const sessionKey = toSessionKey(input.threadId, terminalId);
    const existing = yield* getSession(input.threadId, terminalId);
    if (Option.isNone(existing)) {
      yield* flushPersist(input.threadId, terminalId);
      const history = yield* readHistory(input.threadId, terminalId);
      const cols = input.cols ?? DEFAULT_OPEN_COLS;
      const rows = input.rows ?? DEFAULT_OPEN_ROWS;
      const session: TerminalSessionState = {
        owner: { kind: "thread", threadId: input.threadId },
        terminalId,
        creatingThreadId: null,
        title: null,
        command: null,
        args: [],
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "starting",
        pid: null,
        history,
        pendingHistoryControlSequence: "",
        pendingProcessEvents: [],
        pendingProcessEventIndex: 0,
        processEventDrainRunning: false,
        exitCode: null,
        exitSignal: null,
        updatedAt: yield* nowIso,
        eventSequence: 0,
        cols,
        rows,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hasRunningSubprocess: false,
        childCommandLabel: null,
        runtimeEnv: normalizedRuntimeEnv(input.env),
        terminationRequested: false,
        cleanupAfterExit: false,
        exitFinalized: null,
        exitHistoryPersisted: false,
        killFailure: null,
      };

      const createdSession = session;
      yield* modifyManagerState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(sessionKey, createdSession);
        return [undefined, { ...state, sessions }] as const;
      });

      yield* evictInactiveSessionsIfNeeded();
      yield* startSession(
        session,
        {
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          cols,
          rows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
      );
      return snapshot(session);
    }

    const liveSession = existing.value;
    const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
    const currentRuntimeEnv = liveSession.runtimeEnv;
    const targetCols = input.cols ?? liveSession.cols;
    const targetRows = input.rows ?? liveSession.rows;
    const runtimeEnvChanged = !Equal.equals(currentRuntimeEnv, nextRuntimeEnv);
    const nextWorktreePath =
      input.worktreePath !== undefined ? (input.worktreePath ?? null) : liveSession.worktreePath;
    const launchContextChanged =
      liveSession.cwd !== input.cwd ||
      runtimeEnvChanged ||
      liveSession.worktreePath !== nextWorktreePath;

    if (launchContextChanged) {
      yield* stopProcess(liveSession);
      liveSession.cwd = input.cwd;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.history.clear();
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(threadIdOf(liveSession), liveSession.terminalId, liveSession.history);
    } else if (
      liveSession.status === "exited" ||
      liveSession.status === "killed" ||
      liveSession.status === "error"
    ) {
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.history.clear();
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(threadIdOf(liveSession), liveSession.terminalId, liveSession.history);
    }

    if (!liveSession.process) {
      yield* startSession(
        liveSession,
        {
          cwd: input.cwd,
          worktreePath: liveSession.worktreePath,
          cols: targetCols,
          rows: targetRows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
      );
      return snapshot(liveSession);
    }

    if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
      yield* resizePtyProcess(liveSession, liveSession.process, targetCols, targetRows);
      liveSession.cols = targetCols;
      liveSession.rows = targetRows;
      liveSession.updatedAt = yield* nowIso;
    }

    return snapshot(liveSession);
  });

  const open: TerminalManager["Service"]["open"] = (input) =>
    withThreadLock(
      input.threadId,
      resolveLaunchInputEnvironment(input).pipe(Effect.flatMap(openLocked)),
    );

  const openOrAttachForStream = (input: TerminalAttachInput) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const existing = yield* getSession(input.threadId, terminalId);

        if (Option.isNone(existing)) {
          if (!input.cwd) {
            return yield* new TerminalSessionLookupError({
              threadId: input.threadId,
              terminalId,
            });
          }

          const resolvedInput = yield* resolveLaunchInputEnvironment({
            ...input,
            terminalId,
            cwd: input.cwd,
          });
          return yield* openLocked(resolvedInput);
        }

        const session = existing.value;
        const targetCols = input.cols ?? session.cols;
        const targetRows = input.rows ?? session.rows;

        if (!session.process && input.cwd && input.restartIfNotRunning === true) {
          const resolvedInput = yield* resolveLaunchInputEnvironment({
            ...input,
            terminalId,
            cwd: input.cwd,
          });
          return yield* openLocked(resolvedInput);
        }

        if (
          session.process &&
          session.status === "running" &&
          (session.cols !== targetCols || session.rows !== targetRows)
        ) {
          const process = session.process;
          yield* resizePtyProcess(session, process, targetCols, targetRows);
          session.cols = targetCols;
          session.rows = targetRows;
          session.updatedAt = yield* nowIso;
        }

        return snapshot(session);
      }),
    );

  const readAllTerminalMetadata = () =>
    readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()]
          .filter((session) => session.owner.kind === "thread")
          .map(summary)
          .sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) ||
              left.threadId.localeCompare(right.threadId) ||
              left.terminalId.localeCompare(right.terminalId),
          ),
      ),
    );

  const readTerminalMetadata = (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) =>
    getSession(input.threadId, input.terminalId).pipe(
      Effect.map((session) => (Option.isSome(session) ? summary(session.value) : null)),
    );

  const subscribe: TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      terminalEventListeners.add(listener);
      return () => {
        terminalEventListeners.delete(listener);
      };
    });

  const subscribeProjectEvents: TerminalManager["Service"]["subscribeProjectEvents"] = (listener) =>
    Effect.sync(() => {
      projectEventListeners.add(listener);
      return () => {
        projectEventListeners.delete(listener);
      };
    });

  const subscribeProjectTerminal: TerminalManager["Service"]["subscribeProjectTerminal"] = (
    input,
    listener,
  ) =>
    subscribeProjectEvents((event) =>
      event.target.owner.kind === "project" &&
      event.target.owner.projectId === input.projectId &&
      event.target.terminalId === input.terminalId
        ? listener(event)
        : Effect.void,
    );

  const attachStream: TerminalManager["Service"]["attachStream"] = (input, listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;

      unsubscribe = yield* subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }

        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        return attachEvent ? listener(attachEvent) : Effect.void;
      });

      const initialSnapshot = yield* openOrAttachForStream(input);

      yield* listener({
        type: "snapshot",
        snapshot: initialSnapshot,
      });

      for (const event of bufferedEvents) {
        if (isDuplicateAttachSnapshotEvent(event, initialSnapshot)) {
          continue;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        if (attachEvent) {
          yield* listener(attachEvent);
        }
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const metadataEventFromTerminalEvent = (
    event: TerminalEvent,
  ): Effect.Effect<TerminalMetadataStreamEvent | null> => {
    if (!shouldPublishTerminalMetadataEvent(event)) {
      return Effect.succeed(null);
    }

    if (event.type === "closed") {
      return Effect.succeed({
        type: "remove" as const,
        threadId: event.threadId,
        terminalId: event.terminalId,
      });
    }

    return readTerminalMetadata({
      threadId: event.threadId,
      terminalId: event.terminalId,
    }).pipe(
      Effect.map((terminal) =>
        terminal
          ? {
              type: "upsert" as const,
              terminal,
            }
          : null,
      ),
    );
  };

  const offerMetadataEvent = (
    listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    event: TerminalEvent,
  ) =>
    metadataEventFromTerminalEvent(event).pipe(
      Effect.flatMap((metadataEvent) => (metadataEvent ? listener(metadataEvent) : Effect.void)),
    );

  const subscribeMetadata: TerminalManager["Service"]["subscribeMetadata"] = (listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;

      unsubscribe = yield* subscribe((event) => {
        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        return offerMetadataEvent(listener, event);
      });

      const terminals = yield* readAllTerminalMetadata();
      yield* listener({
        type: "snapshot",
        terminals,
      });

      for (const event of bufferedEvents) {
        yield* offerMetadataEvent(listener, event);
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const projectError = (
    operation: "spawn" | "list" | "read" | "write" | "resize" | "kill" | "close",
    reason:
      | "unavailable"
      | "invalid-cwd"
      | "launch-failed"
      | "not-running"
      | "write-failed"
      | "resize-failed"
      | "kill-failed"
      | "cleanup-failed"
      | "invalid-cursor"
      | "invalid-search-cursor"
      | "invalid-budget",
    handle: Pick<ProjectTerminalHandle, "projectId"> & { terminalId?: string },
  ) =>
    new TerminalToolError({
      operation,
      reason,
      projectId: handle.projectId,
      ...(handle.terminalId !== undefined ? { terminalId: handle.terminalId } : {}),
    });

  const removeProjectSession = Effect.fn("terminal.removeProjectSession")(function* (
    target: TerminalTarget,
    sequence: number,
    operation: "spawn" | "kill" | "close" = "close",
  ) {
    if (target.owner.kind !== "project") return;
    const projectId = target.owner.projectId;
    const key = terminalTargetKey(target);
    yield* flushPersistTarget(target);
    yield* deleteHistoryForTarget(target).pipe(
      Effect.mapError(() =>
        projectError(operation, "cleanup-failed", {
          projectId,
          terminalId: target.terminalId,
        }),
      ),
    );
    const removed = yield* modifyManagerState((state) => {
      if (!state.sessions.has(key)) return [false, state] as const;
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [true, { ...state, sessions }] as const;
    });
    if (!removed) return;
    yield* publishProjectEvent({ type: "closed", target, sequence });
  });

  const awaitProjectTerminalExit = Effect.fn("terminal.awaitProjectTerminalExit")(function* (
    session: TerminalSessionState,
    operation: "kill" | "close",
  ) {
    const target = terminalTargetOf(session);
    if (target.owner.kind !== "project") return;
    const handle = { projectId: target.owner.projectId, terminalId: session.terminalId };

    if (session.killFailure) {
      return yield* projectError(operation, "kill-failed", handle);
    }

    const process = session.process;
    if (process && session.status === "stopping") {
      const killFiber = yield* readManagerState.pipe(
        Effect.map((state) => Option.fromNullishOr(state.killFibers.get(process))),
      );
      if (Option.isSome(killFiber)) {
        const killExit = yield* Fiber.await(killFiber.value);
        if (Exit.isFailure(killExit)) {
          const killFailure = Cause.findErrorOption(killExit.cause);
          if (Option.isSome(killFailure)) {
            session.killFailure = killFailure.value;
            return yield* projectError(operation, "kill-failed", handle);
          }
          if (session.process !== null) {
            return yield* projectError(operation, "kill-failed", handle);
          }
        }
      }
      if (session.killFailure) {
        return yield* projectError(operation, "kill-failed", handle);
      }
    }

    if (session.exitFinalized) {
      yield* Deferred.await(session.exitFinalized);
    }
  });

  const createProject: TerminalManager["Service"]["createProject"] = (input) =>
    withOwnerLock(
      { kind: "project", projectId: input.projectId },
      Effect.gen(function* () {
        if (projectCloseInFlight.has(input.projectId)) {
          return yield* projectError("spawn", "unavailable", input);
        }
        const target = projectTerminalTarget(input.projectId, input.terminalId);
        const existing = yield* getSessionByTarget(target);
        if (Option.isSome(existing)) {
          return yield* projectError("spawn", "unavailable", input);
        }

        const resolvedInput = yield* resolveLaunchInputEnvironment(input).pipe(
          Effect.mapError(() => projectError("spawn", "launch-failed", input)),
        );
        yield* assertValidCwd(resolvedInput.cwd).pipe(
          Effect.mapError(() => projectError("spawn", "invalid-cwd", input)),
        );

        const history = new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit);
        const session: TerminalSessionState = {
          owner: target.owner,
          terminalId: input.terminalId,
          creatingThreadId: input.creatingThreadId,
          title: input.title ?? null,
          command: input.command ?? null,
          args: [...(input.args ?? [])],
          cwd: resolvedInput.cwd,
          worktreePath: null,
          status: "starting",
          pid: null,
          history,
          pendingHistoryControlSequence: "",
          pendingProcessEvents: [],
          pendingProcessEventIndex: 0,
          processEventDrainRunning: false,
          exitCode: null,
          exitSignal: null,
          updatedAt: yield* nowIso,
          eventSequence: 0,
          cols: resolvedInput.cols ?? DEFAULT_OPEN_COLS,
          rows: resolvedInput.rows ?? DEFAULT_OPEN_ROWS,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          childCommandLabel: null,
          runtimeEnv: normalizedRuntimeEnv(resolvedInput.env),
          terminationRequested: false,
          cleanupAfterExit: false,
          exitFinalized: null,
          exitHistoryPersisted: false,
          killFailure: null,
        };

        yield* deleteHistoryForTarget(target).pipe(
          Effect.mapError(() => projectError("spawn", "cleanup-failed", input)),
        );
        yield* modifyManagerState((state) => {
          const sessions = new Map(state.sessions);
          sessions.set(terminalTargetKey(target), session);
          return [undefined, { ...state, sessions }] as const;
        });
        yield* evictInactiveSessionsIfNeeded();

        const launchFailed = yield* Effect.uninterruptible(
          startSession(
            session,
            {
              cwd: resolvedInput.cwd,
              cols: session.cols,
              rows: session.rows,
              ...(resolvedInput.env ? { env: resolvedInput.env } : {}),
              ...(resolvedInput.command !== undefined ? { command: resolvedInput.command } : {}),
              ...(resolvedInput.args !== undefined ? { args: resolvedInput.args } : {}),
            },
            "started",
          ),
        );
        if (launchFailed) {
          yield* removeProjectSession(target, session.eventSequence + 1, "spawn");
          return yield* projectError("spawn", "launch-failed", input);
        }
        return projectSummary(session);
      }),
    );

  const listProject: TerminalManager["Service"]["listProject"] = (projectId) =>
    readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()]
          .filter(
            (session) => session.owner.kind === "project" && session.owner.projectId === projectId,
          )
          .toSorted(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) ||
              left.terminalId.localeCompare(right.terminalId),
          )
          .map(projectSummary),
      ),
    );

  const readProject: TerminalManager["Service"]["readProject"] = (input) =>
    Effect.gen(function* () {
      const target = projectTerminalTarget(input.projectId, input.terminalId);
      const sessionOption = yield* getSessionByTarget(target);
      if (Option.isNone(sessionOption)) {
        return yield* projectError("read", "unavailable", input);
      }
      const session = sessionOption.value;
      const history = session.history;
      const mode = input.search === undefined ? "stream" : "search";
      const invalidCursorReason = mode === "search" ? "invalid-search-cursor" : "invalid-cursor";
      const maxBytes = input.maxBytes ?? 16_384;
      let position = history.startPosition;

      if (input.cursor !== undefined) {
        const cursorOption = decodeTerminalReadCursor(input.cursor);
        if (Option.isNone(cursorOption)) {
          return yield* projectError("read", invalidCursorReason, input);
        }
        const cursor = cursorOption.value;
        const cursorFailureReason =
          cursor.mode === "search" || mode === "search"
            ? "invalid-search-cursor"
            : "invalid-cursor";
        if (
          cursor.version !== 1 ||
          cursor.projectId !== input.projectId ||
          cursor.terminalId !== input.terminalId ||
          cursor.generation !== history.generation
        ) {
          return yield* projectError("read", cursorFailureReason, input);
        }
        if (cursor.mode !== mode) {
          return yield* projectError("read", cursorFailureReason, input);
        }
        if (mode === "search") {
          const search = input.search!;
          if (
            cursor.searchText !== search.text ||
            cursor.ignoreCase !== (search.ignoreCase ?? false)
          ) {
            return yield* projectError("read", "invalid-search-cursor", input);
          }
        } else if (cursor.searchText !== undefined || cursor.ignoreCase !== undefined) {
          return yield* projectError("read", "invalid-cursor", input);
        }
        position = cursor.position;
      }

      const terminal = projectSummary(session);
      if (input.tailLines !== undefined) {
        const tail = history.tail(input.tailLines, maxBytes);
        if (tail.kind === "invalid-budget") {
          return yield* projectError("read", "invalid-budget", input);
        }
        if (tail.kind === "invalid-position") {
          return yield* projectError("read", "invalid-cursor", input);
        }
        return {
          kind: "stream" as const,
          terminal,
          output: tail.output,
          nextCursor: encodeTerminalReadCursor({
            version: 1,
            projectId: input.projectId,
            terminalId: input.terminalId,
            generation: history.generation,
            mode: "stream",
            position: tail.nextPosition,
          }),
          hasMore: tail.hasMore,
          truncated: tail.truncated,
        };
      }

      if (mode === "search") {
        const search = input.search!;
        const searched = searchTerminalOutput(history, {
          position,
          text: search.text,
          ignoreCase: search.ignoreCase ?? false,
          maxBytes,
        });
        if (searched.kind === "invalid-budget") {
          return yield* projectError("read", "invalid-budget", input);
        }
        if (searched.kind === "invalid-position") {
          return yield* projectError("read", "invalid-search-cursor", input);
        }
        return {
          kind: "search" as const,
          terminal,
          matches: [...searched.matches],
          nextCursor: encodeTerminalReadCursor({
            version: 1,
            projectId: input.projectId,
            terminalId: input.terminalId,
            generation: history.generation,
            mode: "search",
            position: searched.nextPosition,
            searchText: search.text,
            ignoreCase: search.ignoreCase ?? false,
          }),
          hasMore: searched.hasMore,
          truncated:
            searched.truncated || (input.cursor === undefined && history.startPosition > 0),
        };
      }

      const read = history.read(position, maxBytes);
      if (read.kind === "invalid-budget") {
        return yield* projectError("read", "invalid-budget", input);
      }
      if (read.kind === "invalid-position") {
        return yield* projectError("read", "invalid-cursor", input);
      }
      return {
        kind: "stream" as const,
        terminal,
        output: read.output,
        nextCursor: encodeTerminalReadCursor({
          version: 1,
          projectId: input.projectId,
          terminalId: input.terminalId,
          generation: history.generation,
          mode: "stream",
          position: read.nextPosition,
        }),
        hasMore: read.hasMore,
        truncated: read.truncated || (input.cursor === undefined && history.startPosition > 0),
      };
    });

  const writeProject: TerminalManager["Service"]["writeProject"] = (input) =>
    withOwnerLock(
      { kind: "project", projectId: input.projectId },
      Effect.gen(function* () {
        const target = projectTerminalTarget(input.projectId, input.terminalId);
        const session = yield* getSessionByTarget(target);
        if (Option.isNone(session)) {
          return yield* projectError("write", "unavailable", input);
        }
        const process = session.value.process;
        if (!process || session.value.status !== "running") {
          return yield* projectError("write", "not-running", input);
        }
        yield* Effect.try({
          try: () => process.write(input.data),
          catch: () => projectError("write", "write-failed", input),
        });
      }),
    );

  const resizeProject: TerminalManager["Service"]["resizeProject"] = (input) =>
    withOwnerLock(
      { kind: "project", projectId: input.projectId },
      Effect.gen(function* () {
        const target = projectTerminalTarget(input.projectId, input.terminalId);
        const session = yield* getSessionByTarget(target);
        if (Option.isNone(session)) {
          return yield* projectError("resize", "unavailable", input);
        }
        const process = session.value.process;
        if (!process || session.value.status !== "running") {
          return yield* projectError("resize", "not-running", input);
        }
        yield* Effect.try({
          try: () => process.resize(input.cols, input.rows),
          catch: () => projectError("resize", "resize-failed", input),
        });
        session.value.cols = input.cols;
        session.value.rows = input.rows;
        session.value.updatedAt = yield* nowIso;
      }),
    );

  const killProjectTerminal: TerminalManager["Service"]["killProjectTerminal"] = (input) =>
    Effect.gen(function* () {
      const target = projectTerminalTarget(input.projectId, input.terminalId);
      const owner = target.owner;
      if (owner.kind !== "project") return;

      const cleanupSession = yield* withOwnerLock(
        owner,
        Effect.gen(function* () {
          const sessionOption = yield* getSessionByTarget(target);
          if (Option.isNone(sessionOption)) {
            return yield* projectError("kill", "unavailable", input);
          }
          const session = sessionOption.value;
          const process = session.process;
          if (!process || (session.status !== "running" && session.status !== "stopping")) {
            if (input.cleanup === true) {
              if (session.exitFinalized && !session.exitHistoryPersisted) {
                return session;
              }
              yield* removeProjectSession(target, session.eventSequence + 1, "kill");
            }
            return null;
          }

          if (input.cleanup === true && session.exitFinalized === null) {
            return yield* projectError("kill", "kill-failed", input);
          }

          if (session.status === "stopping") {
            session.cleanupAfterExit ||= input.cleanup === true;
            if (session.killFailure) {
              yield* awaitKillFiber(process);
              session.killFailure = null;
            }
            yield* startKillEscalation(process, target, true);
            return input.cleanup === true ? session : null;
          }

          session.status = "stopping";
          session.terminationRequested = true;
          session.cleanupAfterExit = input.cleanup === true;
          advanceEventSequence(session);
          yield* Effect.try({
            try: () => process.kill("SIGTERM"),
            catch: () => {
              session.status = "running";
              session.terminationRequested = false;
              session.cleanupAfterExit = false;
              return projectError("kill", "kill-failed", input);
            },
          });
          yield* startKillEscalation(process, target, true);
          return input.cleanup === true ? session : null;
        }),
      );

      if (cleanupSession) {
        // Wait outside the owner lock so exit subscribers can perform their own cleanup.
        yield* awaitProjectTerminalExit(cleanupSession, "kill");
        yield* withOwnerLock(
          owner,
          Effect.gen(function* () {
            const session = yield* getSessionByTarget(target);
            if (Option.isNone(session)) return;
            yield* removeProjectSession(target, session.value.eventSequence + 1, "kill");
          }),
        );
      }
    });

  const requestProjectCloseSession = Effect.fn("terminal.requestProjectCloseSession")(function* (
    session: TerminalSessionState,
  ) {
    const target = terminalTargetOf(session);
    if (target.owner.kind !== "project") return;
    const handle = { projectId: target.owner.projectId, terminalId: session.terminalId };
    const process = session.process;

    if (process && (session.status === "running" || session.status === "stopping")) {
      const exitFinalized = session.exitFinalized;
      if (!exitFinalized) {
        return yield* projectError("close", "kill-failed", handle);
      }
      if (session.killFailure) {
        yield* awaitKillFiber(process);
        session.killFailure = null;
      }

      if (session.status === "running") {
        session.status = "stopping";
        session.terminationRequested = true;
        session.cleanupAfterExit = true;
        advanceEventSequence(session);
        yield* Effect.try({
          try: () => process.kill("SIGTERM"),
          catch: () => {
            session.status = "running";
            session.terminationRequested = false;
            session.cleanupAfterExit = false;
            return projectError("close", "kill-failed", handle);
          },
        });
      } else {
        session.cleanupAfterExit = true;
      }
      yield* startKillEscalation(process, target, true);
    }
  });

  const closeProjectSession = Effect.fn("terminal.closeProjectSession")(function* (
    session: TerminalSessionState,
  ) {
    const target = terminalTargetOf(session);
    if (target.owner.kind !== "project") return;
    yield* awaitProjectTerminalExit(session, "close");
    yield* removeProjectSession(target, session.eventSequence + 1, "close");
  });

  const closeProject: TerminalManager["Service"]["closeProject"] = (projectId) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const owner = {
          kind: "project",
          projectId: projectId as ProjectTerminalHandle["projectId"],
        } as const;
        const projectHandleId = owner.projectId;
        const admission = yield* withOwnerLock(
          owner,
          Effect.gen(function* () {
            const existing = projectCloseInFlight.get(projectId);
            if (existing) return { _tag: "existing", completion: existing } as const;

            const completion = yield* Deferred.make<Exit.Exit<void, TerminalToolError>>();
            projectCloseInFlight.set(projectId, completion);
            const sessions = yield* readManagerState.pipe(
              Effect.map((state) =>
                [...state.sessions.values()].filter(
                  (session) =>
                    session.owner.kind === "project" && session.owner.projectId === projectId,
                ),
              ),
            );
            const startResult = yield* Effect.exit(
              Effect.forEach(sessions, requestProjectCloseSession, {
                concurrency: "unbounded",
                discard: true,
              }),
            );
            if (Exit.isFailure(startResult)) {
              projectCloseInFlight.delete(projectId);
              yield* Deferred.succeed(completion, startResult).pipe(Effect.asVoid);
              return { _tag: "existing", completion } as const;
            }
            return { _tag: "owner", completion, sessions } as const;
          }),
        );

        if (admission._tag === "existing") {
          const result = yield* restore(Deferred.await(admission.completion));
          if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
          return result.value;
        }

        const result = yield* restore(
          Effect.gen(function* () {
            for (const session of admission.sessions) {
              yield* closeProjectSession(session);
            }
            yield* fileSystem
              .remove(projectHistoryDirectory(projectId), { recursive: true, force: true })
              .pipe(
                Effect.mapError(() =>
                  projectError("close", "cleanup-failed", { projectId: projectHandleId }),
                ),
              );
          }),
        ).pipe(Effect.exit);

        yield* withOwnerLock(
          owner,
          Effect.sync(() => {
            if (projectCloseInFlight.get(projectId) === admission.completion) {
              projectCloseInFlight.delete(projectId);
            }
          }),
        );
        yield* Deferred.succeed(admission.completion, result).pipe(Effect.asVoid);
        if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
        return result.value;
      }),
    );

  const write: TerminalManager["Service"]["write"] = Effect.fn("terminal.write")(function* (input) {
    const terminalId = input.terminalId;
    const session = yield* requireSession(input.threadId, terminalId);
    const process = session.process;
    if (!process || session.status !== "running") {
      if (session.status === "exited") return;
      return yield* new TerminalNotRunningError({
        threadId: input.threadId,
        terminalId,
      });
    }
    yield* Effect.try({
      try: () => process.write(input.data),
      catch: (cause) =>
        new TerminalWriteError({
          threadId: input.threadId,
          terminalId,
          terminalPid: process.pid,
          cause,
        }),
    });
  });

  const resizeLocked = Effect.fn("terminal.resize")(function* (input: TerminalResizeInput) {
    const session = yield* getSession(input.threadId, input.terminalId);
    // ResizeObserver traffic can already be in flight when the UI closes the session.
    if (Option.isNone(session)) {
      return;
    }
    const process = session.value.process;
    if (!process || session.value.status !== "running") {
      return;
    }
    yield* resizePtyProcess(session.value, process, input.cols, input.rows);
    session.value.cols = input.cols;
    session.value.rows = input.rows;
    session.value.updatedAt = yield* nowIso;
  });

  const resize: TerminalManager["Service"]["resize"] = (input) =>
    withThreadLock(input.threadId, resizeLocked(input));

  const clear: TerminalManager["Service"]["clear"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const session = yield* requireSession(input.threadId, terminalId);
        session.history.clear();
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        const eventStamp = advanceEventSequence(session);
        yield* persistHistory(input.threadId, terminalId, session.history);
        yield* publishEvent({
          type: "cleared",
          threadId: input.threadId,
          terminalId,
          sequence: eventStamp.sequence,
        });
      }),
    );

  const restartResolved = (input: TerminalRestartInput) =>
    Effect.gen(function* () {
      yield* increment(terminalRestartsTotal, { scope: "thread" });
      const terminalId = input.terminalId;
      yield* assertValidCwd(input.cwd);

      const sessionKey = toSessionKey(input.threadId, terminalId);
      const existingSession = yield* getSession(input.threadId, terminalId);
      let session: TerminalSessionState;
      if (Option.isNone(existingSession)) {
        const cols = input.cols ?? DEFAULT_OPEN_COLS;
        const rows = input.rows ?? DEFAULT_OPEN_ROWS;
        session = {
          owner: { kind: "thread", threadId: input.threadId },
          terminalId,
          creatingThreadId: null,
          title: null,
          command: null,
          args: [],
          cwd: input.cwd,
          worktreePath: input.worktreePath ?? null,
          status: "starting",
          pid: null,
          history: new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit),
          pendingHistoryControlSequence: "",
          pendingProcessEvents: [],
          pendingProcessEventIndex: 0,
          processEventDrainRunning: false,
          exitCode: null,
          exitSignal: null,
          updatedAt: yield* nowIso,
          eventSequence: 0,
          cols,
          rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          childCommandLabel: null,
          runtimeEnv: normalizedRuntimeEnv(input.env),
          terminationRequested: false,
          cleanupAfterExit: false,
          exitFinalized: null,
          exitHistoryPersisted: false,
          killFailure: null,
        };
        const createdSession = session;
        yield* modifyManagerState((state) => {
          const sessions = new Map(state.sessions);
          sessions.set(sessionKey, createdSession);
          return [undefined, { ...state, sessions }] as const;
        });
        yield* evictInactiveSessionsIfNeeded();
      } else {
        session = existingSession.value;
        yield* stopProcess(session);
        session.cwd = input.cwd;
        session.worktreePath = input.worktreePath ?? null;
        session.runtimeEnv = normalizedRuntimeEnv(input.env);
      }

      const cols = input.cols ?? session.cols;
      const rows = input.rows ?? session.rows;

      session.history.clear();
      session.pendingHistoryControlSequence = "";
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      yield* persistHistory(input.threadId, terminalId, session.history);
      yield* startSession(
        session,
        {
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          cols,
          rows,
          ...(input.env ? { env: input.env } : {}),
        },
        "restarted",
      );
      return snapshot(session);
    });

  const restart: TerminalManager["Service"]["restart"] = (input) =>
    withThreadLock(
      input.threadId,
      resolveLaunchInputEnvironment(input).pipe(Effect.flatMap(restartResolved)),
    );

  const close: TerminalManager["Service"]["close"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.terminalId) {
          yield* closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
          return;
        }

        const threadSessions = yield* sessionsForThread(input.threadId);
        yield* Effect.forEach(
          threadSessions,
          (session) => closeSession(input.threadId, session.terminalId, false),
          { discard: true },
        );

        if (input.deleteHistory) {
          yield* deleteAllHistoryForThread(input.threadId);
        }
      }),
    );

  return TerminalManager.of({
    open,
    attachStream,
    write,
    resize,
    clear,
    restart,
    close,
    subscribe,
    subscribeMetadata,
    createProject,
    listProject,
    readProject,
    writeProject,
    resizeProject,
    killProjectTerminal,
    closeProject,
    subscribeProjectEvents,
    subscribeProjectTerminal,
  });
});

export const layer = Layer.effect(TerminalManager, make()).pipe(Layer.provide(ProcessRunner.layer));
