import * as Equal from "effect/Equal";
import { renderCodexDirectivesForCopy } from "@t3tools/client-runtime/codex-markdown-directives";
import {
  formatDuration,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import {
  type MessageId,
  type OrchestrationLatestTurn,
  type OrchestrationTurnSummary,
  type TurnId,
} from "@t3tools/contracts";
import { countTurnWork, type TurnWorkCounts } from "@t3tools/shared/turnWorkCounts";

export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export function workEntryIsVisibleInGroup(
  entry: WorkLogEntry,
  expandedToolGroupEntry = false,
): boolean {
  return (
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === "inProgress" ||
        entry.sourceActivityKind === "task.progress")) ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
}

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/**
 * Follow re-arm band above the hard bottom. Strict on purpose: LegendList's
 * isNearEnd fires within half a viewport, which re-armed live-follow while the
 * user was reading history and yanked them back down on the next stream chunk.
 * A small pixel band (instead of the 1px isAtEnd epsilon alone) keeps re-arming
 * reliable while streaming content is still growing under the viewport.
 */
export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function resolveTimelineIsAtEnd(
  state: TimelineEndState | undefined,
  endInset = 0,
): boolean | undefined {
  if (!state) {
    return undefined;
  }
  if (state.isAtEnd) {
    return true;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  // contentLength includes the end inset (composer overlay), so subtract it to
  // measure the distance to the real content bottom.
  return contentLength - scroll - scrollLength - endInset <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)/mu.test(text);
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

export const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom or a
 * narrow pane. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

/**
 * A settled turn's own record. Counts are stamped by the server when the turn
 * settles, so they stay correct after the activity rows behind them age out.
 */
export type TimelineTurnSummary = Pick<
  OrchestrationTurnSummary,
  "turnId" | "state" | "startedAt" | "completedAt" | "counts"
> &
  // The turn footer reads provenance straight off the record, matched to its
  // terminal assistant message.
  Partial<Pick<OrchestrationTurnSummary, "assistantMessageId" | "model" | "effort">>;

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      isExpandedToolGroupEntry: boolean;
      isLastExpandedToolGroupEntry: boolean;
    }
  | {
      kind: "work-live";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      groupedEntries: WorkLogEntry[];
      groupId: string;
      expanded: boolean;
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      summary: string;
      summaryKind: ToolGroupSummaryKind;
      hasFailure: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: TurnId;
      label: string;
      /** Per-work-group summaries between assistant messages, in order. */
      subfoldLabels: ReadonlyArray<string>;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      showThinking: boolean;
      /**
       * Names the tool currently running, or a stable per-turn fallback phrase
       * when nothing specific is identifiable. Only rendered when `showThinking`.
       */
      statusLabel: string;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

type ToolGroupAction = "read" | "edit" | "command" | "code-search" | "search" | "other" | "update";
type ToolGroupSummaryKind = ToolGroupAction | "dynamic-tool" | "agent-tool" | "tone-tool" | "mixed";

export function workLogEntryIsLocalCodeSearch(entry: WorkLogEntry): boolean {
  return (
    entry.itemType === "web_search" &&
    /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label))
  );
}

export function toolGroupAction(entry: WorkLogEntry): ToolGroupAction {
  if (
    entry.requestKind === "file-read" ||
    entry.itemType === "image_view" ||
    (entry.itemType === "dynamic_tool_call" && entry.toolTitle === "Read File")
  ) {
    return "read";
  }
  if (
    entry.requestKind === "file-change" ||
    entry.itemType === "file_change" ||
    (entry.changedFiles?.length ?? 0) > 0
  ) {
    return "edit";
  }
  if (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (workLogEntryIsLocalCodeSearch(entry)) return "code-search";
  if (entry.itemType === "web_search") return "search";
  return workLogEntryIsToolLike(entry) ? "other" : "update";
}

function toolGroupActionCount(
  action: ToolGroupAction,
  entries: ReadonlyArray<WorkLogEntry>,
): number {
  if (action !== "edit") return entries.length;

  const changedFiles = new Set<string>();
  let editsWithoutFileDetails = 0;
  for (const entry of entries) {
    if (!entry.changedFiles || entry.changedFiles.length === 0) {
      editsWithoutFileDetails += 1;
      continue;
    }
    for (const file of entry.changedFiles) changedFiles.add(file);
  }
  return changedFiles.size + editsWithoutFileDetails;
}

function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Changed ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "search":
      return `Searched the web ${count} ${count === 1 ? "time" : "times"}`;
    case "code-search":
      return `Searched code ${count} ${count === 1 ? "time" : "times"}`;
    case "other":
      return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
    case "update":
      return `Received ${count} ${count === 1 ? "update" : "updates"}`;
  }
}

