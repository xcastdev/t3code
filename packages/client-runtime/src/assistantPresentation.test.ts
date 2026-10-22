import {
  captureAssistantConfigurationDraft,
  prepareAssistantConfigurationMutation,
} from "./state/assistants.ts";
import {
  AssistantConfigurationRevision,
  AssistantId,
  CommandId,
  EnvironmentId,
  McpDefinitionId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type AssistantDetail,
  type AssistantSummary,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  assistantDraftState,
  assistantRunStatus,
  assistantStatus,
  describeAssistantFailure,
  defaultAssistantConfiguration,
  routineDraftFrom,
  routineDraftSchedule,
  routineFireStatus,
  routineTimingLabel,
  setAssistantMcpTools,
  type AssistantRoutineFire,
} from "./assistantPresentation.ts";

const now = "2026-10-21T00:00:00.000Z";
const revision = AssistantConfigurationRevision.make(3);

function summary(
  environmentId: string,
  overrides: Partial<AssistantSummary> = {},
): AssistantSummary {
  const env = EnvironmentId.make(environmentId);
  const assistantId = AssistantId.make("helper");
  return {
    environmentId: env,
    assistantId,
    name: "Helper",
    configurationRevision: revision,
    lifecycle: "active",
    provisioningState: "ready",
    binding: {
      environmentId: env,
      assistantId,
      backingProjectId: ProjectId.make("backing"),
      canonicalThreadId: ThreadId.make("home"),
    },
    attention: {
      queuedRuns: 0,
      activeRuns: 0,
      waitingRuns: 0,
      uncertainRuns: 0,
      pendingMemoryJobs: 0,
      memoryStatus: "idle",
      reason: null,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function detail(base: AssistantSummary): AssistantDetail {
  return {
    summary: base,
    configuration: {
      environmentId: base.environmentId,
      assistantId: base.assistantId,
      revision: base.configurationRevision,
      configuration: defaultAssistantConfiguration("Helper", {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5",
      }),
      createdAt: now,
    },
    provisioning: { state: "ready", binding: base.binding },
  };
}

it("keeps an offline environment distinct from the assistant's last known activity", () => {
  const running = summary("local", {
    attention: { ...summary("local").attention, activeRuns: 1 },
  });
  expect(assistantStatus({ connected: true, summary: running })).toMatchObject({
    label: "Running",
  });
  expect(assistantStatus({ connected: false, summary: running })).toEqual({
    label: "Offline",
    tone: "warning",
    detail: "Last known: Running",
  });
  // Uncertain outcomes outrank activity, and archive outranks idle counts.
  expect(
    assistantStatus({
      connected: true,
      summary: summary("local", {
        attention: { ...running.attention, uncertainRuns: 1 },
      }),
    }).label,
  ).toBe("Outcome uncertain");
  expect(
    assistantStatus({ connected: true, summary: summary("local", { lifecycle: "archived" }) })
      .label,
  ).toBe("Archived");
});

it("never reads a dispatch receipt or a scheduler acknowledgement as a completed run", () => {
  const base = {
    assistantId: AssistantId.make("helper"),
    configurationRevision: revision,
    commandId: CommandId.make("command"),
    messageId: MessageId.make("message"),
    scheduledTaskId: null,
    updatedAt: now,
  };
  expect(
    assistantRunStatus({
      ...base,
      phase: "dispatch",
      runId: null,
      runAttemptId: null,
      status: "dispatched",
    }).label,
  ).toBe("Sent, no run yet");
  expect(
    assistantRunStatus({
      ...base,
      phase: "execution",
      runId: RunId.make("run"),
      runAttemptId: null,
      status: "completed",
    }).label,
  ).toBe("Completed");

  const fire: AssistantRoutineFire = {
    fireKey: "fire",
    taskId: ScheduledTaskId.make("task"),
    threadId: ThreadId.make("home"),
    commandId: CommandId.make("command"),
    messageId: MessageId.make("message"),
    startedAt: now,
    trigger: "scheduled",
    triggerIdentity: "tick",
    dispatched: true,
    configurationRevision: revision,
    admittedConfigurationRevision: null,
    runId: null,
    status: "dispatched",
  };
  expect(routineFireStatus(fire).label).toBe("Dispatched, no run yet");
  // An inconsistent completed status without a V2 run stays a dispatch outcome.
  expect(routineFireStatus({ ...fire, status: "completed" }).label).toBe("Dispatched, completed");
  expect(routineFireStatus({ ...fire, runId: RunId.make("run"), status: "completed" }).label).toBe(
    "Completed",
  );
  expect(routineFireStatus({ ...fire, dispatched: false, status: "attempted" }).label).toBe(
    "Not dispatched",
  );
});

it("labels the server time zone and paused routines without inventing a next fire", () => {
  const routine = {
    taskId: ScheduledTaskId.make("task"),
    revision: 2,
    title: "Morning",
    prompt: "Summarise",
    enabled: true,
    deleted: false,
    schedule: { type: "fixed_time" as const, timeOfDay: "09:00", weekdays: [5, 1] },
    nextRunAt: "2026-10-22T07:00:00.000Z",
    timeZone: "Europe/Paris",
    configurationRevision: revision,
  };
  expect(routineTimingLabel(routine)).toEqual({
    schedule: "Mon, Fri at 09:00 · Europe/Paris",
    next: "2026-10-22T07:00:00.000Z",
    nextNote: null,
  });
  expect(routineTimingLabel({ ...routine, enabled: false })).toMatchObject({
    next: null,
    nextNote: "Paused",
  });
});

it("builds routine schedules from drafts and keeps an existing webhook trigger's secret", () => {
  const draft = routineDraftFrom(null);
  expect(draft.enabled).toBe(false);
  expect(routineDraftSchedule({ ...draft, mode: "interval", intervalMinutes: "0" }, null)).toEqual({
    error: "Enter a whole number of minutes, at least 1.",
  });
  expect(routineDraftSchedule({ ...draft, mode: "interval", intervalMinutes: "30" }, null)).toEqual(
    { schedule: { type: "interval", everyMs: 1_800_000 } },
  );
  expect(routineDraftSchedule({ ...draft, weekdays: [3, 1] }, null)).toEqual({
    schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
  });
  expect(routineDraftSchedule({ ...draft, weekdays: [] }, null)).toEqual({
    error: "Choose at least one day.",
  });
  const webhook = {
    type: "webhook" as const,
    signature: { header: "x-sig", encoding: "hex" as const, prefix: "" },
    maxDeliveryAgeMinutes: 10,
  };
  expect(routineDraftSchedule({ ...draft, mode: "keep" }, webhook)).toEqual({
    schedule: { type: "webhook", maxDeliveryAgeMinutes: 10 },
  });
});

it("treats an empty tool list as removing the server, not granting every tool", () => {
  const definitionId = McpDefinitionId.make("github");
  const empty = { mcpTools: [], skills: [], instructions: [] };
  const selected = setAssistantMcpTools(empty, definitionId, "search, read search\n");
  expect(selected.mcpTools).toEqual([{ definitionId, toolNames: ["search", "read"] }]);
  expect(setAssistantMcpTools(selected, definitionId, "  ").mcpTools).toEqual([]);
});

it("keeps a stale configuration draft visible instead of rebasing it", () => {
  const original = detail(summary("remote"));
  const draft = captureAssistantConfigurationDraft(original, "epoch-1");
  expect(assistantDraftState(draft, { detail: original, epoch: "epoch-1" })).toEqual({
    kind: "current",
  });
  expect(assistantDraftState(draft, { detail: original, epoch: null })).toEqual({
    kind: "offline",
  });
  // A reconnect alone makes the draft stale, even at the same revision.
  expect(assistantDraftState(draft, { detail: original, epoch: "epoch-2" }).kind).toBe("stale");
  const saved = detail(
    summary("remote", { configurationRevision: AssistantConfigurationRevision.make(4) }),
  );
  const stale = assistantDraftState(draft, { detail: saved, epoch: "epoch-1" });
  expect(stale).toMatchObject({ kind: "stale" });
  expect(stale.kind === "stale" && stale.reason).toContain("revision 4");
  expect(
    prepareAssistantConfigurationMutation({
      draft,
      current: { ...draft.selected, configurationRevision: saved.summary.configurationRevision },
      commandId: CommandId.make("save"),
    }),
  ).toBeNull();
});

it("never treats a coincident assistant ID in another environment as the same agent", () => {
  const local = detail(summary("local"));
  const draft = captureAssistantConfigurationDraft(local, "epoch-1");
  const remote = detail(summary("remote"));
  expect(assistantDraftState(draft, { detail: remote, epoch: "epoch-1" }).kind).toBe("stale");
});

it("describes failures with fixed sentences rather than server text", () => {
  expect(
    describeAssistantFailure({ _tag: "AssistantRpcError", reason: "conflict", message: "token=x" }),
  ).not.toContain("token");
  expect(describeAssistantFailure({ _tag: "AssistantMemoryRpcError", reason: "forgotten" })).toBe(
    "That memory has been forgotten.",
  );
  expect(describeAssistantFailure(new Error("https://secret@host"))).not.toContain("secret");
});
