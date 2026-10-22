import {
  assistantActivityState,
  assistantSelectionIsCurrent,
  captureAssistantSelection,
  type AssistantConfigurationDraft,
  type AssistantRoutineRecord,
  type AssistantSelection,
} from "./state/assistants.ts";
import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  type AssistantConfiguration,
  type AssistantDetail,
  type AssistantResourceSelection,
  type AssistantRoutineReadResult,
  type AssistantRunSummary,
  type AssistantSummary,
  type MemoryProcessingConfiguration,
  type ManagedSkillId,
  type ManagedTextResourceId,
  type ManagedTextResourceRevision,
  type McpDefinitionId,
  type ScheduledTaskUpsertSchedule,
  type SkillRevisionRef,
} from "@t3tools/contracts";

export type AssistantTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface AssistantStatusPresentation {
  readonly label: string;
  readonly tone: AssistantTone;
  /** What the last known state was; never presented as current while offline. */
  readonly detail: string | null;
}

function lastKnownStatus(summary: AssistantSummary): Omit<AssistantStatusPresentation, "detail"> {
  if (summary.provisioningState === "failed") return { label: "Setup failed", tone: "danger" };
  if (summary.provisioningState === "needs-repair")
    return { label: "Needs repair", tone: "danger" };
  if (summary.provisioningState === "provisioning") return { label: "Setting up", tone: "info" };
  if (summary.lifecycle === "archived") return { label: "Archived", tone: "neutral" };
  const { attention } = summary;
  if (attention.uncertainRuns > 0) return { label: "Outcome uncertain", tone: "warning" };
  if (attention.waitingRuns > 0) return { label: "Needs input", tone: "warning" };
  if (attention.activeRuns > 0) return { label: "Running", tone: "info" };
  if (attention.queuedRuns > 0) return { label: "Queued", tone: "info" };
  if (summary.lifecycle === "disabled") return { label: "Disabled", tone: "neutral" };
  if (summary.lifecycle !== "active")
    return { label: titleCase(summary.lifecycle), tone: "neutral" };
  return { label: "Idle", tone: "neutral" };
}

/**
 * An offline environment says so first. The assistant's last known state stays
 * secondary, because nothing proves it is still true.
 */
export function assistantStatus(input: {
  readonly connected: boolean;
  readonly summary: AssistantSummary;
}): AssistantStatusPresentation {
  const state = assistantActivityState({ connected: input.connected, summary: input.summary });
  const known = lastKnownStatus(input.summary);
  if (state.environment === "offline")
    return { label: "Offline", tone: "warning", detail: `Last known: ${known.label}` };
  return { ...known, detail: input.summary.attention.reason };
}

export function assistantAttentionCounts(summary: AssistantSummary): ReadonlyArray<string> {
  const { attention } = summary;
  return [
    attention.activeRuns > 0 ? `${attention.activeRuns} running` : null,
    attention.waitingRuns > 0 ? `${attention.waitingRuns} waiting for input` : null,
    attention.queuedRuns > 0 ? `${attention.queuedRuns} queued` : null,
    attention.uncertainRuns > 0 ? `${attention.uncertainRuns} uncertain` : null,
    attention.pendingMemoryJobs > 0 ? `${attention.pendingMemoryJobs} memory jobs pending` : null,
  ].filter((value): value is string => value !== null);
}

/** Work that an explicit Stop could still affect. */
export function assistantHasStoppableWork(summary: AssistantSummary): boolean {
  const { attention } = summary;
  return attention.activeRuns + attention.waitingRuns + attention.queuedRuns > 0;
}