/** Immediate, provider-neutral fallback while generated tool summaries are disabled or unavailable. */
export function summarizeToolGroup(entries: ReadonlyArray<WorkLogEntry>): string {
  const summaryEntries = omitSupersededLifecycleMarkers(entries, (entry) => entry);
  const groupedEntries = new Map<ToolGroupAction, WorkLogEntry[]>();
  for (const entry of summaryEntries) {
    const action = toolGroupAction(entry);
    const group = groupedEntries.get(action);
    if (group) group.push(entry);
    else groupedEntries.set(action, [entry]);
  }
  const labels = [...groupedEntries].map(([action, actionEntries]) =>
    toolGroupActionLabel(action, toolGroupActionCount(action, actionEntries)),
  );
  const sentenceLabels = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  if (sentenceLabels.length < 2) return sentenceLabels[0] ?? "";
  if (sentenceLabels.length === 2) return sentenceLabels.join(" and ");
  return `${sentenceLabels.slice(0, -1).join(", ")}, and ${sentenceLabels.at(-1)}`;
}

function omitSupersededLifecycleMarkers<T>(
  entries: readonly T[],
  workEntryFor: (entry: T) => WorkLogEntry,
): T[] {
  const laterTerminalIdentities = new Set<string>();
  const reversedEntries: T[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const workEntry = workEntryFor(entry);
    const normalizedLabel = normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label);
    const identity = [
      workEntry.turnId ?? "no-turn",
      workEntry.itemType ?? "",
      normalizedLabel,
    ].join("\u001f");
    const isStatuslessIdlessMarker =
      workEntry.toolCallId === undefined &&
      workEntry.toolLifecycleStatus === undefined &&
      (workEntry.sourceActivityKind === "tool.started" ||
        workEntry.sourceActivityKind === "tool.updated");
    if (isStatuslessIdlessMarker && laterTerminalIdentities.has(identity)) continue;

    reversedEntries.push(entry);
    if (
      workEntry.sourceActivityKind === "tool.completed" ||
      (workEntry.toolLifecycleStatus !== undefined &&
        workEntry.toolLifecycleStatus !== "inProgress")
    ) {
      laterTerminalIdentities.add(identity);
    }
  }

  return reversedEntries.toReversed();
}

function toolGroupSummaryKind(entries: ReadonlyArray<WorkLogEntry>): ToolGroupSummaryKind {
  const actions = new Set(entries.map(toolGroupAction));
  if (actions.size !== 1) return "mixed";

  const action = actions.values().next().value!;
  if (action !== "other") return action;

  const fallbackKinds = new Set(
    entries.map((entry): ToolGroupSummaryKind => {
      if (entry.itemType === "mcp_tool_call") return "other";
      if (entry.itemType === "dynamic_tool_call") return "dynamic-tool";
      if (entry.itemType === "collab_agent_tool_call" || entry.taskId) return "agent-tool";
      if (entry.tone === "thinking") return "agent-tool";
      if (entry.tone === "tool") return "tone-tool";
      return "other";
    }),
  );
  return fallbackKinds.size === 1 ? fallbackKinds.values().next().value! : "mixed";
}

function workGroupIdentity(timelineEntryId: string, entry: WorkLogEntry): string {
  return entry.toolCallId
    ? `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}`
    : timelineEntryId;
}

function workGroupId(timelineEntryId: string, entry: WorkLogEntry): string {
  return `work-group:${workGroupIdentity(timelineEntryId, entry)}`;
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  const visible = showCopyButton && hasText && !streaming;
  return {
    text: hasText ? (visible ? renderCodexDirectivesForCopy(text) : text) : null,
    visible,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface TurnFold {
  turnId: TurnId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
  /**
   * One label per contiguous run of work between assistant messages, in order.
   * Same vocabulary as the turn label but without a duration. Rendering is
   * owned by the timeline component; this is the derived data behind it.
   */
  subfoldLabels: ReadonlyArray<string>;
}

function pluralizeWorkSegment(count: number, singular: string, plural: string): string | null {
  if (count <= 0) {
    return null;
  }
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * The shared count vocabulary, in a fixed order so a turn label and its
 * subfolds always read the same way.
 */
function workCountSegments(counts: TurnWorkCounts): string[] {
  return [
    pluralizeWorkSegment(counts.commandCount, "Command", "Commands"),
    pluralizeWorkSegment(counts.toolCallCount, "Tool Call", "Tool Calls"),
    pluralizeWorkSegment(counts.subagentCount, "Subagent", "Subagents"),
  ].filter((segment): segment is string => segment !== null);
}

/**
 * Changed files read from the turn's checkpoint. The `+N/−M` diff is suppressed
 * unless the checkpoint is `ready`, because a pending or missing checkpoint has
 * no trustworthy line counts — but the file count still describes the turn.
 */
function changedFileSegment(
  changedFileCount: number,
  diff: { additions: number; deletions: number } | null,
): string | null {
  const fileSegment = pluralizeWorkSegment(changedFileCount, "Changed File", "Changed Files");
  if (fileSegment === null) {
    return null;
  }
  return diff === null ? fileSegment : `${fileSegment} +${diff.additions}/−${diff.deletions}`;
}

function collectTurnWorkActivities(
  entries: ReadonlyArray<TimelineEntry>,
): Array<{ tone: string; itemType?: string | null; toolCallId?: string | null }> {
  const activities: Array<{ tone: string; itemType?: string | null; toolCallId?: string | null }> =
    [];
  for (const entry of entries) {
    if (entry.kind !== "work") {
      continue;
    }
    activities.push({
      tone: entry.entry.tone,
      itemType: entry.entry.itemType ?? null,
      toolCallId: entry.entry.toolCallId ?? null,
    });
  }
  return activities;
}

/**
 * The session's running turn is authoritative when latestTurn briefly lags or
 * regresses behind it. Otherwise, the latest turn counts as unsettled while it
 * is still running (or has not recorded a completion). This is deliberately
 * keyed on turn lifecycle rather than transient working state: right after the
 * user sends a message, the previous turn is still the "active" one until the
 * server creates the new turn, and folding must not flicker through that window.
 */
function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

function lastUserMessageIndex(timelineEntries: ReadonlyArray<TimelineEntry>): number {
  return timelineEntries.findLastIndex(
    (entry) => entry.kind === "message" && entry.message.role === "user",
  );
}

function timelineEntryTurnId(entry: TimelineEntry): TurnId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.turnId ?? null) : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.turnId;
  }
  return entry.kind === "work" ? (entry.entry.turnId ?? null) : null;
}