const EXECUTION_LABELS: Record<string, { label: string; tone: AssistantTone }> = {
  queued: { label: "Queued", tone: "info" },
  running: { label: "Running", tone: "info" },
  waiting: { label: "Waiting for input", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Stopped", tone: "neutral" },
  interrupted: { label: "Interrupted", tone: "warning" },
  uncertain: { label: "Outcome uncertain", tone: "warning" },
};

/** A dispatch receipt only says the message was handed over; it never reads as a finished run. */
export function assistantRunStatus(run: AssistantRunSummary): {
  readonly label: string;
  readonly tone: AssistantTone;
} {
  if (run.phase === "dispatch") {
    if (run.status === "dispatched") return { label: "Sent, no run yet", tone: "info" };
    if (run.status === "failed") return { label: "Not sent", tone: "danger" };
    if (run.status === "uncertain") return { label: "Send uncertain", tone: "warning" };
    return { label: `Send ${run.status.replaceAll("-", " ")}`, tone: "neutral" };
  }
  return EXECUTION_LABELS[run.status] ?? { label: titleCase(run.status), tone: "neutral" };
}

export type AssistantRoutineFire = Extract<
  AssistantRoutineReadResult,
  { operation: "fires" }
>["fires"][number];

/**
 * The scheduler's own "succeeded" means dispatch was acknowledged. Only a V2
 * run that reached `completed` reads as completed here.
 */
export function routineFireStatus(fire: AssistantRoutineFire): {
  readonly label: string;
  readonly tone: AssistantTone;
} {
  if (fire.status === "attempted")
    return fire.dispatched
      ? { label: "Dispatch uncertain", tone: "warning" }
      : { label: "Not dispatched", tone: "danger" };
  if (fire.runId === null)
    return fire.status === "dispatched"
      ? { label: "Dispatched, no run yet", tone: "info" }
      : { label: `Dispatched, ${fire.status}`, tone: "warning" };
  return EXECUTION_LABELS[fire.status] ?? { label: titleCase(fire.status), tone: "neutral" };
}

export const ROUTINE_TRIGGER_LABELS: Record<AssistantRoutineFire["trigger"], string> = {
  scheduled: "Scheduled",
  manual: "Run now",
  webhook: "Webhook",
};

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function routineScheduleLabel(schedule: ScheduledTaskUpsertSchedule | null): string {
  if (schedule === null) return "No schedule";
  if (schedule.type === "webhook") return "When its webhook is called";
  if (schedule.type === "interval") {
    const minutes = Math.round(schedule.everyMs / 60_000);
    if (minutes % 1440 === 0)
      return minutes === 1440 ? "Every day" : `Every ${minutes / 1440} days`;
    if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
    return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
  }
  const days =
    schedule.weekdays === undefined ||
    schedule.weekdays.length === 0 ||
    schedule.weekdays.length === 7
      ? "Every day"
      : [...schedule.weekdays]
          .sort((left, right) => left - right)
          .map((day) => WEEKDAY_SHORT[day] ?? String(day))
          .join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

/** Fixed times run on the server's clock, which is labelled rather than converted. */
export function routineTimingLabel(routine: AssistantRoutineRecord): {
  readonly schedule: string;
  readonly next: string | null;
  readonly nextNote: string | null;
} {
  const schedule = `${routineScheduleLabel(routine.schedule)} · ${routine.timeZone}`;
  if (!routine.enabled) return { schedule, next: null, nextNote: "Paused" };
  if (routine.schedule?.type === "webhook") return { schedule, next: null, nextNote: null };
  if (routine.nextRunAt === null) return { schedule, next: null, nextNote: "No upcoming run" };
  return { schedule, next: routine.nextRunAt, nextNote: null };
}

export interface RoutineDraft {
  readonly taskId: AssistantRoutineRecord["taskId"] | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  /** `keep` leaves an existing webhook trigger (and its stored secrets) unchanged. */
  readonly mode: "interval" | "fixed" | "keep";
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  readonly weekdays: ReadonlyArray<number>;
}

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

export function routineDraftFrom(routine: AssistantRoutineRecord | null): RoutineDraft {
  const schedule = routine?.schedule ?? null;
  return {
    taskId: routine?.taskId ?? null,
    title: routine?.title ?? "",
    prompt: routine?.prompt ?? "",
    // New routines start paused, so saving one never schedules work unasked.
    enabled: routine?.enabled ?? false,
    mode:
      schedule?.type === "interval" ? "interval" : schedule?.type === "webhook" ? "keep" : "fixed",
    intervalMinutes:
      schedule?.type === "interval" ? String(Math.round(schedule.everyMs / 60_000)) : "60",
    timeOfDay: schedule?.type === "fixed_time" ? schedule.timeOfDay : "09:00",
    weekdays:
      schedule?.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
        ? schedule.weekdays
        : EVERY_DAY,
  };
}

export function routineDraftSchedule(
  draft: RoutineDraft,
  existing: ScheduledTaskUpsertSchedule | null,
): { readonly schedule: ScheduledTaskUpsertSchedule } | { readonly error: string } {
  if (draft.mode === "keep") {
    if (existing?.type !== "webhook") return { error: "Choose a schedule for this routine." };
    // Omitting the signature keeps the stored one; the webhook token is rotated separately.
    const { signature: _signature, ...rest } = existing;
    return { schedule: rest };
  }
  if (draft.mode === "interval") {
    const minutes = Number(draft.intervalMinutes);
    if (!Number.isInteger(minutes) || minutes * 60_000 < MIN_SCHEDULED_TASK_INTERVAL_MS)
      return { error: "Enter a whole number of minutes, at least 1." };
    return { schedule: { type: "interval", everyMs: minutes * 60_000 } };
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(draft.timeOfDay))
    return { error: "Enter a time as HH:MM, for example 09:00." };
  if (draft.weekdays.length === 0) return { error: "Choose at least one day." };
  const everyDay = draft.weekdays.length === 7;
  return {
    schedule: {
      type: "fixed_time",
      timeOfDay: draft.timeOfDay,
      ...(everyDay ? {} : { weekdays: [...draft.weekdays].sort((left, right) => left - right) }),
    },
  };
}

export function routineDraftError(
  draft: RoutineDraft,
  existing: ScheduledTaskUpsertSchedule | null,
): string | null {
  if (draft.title.trim().length === 0) return "Give the routine a title.";
  if (draft.title.length > 200) return "Keep the title under 200 characters.";
  if (draft.prompt.trim().length === 0) return "Write the message the routine sends.";
  const schedule = routineDraftSchedule(draft, existing);
  return "error" in schedule ? schedule.error : null;
}

export const RUNTIME_MODE_LABELS: Record<AssistantConfiguration["runtimeMode"], string> = {
  "approval-required": "Ask before actions",
  "auto-accept-edits": "Accept edits",
  auto: "Automatic",
  "full-access": "Full access",
};

export const INTERACTION_MODE_LABELS: Record<AssistantConfiguration["interactionMode"], string> = {
  default: "Chat",
  plan: "Plan first",
};

export function defaultAssistantConfiguration(
  name: string,
  modelSelection: AssistantConfiguration["modelSelection"],
): AssistantConfiguration {
  return {
    name: name.trim(),
    rules: "",
    prompt: "",
    personality: "",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    resources: { mcpTools: [], skills: [], instructions: [] },
    memory: {
      automaticCapture: true,
      allowRoutineCreation: false,
      extractionFallback: null,
      externalIndexing: null,
    },
  };
}

const TEXT_LIMIT = 65_536;

export function assistantConfigurationError(configuration: AssistantConfiguration): string | null {
  const name = configuration.name.trim();
  if (name.length === 0) return "Give the agent a name.";
  if (name.length > 120) return "Keep the name under 120 characters.";
  if (configuration.modelSelection.model.trim().length === 0) return "Choose a model.";
  for (const [label, value] of [
    ["Rules", configuration.rules],
    ["Prompt", configuration.prompt],
    ["Personality", configuration.personality],
  ] as const)
    if (value.length > TEXT_LIMIT) return `${label} is too long.`;
  const indexing = configuration.memory.externalIndexing;
  if (
    indexing !== null &&
    (indexing.destination.trim().length === 0 || indexing.embeddingDestination.trim().length === 0)
  )
    return "Name both external indexing destinations, or turn external indexing off.";
  return null;
}

export function assistantConfigurationChanged(
  draft: AssistantConfiguration,
  saved: AssistantConfiguration,
): boolean {
  return JSON.stringify(draft) !== JSON.stringify(saved);
}

export function toggleAssistantSkill(
  resources: AssistantResourceSelection,
  skill: { readonly skillId: ManagedSkillId; readonly revision: SkillRevisionRef },
): AssistantResourceSelection {
  const selected = resources.skills.some((entry) => entry.skillId === skill.skillId);
  return {
    ...resources,
    skills: selected
      ? resources.skills.filter((entry) => entry.skillId !== skill.skillId)
      : [...resources.skills, { skillId: skill.skillId, revision: skill.revision }],
  };
}

export function toggleAssistantInstruction(
  resources: AssistantResourceSelection,
  instruction: {
    readonly resourceId: ManagedTextResourceId;
    readonly revision: ManagedTextResourceRevision;
  },
): AssistantResourceSelection {
  const selected = resources.instructions.some(
    (entry) => entry.resourceId === instruction.resourceId,
  );
  return {
    ...resources,
    instructions: selected
      ? resources.instructions.filter((entry) => entry.resourceId !== instruction.resourceId)
      : [...resources.instructions, instruction],
  };
}

/** Names are explicit: an empty list removes the server rather than granting every tool. */
export function setAssistantMcpTools(
  resources: AssistantResourceSelection,
  definitionId: McpDefinitionId,
  toolNamesText: string,
): AssistantResourceSelection {
  const toolNames = [
    ...new Set(
      toolNamesText
        .split(/[\s,]+/u)
        .map((name) => name.trim())
        .filter((name) => name.length > 0 && name.length <= 256),
    ),
  ].slice(0, 128);
  const others = resources.mcpTools.filter((entry) => entry.definitionId !== definitionId);
  return {
    ...resources,
    mcpTools: toolNames.length === 0 ? others : [...others, { definitionId, toolNames }],
  };
}

export type AssistantDraftState =
  | { readonly kind: "current" }
  | { readonly kind: "offline" }
  | { readonly kind: "stale"; readonly reason: string };

/**
 * A reviewed draft stays bound to the revision and connection it was opened
 * on. Anything else is shown as stale and kept; it is never rebased.
 */
export function assistantDraftState(
  draft: AssistantConfigurationDraft,
  current: { readonly detail: AssistantDetail | null; readonly epoch: string | null },
): AssistantDraftState {
  if (current.epoch === null) return { kind: "offline" };
  if (current.detail === null)
    return { kind: "stale", reason: "This agent is no longer available." };
  const live = captureAssistantSelection(current.detail.summary, current.epoch);
  if (assistantSelectionIsCurrent(draft.selected, live)) return { kind: "current" };
  if (draft.selected.connectionEpoch !== live.connectionEpoch)
    return {
      kind: "stale",
      reason: "The connection was replaced after you opened this. Review the current version.",
    };
  return {
    kind: "stale",
    reason: `Saved as revision ${live.configurationRevision} after you opened revision ${draft.selected.configurationRevision}. Your edits are kept; review the current version before saving.`,
  };
}

export function currentAssistantSelection(
  detail: AssistantDetail | null,
  epoch: string | null,
): AssistantSelection | null {
  return detail === null || epoch === null
    ? null
    : captureAssistantSelection(detail.summary, epoch);
}

const ASSISTANT_REASONS: Record<string, string> = {
  "not-found": "This agent no longer exists on this environment.",
  forbidden: "This connection isn't allowed to do that.",
  conflict: "The agent changed before this was applied. Review the current version and try again.",
  unavailable: "Agents aren't available on this environment right now.",
  "needs-repair": "This agent needs repair before it can do that.",
};

const MEMORY_REASONS: Record<string, string> = {
  stale: "That memory changed before this was applied. Review the current version and try again.",
  forbidden: "This connection isn't allowed to change this memory.",
  unavailable: "Memory isn't available on this environment right now.",
  invalid: "The server rejected this memory change.",
  forgotten: "That memory has been forgotten.",
};

/** Fixed sentences only: server text could echo destinations or tokens. */
export function describeAssistantFailure(error: unknown): string {
  if (error !== null && typeof error === "object" && "_tag" in error) {
    const reason = "reason" in error && typeof error.reason === "string" ? error.reason : "";
    if (error._tag === "AssistantRpcError")
      return ASSISTANT_REASONS[reason] ?? ASSISTANT_REASONS.unavailable!;
    if (error._tag === "AssistantMemoryRpcError")
      return MEMORY_REASONS[reason] ?? MEMORY_REASONS.unavailable!;
    if (error._tag === "EnvironmentAuthorizationError")
      return "This connection lacks permission for agents on this environment.";
    if (error._tag === "EnvironmentRpcUnavailableError")
      return "The environment is offline. Nothing was confirmed; check again after reconnecting.";
  }
  return "The request didn't complete. It may or may not have been applied; check the current state.";
}

function titleCase(value: string): string {
  const text = value.replaceAll("-", " ").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type ExtractionProvider = NonNullable<
  MemoryProcessingConfiguration["extractionRoute"]
>["provider"];

export const PROCESSING_PROVIDERS: Record<ExtractionProvider, string> = {
  "command-code": "Command Code",
  liquid: "Liquid",
};

export interface ProcessingRouteDraft {
  readonly endpoint: string;
  readonly model: string;
  readonly secretName: string;
}

export interface ProcessingDraft {
  readonly extraction: (ProcessingRouteDraft & { readonly provider: ExtractionProvider }) | null;
  readonly index: (ProcessingRouteDraft & { readonly dimensions: string }) | null;
}

export const EMPTY_PROCESSING_ROUTE: ProcessingRouteDraft = {
  endpoint: "",
  model: "",
  secretName: "",
};

export function processingDraftFrom(configuration: MemoryProcessingConfiguration): ProcessingDraft {
  const extraction = configuration.extractionRoute;
  const embedding = configuration.destination?.embeddingRoute;
  return {
    extraction: extraction
      ? {
          provider: extraction.provider,
          endpoint: extraction.endpoint,
          model: extraction.model,
          secretName: extraction.secretName,
        }
      : null,
    index: embedding
      ? {
          endpoint: embedding.endpoint,
          model: embedding.model,
          secretName: embedding.secretName,
          dimensions: String(embedding.dimensions),
        }
      : null,
  };
}

function routeError(label: string, route: ProcessingRouteDraft): string | null {
  try {
    const url = new URL(route.endpoint.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      return `${label}: use an https endpoint without credentials, query or fragment.`;
  } catch {
    return `${label}: enter a full https endpoint.`;
  }
  if (route.model.trim().length === 0 || route.model.trim().length > 256)
    return `${label}: name the model.`;
  if (route.secretName.trim().length === 0 || route.secretName.trim().length > 256)
    return `${label}: name the stored secret that holds its key.`;
  return null;
}

/** Off unless chosen. Each route is private to this agent and only names a stored secret. */
export function processingDraftConfiguration(
  draft: ProcessingDraft,
  selected: AssistantSelection,
): { readonly configuration: MemoryProcessingConfiguration } | { readonly error: string } {
  const owner = { kind: "assistant" as const, assistantId: selected.assistantId };
  const base = (route: ProcessingRouteDraft) => ({
    environmentId: selected.environmentId,
    owner,
    enabled: true as const,
    endpoint: route.endpoint.trim(),
    model: route.model.trim(),
    secretName: route.secretName.trim(),
  });
  if (draft.extraction) {
    const error = routeError("Extraction", draft.extraction);
    if (error) return { error };
  }
  if (draft.index) {
    const error = routeError("Index", draft.index);
    if (error) return { error };
    const dimensions = Number(draft.index.dimensions);
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 65_536)
      return { error: "Index: enter the embedding dimensions as a whole number." };
  }
  return {
    configuration: {
      ...(draft.extraction
        ? { extractionRoute: { ...base(draft.extraction), provider: draft.extraction.provider } }
        : {}),
      ...(draft.index
        ? {
            destination: {
              enabled: true as const,
              embeddingEnabled: true as const,
              backend: "mem0" as const,
              embeddingRoute: { ...base(draft.index), dimensions: Number(draft.index.dimensions) },
            },
          }
        : {}),
    },
  };
}