/**
 * Settled turns keep only their terminal assistant message visible.
 * Everything before it folds behind a "Worked for ..." row anchored at the
 * first hidden entry, so the duration leads directly into the final response.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
  turns?: ReadonlyArray<TimelineTurnSummary> | undefined;
  oldestRetainedActivityAt?: string | null | undefined;
  checkpointsByTurnId?: ReadonlyMap<TurnId, TurnDiffSummary> | undefined;
}): ReadonlyMap<string, TurnFold> {
  const turnSummaryById = new Map<TurnId, TimelineTurnSummary>();
  for (const summary of input.turns ?? []) {
    turnSummaryById.set(summary.turnId, summary);
  }
  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * The user message that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>();

  let pendingUserBoundary: string | null = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId =
      entry.kind === "message" && entry.message.role === "assistant"
        ? (entry.message.turnId ?? null)
        : entry.kind === "work"
          ? (entry.entry.turnId ?? null)
          : null;
    if (!turnId) {
      continue;
    }
    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [turnId, group] of groupsByTurnId) {
    if (turnId === input.unsettledTurnId) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    for (const entry of group.entries) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      // Agent-spawn CTA rows never fold: workflows outlive their launching
      // turn (dynamic spawns, background execution), and folding the CTA
      // when the turn settles makes a still-running fleet invisible.
      if (entry.kind === "work" && entry.entry.agentSpawn !== undefined) {
        continue;
      }
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = group.entries[0];
    const firstHiddenEntry = group.entries.find((entry) => hiddenEntryIds.has(entry.id));
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !firstHiddenEntry || !lastEntry) {
      continue;
    }

    const turnSummary = turnSummaryById.get(turnId);
    // Per-turn state, so a turn that was interrupted keeps its styling once it
    // is no longer the latest turn. `latestTurn` is the fallback for threads
    // delivered without a `turns[]` record.
    const isInterruptedTurn =
      turnSummary !== undefined
        ? turnSummary.state === "interrupted"
        : input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      input.latestTurn?.turnId === turnId &&
      input.latestTurn.startedAt &&
      input.latestTurn.completedAt
        ? computeElapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const durationPhrase = isInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    // Stamped counts win for a settled turn: they were computed when every
    // activity row still existed. Without a stamp the client may only derive
    // counts when it can see the turn's whole history — activities are capped
    // per thread, so a turn that began before the oldest retained row would
    // otherwise render a count that silently undercounts the work.
    const stampedCounts = turnSummary?.counts;
    const turnStartedAt = turnSummary?.startedAt ?? group.startBoundary;
    const activitiesMayHaveAgedOut =
      input.oldestRetainedActivityAt != null &&
      turnStartedAt != null &&
      turnStartedAt < input.oldestRetainedActivityAt;

    const derivedCounts = countTurnWork(collectTurnWorkActivities(group.entries));
    const counts: TurnWorkCounts | null =
      stampedCounts ?? (activitiesMayHaveAgedOut ? null : derivedCounts);

    const checkpoint = input.checkpointsByTurnId?.get(turnId);
    const changedFileCount = stampedCounts?.changedFileCount ?? checkpoint?.files.length ?? 0;
    // Line counts are only trustworthy once the checkpoint is ready; the file
    // count still stands either way.
    const diff =
      checkpoint?.status === "ready"
        ? checkpoint.files.reduce(
            (totals, file) => ({
              additions: totals.additions + file.additions,
              deletions: totals.deletions + file.deletions,
            }),
            { additions: 0, deletions: 0 },
          )
        : null;

    const label = [
      durationPhrase,
      ...(counts === null ? [] : workCountSegments(counts)),
      ...(counts === null ? [] : [changedFileSegment(changedFileCount, diff)]),
    ]
      .filter((segment): segment is string => segment != null && segment.length > 0)
      .join(" · ");

    // Subfolds always derive client-side: they describe runs of rows that are
    // present, so a stamped turn total cannot be split across them.
    const subfoldLabels: string[] = [];
    let pendingSubfoldEntries: TimelineEntry[] = [];
    const flushSubfold = () => {
      if (pendingSubfoldEntries.length === 0) {
        return;
      }
      const segments = workCountSegments(
        countTurnWork(collectTurnWorkActivities(pendingSubfoldEntries)),
      );
      if (segments.length > 0) {
        subfoldLabels.push(segments.join(" · "));
      }
      pendingSubfoldEntries = [];
    };
    for (const entry of group.entries) {
      if (entry.kind === "message" && entry.message.role === "assistant") {
        flushSubfold();
        continue;
      }
      pendingSubfoldEntries.push(entry);
    }
    flushSubfold();

    foldsByAnchorEntryId.set(firstHiddenEntry.id, {
      turnId,
      anchorEntryId: firstHiddenEntry.id,
      createdAt: firstHiddenEntry.createdAt,
      hiddenEntryIds,
      label,
      subfoldLabels,
    });
  }
  return foldsByAnchorEntryId;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn?: TimelineLatestTurn | null;
  turns?: ReadonlyArray<TimelineTurnSummary> | null;
  /**
   * Timestamp of the oldest activity row the thread still retains. Turns that
   * began before it cannot be counted client-side without undercounting.
   */
  oldestRetainedActivityAt?: string | null;
  runningTurnId?: TurnId | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );
  // Checkpoints arrive keyed by assistant message but carry their own turn id.
  const checkpointsByTurnId = new Map<TurnId, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaryByAssistantMessageId.values()) {
    checkpointsByTurnId.set(summary.turnId, summary);
  }
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: input.timelineEntries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
    turns: input.turns ?? undefined,
    oldestRetainedActivityAt: input.oldestRetainedActivityAt ?? null,
    checkpointsByTurnId,
  });
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedTurnIds?.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }

  let activeTurnHeaderIndex = input.timelineEntries.length;
  if (input.isWorking) {
    const latestUserMessageIndex = lastUserMessageIndex(input.timelineEntries);
    const firstOwnedAfterUser =
      unsettledTurnId === null
        ? -1
        : input.timelineEntries.findIndex(
            (entry, index) =>
              index > latestUserMessageIndex && timelineEntryTurnId(entry) === unsettledTurnId,
          );
    activeTurnHeaderIndex =
      firstOwnedAfterUser >= 0 ? firstOwnedAfterUser : latestUserMessageIndex + 1;
  }
  const entryBelongsToActiveTurn = (entry: TimelineEntry, index: number) =>
    input.isWorking &&
    index >= activeTurnHeaderIndex &&
    (unsettledTurnId === null || timelineEntryTurnId(entry) === unsettledTurnId);
  const workEntryIsInActiveRun = (entry: WorkLogEntry) =>
    input.isWorking &&
    unsettledTurnId !== null &&
    entry.toolLifecycleStatus === "inProgress" &&
    entry.turnId === unsettledTurnId;
  const activeEntries = input.isWorking
    ? input.timelineEntries.filter((entry, index) => entryBelongsToActiveTurn(entry, index))
    : [];
  const activeTurnHasVisibleContent = activeEntries.some((entry) => {
    if (entry.kind === "message") {
      return entry.message.role === "assistant" && (entry.message.text?.trim().length ?? 0) > 0;
    }
    if (entry.kind === "work") {
      return (
        entry.entry.agentSpawn === undefined &&
        workLogEntryIsToolLike(entry.entry) &&
        entry.entry.toolLifecycleStatus === "inProgress"
      );
    }
    if (entry.kind === "proposed-plan") return true;
    return false;
  });

  const activeToolEntries: Array<Extract<TimelineEntry, { kind: "work" }>> = [];
  for (let index = input.timelineEntries.length - 1; index >= activeTurnHeaderIndex; index -= 1) {
    const entry = input.timelineEntries[index]!;
    if (
      !entryBelongsToActiveTurn(entry, index) ||
      entry.kind !== "work" ||
      entry.entry.agentSpawn !== undefined ||
      entry.entry.tone === "error"
    ) {
      break;
    }
    activeToolEntries.unshift(entry);
  }
  const activeWorkEntryIds = new Set(activeToolEntries.map((entry) => entry.id));
  const visibleActiveToolEntries = omitSupersededLifecycleMarkers(
    activeToolEntries.filter((entry) => workEntryIsVisibleInGroup(entry.entry, true)),
    (entry) => entry.entry,
  );
  const activeWorkAnchor = activeToolEntries[0];
  const latestActiveToolEntry = visibleActiveToolEntries.at(-1);
  const activeWorkPlacementEntryId = latestActiveToolEntry?.id;
  const activeWorkRow =
    activeWorkAnchor && latestActiveToolEntry
      ? (() => {
          const groupId = workGroupId(activeWorkAnchor.id, activeWorkAnchor.entry);
          return {
            kind: "work-live" as const,
            id: `work-live:${workGroupIdentity(activeWorkAnchor.id, activeWorkAnchor.entry)}`,
            createdAt: activeWorkAnchor.createdAt,
            entry: latestActiveToolEntry.entry,
            groupedEntries: visibleActiveToolEntries.map((entry) => entry.entry),
            groupId,
            expanded: input.expandedWorkGroupIds?.has(groupId) ?? false,
          };
        })()
      : null;
  const appendWorkingRow = () => {
    // Name the tool actually running. The newest active tool entry is used even
    // when it has no visible row of its own, which is exactly the case the old
    // generic "Thinking" label covered up.
    const runningToolPhrase = workingStatusPhrase(activeToolEntries.at(-1)?.entry ?? null);
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
      showThinking: activeWorkRow === null && !activeTurnHasVisibleContent,
      // Falls back to a phrase hashed from the turn so a given turn always shows
      // the same phrase instead of reshuffling across re-renders.
      statusLabel:
        runningToolPhrase ??
        stableFallbackPhrase(unsettledTurnId ?? input.activeTurnStartedAt ?? "working"),
    });
  };
  const appendActiveWorkRows = () => {
    if (activeWorkRow === null) return;
    nextRows.push(activeWorkRow);
    if (!activeWorkRow.expanded) return;
    for (const [entryIndex, workEntry] of activeWorkRow.groupedEntries.entries()) {
      nextRows.push({
        kind: "work",
        id: workEntry.id,
        createdAt: workEntry.createdAt,
        groupedEntries: [workEntry],
        isExpandedToolGroupEntry: true,
        isLastExpandedToolGroupEntry: entryIndex === activeWorkRow.groupedEntries.length - 1,
      });
    }
  };

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (input.isWorking && index === activeTurnHeaderIndex) {
      appendWorkingRow();
    }

    if (timelineEntry.id === activeWorkPlacementEntryId) {
      appendActiveWorkRows();
    }

    const anchoredTurnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (anchoredTurnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${anchoredTurnFold.turnId}`,
        createdAt: anchoredTurnFold.createdAt,
        turnId: anchoredTurnFold.turnId,
        label: anchoredTurnFold.label,
        subfoldLabels: anchoredTurnFold.subfoldLabels,
        expanded: input.expandedTurnIds?.has(anchoredTurnFold.turnId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (activeWorkEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      if (timelineEntry.entry.agentSpawn !== undefined || timelineEntry.entry.tone === "error") {
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [timelineEntry.entry],
          isExpandedToolGroupEntry: false,
          isLastExpandedToolGroupEntry: false,
        });
        continue;
      }
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.agentSpawn !== undefined ||
          nextEntry.entry.tone === "error" ||
          activeWorkEntryIds.has(nextEntry.id) ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = omitSupersededLifecycleMarkers(
        groupedEntries.filter((entry) =>
          workEntryIsVisibleInGroup(entry, workEntryIsInActiveRun(entry)),
        ),
        (entry) => entry,
      );
      if (visibleGroupedEntries.length > 0) {
        const activeInProgressToolEntries = visibleGroupedEntries.filter(workEntryIsInActiveRun);
        if (activeInProgressToolEntries.length > 0) {
          const groupId = workGroupId(timelineEntry.id, timelineEntry.entry);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const latestActiveToolEntry = activeInProgressToolEntries.at(-1)!;
          nextRows.push({
            kind: "work-live",
            id: `work-live:${workGroupIdentity(timelineEntry.id, timelineEntry.entry)}`,
            createdAt: timelineEntry.createdAt,
            entry: latestActiveToolEntry,
            groupedEntries: visibleGroupedEntries,
            groupId,
            expanded,
          });
          if (expanded) {
            for (const [entryIndex, workEntry] of visibleGroupedEntries.entries()) {
              nextRows.push({
                kind: "work",
                id: workEntry.id,
                createdAt: workEntry.createdAt,
                groupedEntries: [workEntry],
                isExpandedToolGroupEntry: true,
                isLastExpandedToolGroupEntry: entryIndex === visibleGroupedEntries.length - 1,
              });
            }
          }
        } else {
          const groupId = workGroupId(timelineEntry.id, timelineEntry.entry);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const summaryKind = toolGroupSummaryKind(visibleGroupedEntries);
          const latestToolEntry = visibleGroupedEntries.findLast(workLogEntryIsToolLike);
          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            groupId,
            hiddenCount: visibleGroupedEntries.length,
            expanded,
            summary:
              visibleGroupedEntries.length === 1 &&
              !workLogEntryIsToolLike(visibleGroupedEntries[0]!)
                ? visibleGroupedEntries[0]!.label
                : summarizeToolGroup(visibleGroupedEntries),
            summaryKind,
            hasFailure:
              latestToolEntry !== undefined &&
              workEntryDisplayIndicatesToolFailure(latestToolEntry),
          });
          if (expanded) {
            for (const [entryIndex, workEntry] of visibleGroupedEntries.entries()) {
              nextRows.push({
                kind: "work",
                id: workEntry.id,
                createdAt: workEntry.createdAt,
                groupedEntries: [workEntry],
                isExpandedToolGroupEntry: true,
                isLastExpandedToolGroupEntry: entryIndex === visibleGroupedEntries.length - 1,
              });
            }
          }
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      unsettledTurnId !== null &&
      timelineEntry.message.turnId === unsettledTurnId;

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantTurnStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  if (input.isWorking && activeTurnHeaderIndex === input.timelineEntries.length) {
    appendWorkingRow();
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return (
        a.createdAt === (b as typeof a).createdAt &&
        a.showThinking === (b as typeof a).showThinking &&
        a.statusLabel === (b as typeof a).statusLabel
      );

    case "turn-fold": {
      const bf = b as typeof a;
      return (
        a.createdAt === bf.createdAt &&
        a.label === bf.label &&
        a.expanded === bf.expanded &&
        a.subfoldLabels.length === bf.subfoldLabels.length &&
        a.subfoldLabels.every((label, index) => label === bf.subfoldLabels[index])
      );
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "work": {
      const bw = b as typeof a;
      return (
        a.isExpandedToolGroupEntry === bw.isExpandedToolGroupEntry &&
        a.isLastExpandedToolGroupEntry === bw.isLastExpandedToolGroupEntry &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-live": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.expanded === bw.expanded &&
        Equal.equals(a.entry, bw.entry) &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.summary === bw.summary &&
        a.summaryKind === bw.summaryKind &&
        a.hasFailure === bw.hasFailure
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}

// ---------------------------------------------------------------------------
// AC-12 — tool-aware working status
//
// The busy row used to say "Thinking" no matter what the agent was doing. These
// helpers name the running tool instead. They are pure so the dwell window and
// the fallback hash are testable without rendering.
// ---------------------------------------------------------------------------

/**
 * Phrases used when no specific tool is identifiable. Picked by a stable hash of
 * a per-message key so a given message always shows the same one.
 */
export const WORKING_FALLBACK_PHRASES = [
  "Thinking",
  "Working",
  "Figuring things out",
  "Piecing it together",
  "Considering the options",
  "Working through it",
] as const;

/**
 * Minimum time a working label stays on screen. Below roughly this window the
 * label reads as a flicker rather than as status.
 */
export const WORKING_STATUS_DWELL_MS = 1200;

/**
 * Names the tool a work entry is running, or `null` when nothing specific is
 * identifiable and the caller should fall back to a stable generic phrase.
 *
 * Keyed on `itemType`. There is no `file_read` item type: read work arrives as a
 * `file-read` request kind or as a dynamic `Read File` tool call, so both are
 * mapped to the read phrase before the `file_change` default of "Editing file".
 */
export function workingStatusPhrase(entry: WorkLogEntry | null | undefined): string | null {
  if (!entry) return null;

  if (entry.requestKind === "file-read") return "Reading file";

  switch (entry.itemType) {
    case "command_execution":
      return "Running command";
    case "file_change":
      return "Editing file";
    case "web_search":
      return workLogEntryIsLocalCodeSearch(entry) ? "Searching code" : "Searching the web";
    case "image_view":
      return "Viewing image";
    case "mcp_tool_call":
      return "Running MCP tool";
    case "collab_agent_tool_call":
      return "Delegating to subagent";
    case "dynamic_tool_call":
      return entry.toolTitle === "Read File" ? "Reading file" : "Running tool";
    default:
      return null;
  }
}

/**
 * Deterministic fallback phrase for a message. The same key always yields the
 * same phrase so re-renders never reshuffle the label.
 */
export function stableFallbackPhrase(messageKey: string): string {
  // FNV-1a: small, stable across runs, and good enough to spread short keys.
  let hash = 0x811c9dc5;
  for (let index = 0; index < messageKey.length; index += 1) {
    hash ^= messageKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return WORKING_FALLBACK_PHRASES[hash % WORKING_FALLBACK_PHRASES.length]!;
}

/**
 * Live-ness comes from the stream phase, never from an absent timestamp: a
 * settled part has no live indicator even when it carries no completion time.
 */
export function workingStatusIsLive(input: {
  isWorking: boolean;
  toolLifecycleStatus?: WorkLogEntry["toolLifecycleStatus"];
}): boolean {
  if (!input.isWorking) return false;
  return input.toolLifecycleStatus === undefined || input.toolLifecycleStatus === "inProgress";
}

export interface WorkingStatusDwell {
  /** The label that should currently render. */
  readonly label: string;
  /** Number of transitions dropped because they arrived inside a dwell window. */
  readonly droppedCount: number;
  /** Offers the newest desired label at `now`; returns the label to render. */
  push: (nextLabel: string, now: number) => string;
}

/**
 * Holds a working label for {@link WORKING_STATUS_DWELL_MS} so fast-changing work
 * does not flicker.
 *
 * A transition offered inside the window is queued rather than applied, and only
 * the most recent queued label survives — intermediate churn is dropped. Once the
 * window elapses the queued label is promoted and the window re-arms, so genuine
 * tool changes still appear in order at dwell cadence.
 */
export function createWorkingStatusDwell(initialLabel: string, now = 0): WorkingStatusDwell {
  let label = initialLabel;
  let shownAt = now;
  const queue: string[] = [];
  let droppedCount = 0;

  const isGeneric = (value: string): boolean =>
    (WORKING_FALLBACK_PHRASES as ReadonlyArray<string>).includes(value);

  /** Queues a transition, collapsing runs of generic churn into nothing. */
  const enqueue = (nextLabel: string) => {
    if (queue.at(-1) === nextLabel) {
      // Same pending label offered again: not a transition, not a drop.
      return;
    }
    if (isGeneric(nextLabel)) {
      // Generic churn never earns a slot of its own while work is in flight;
      // a real tool name already queued outranks it.
      droppedCount += 1;
      if (queue.length === 0) queue.push(nextLabel);
      else if (isGeneric(queue.at(-1)!)) queue[queue.length - 1] = nextLabel;
      return;
    }
    // A genuine tool change keeps its place in order. It supersedes a trailing
    // generic entry rather than queueing behind it.
    if (queue.length > 0 && isGeneric(queue.at(-1)!)) queue[queue.length - 1] = nextLabel;
    else queue.push(nextLabel);
  };

  /** Promotes the oldest pending label once the window has elapsed. */
  const drain = (at: number) => {
    while (queue.length > 0 && at - shownAt >= WORKING_STATUS_DWELL_MS) {
      const next = queue.shift()!;
      if (next === label) continue;
      label = next;
      shownAt = at;
    }
  };

  return {
    get label() {
      return label;
    },
    get droppedCount() {
      return droppedCount;
    },
    push(nextLabel: string, at: number) {
      if (nextLabel !== label || queue.length > 0) {
        if (nextLabel !== label) enqueue(nextLabel);
        drain(at);
      }
      return label;
    },
  };
}

// ---------------------------------------------------------------------------
// AC-11 — one shared duration ticker
//
// Every live duration label used to own a `setInterval`, so N streaming rows ran
// N timers. They now share one module-level interval with a subscriber set: the
// interval starts with the first subscriber and is cleared with the last, so no
// timer ever runs with zero subscribers.
// ---------------------------------------------------------------------------

type DurationTickSubscriber = () => void;

const durationTickSubscribers = new Set<DurationTickSubscriber>();
let durationTickIntervalId: ReturnType<typeof setInterval> | null = null;

/** Test seam: proves the subscriber set drains and the interval is released. */
export function durationTickSubscriberCount(): number {
  return durationTickSubscribers.size;
}

/**
 * Registers `onTick` on the shared one-second ticker and returns an idempotent
 * unsubscribe. Subscribers write their own text nodes; the ticker deliberately
 * causes no React commit.
 */
export function subscribeToDurationTick(onTick: DurationTickSubscriber): () => void {
  durationTickSubscribers.add(onTick);

  if (durationTickIntervalId === null) {
    durationTickIntervalId = setInterval(() => {
      // Snapshot: a subscriber may unsubscribe (unmount) during its own tick,
      // which would otherwise mutate the set mid-iteration.
      // eslint-disable-next-line unicorn/no-useless-spread
      for (const subscriber of [...durationTickSubscribers]) {
        // One faulty row must not stop every other live duration.
        try {
          subscriber();
        } catch {
          // ignored
        }
      }
    }, 1000);
  }

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    durationTickSubscribers.delete(onTick);
    if (durationTickSubscribers.size === 0 && durationTickIntervalId !== null) {
      clearInterval(durationTickIntervalId);
      durationTickIntervalId = null;
    }
  };
}
