import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AssistantActivityListInput,
  AssistantCreateInput,
  AssistantDetail,
  AssistantLifecycleInput,
  AssistantListInput,
  AssistantListResult,
  AssistantRunSummary,
  AssistantUpdateConfigurationInput,
} from "./assistants.ts";
import { isUnknownUnionMember } from "./baseSchemas.ts";
import {
  MemoryGrant,
  MemoryGrantListInput,
  MemoryOwner,
  memoryOwnerEquals,
} from "./memoryOwner.ts";

const decodeAssistantActivityListInput = Schema.decodeUnknownSync(AssistantActivityListInput);
const decodeAssistantCreateInput = Schema.decodeUnknownSync(AssistantCreateInput);
const decodeAssistantDetail = Schema.decodeUnknownSync(AssistantDetail);
const decodeAssistantLifecycleInput = Schema.decodeUnknownSync(AssistantLifecycleInput);
const decodeAssistantListInput = Schema.decodeUnknownSync(AssistantListInput);
const decodeAssistantListResult = Schema.decodeUnknownSync(AssistantListResult);
const decodeAssistantRunSummary = Schema.decodeUnknownSync(AssistantRunSummary);
const decodeAssistantUpdateConfigurationInput = Schema.decodeUnknownSync(
  AssistantUpdateConfigurationInput,
);
const decodeMemoryGrant = Schema.decodeUnknownSync(MemoryGrant);
const decodeMemoryGrantListInput = Schema.decodeUnknownSync(MemoryGrantListInput);
const decodeMemoryOwner = Schema.decodeUnknownSync(MemoryOwner);

const binding = {
  environmentId: "environment-1",
  assistantId: "assistant-1",
  backingProjectId: "project-1",
  canonicalThreadId: "thread-1",
};
const configuration = {
  name: "Research",
  rules: "Ask before publishing.",
  prompt: "Help with research.",
  personality: "Direct",
  modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
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
const summary = {
  environmentId: "environment-1",
  assistantId: "assistant-1",
  name: "Research",
  configurationRevision: 3,
  lifecycle: "active",
  provisioningState: "ready",
  binding,
  attention: {
    queuedRuns: 0,
    activeRuns: 0,
    waitingRuns: 0,
    uncertainRuns: 0,
    pendingMemoryJobs: 1,
    memoryStatus: "pending",
    reason: null,
  },
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
};
const run = {
  assistantId: "assistant-1",
  configurationRevision: 3,
  commandId: "command-1",
  messageId: "message-1",
  runId: null,
  runAttemptId: null,
  scheduledTaskId: "schedule-1",
  phase: "dispatch",
  status: "dispatched",
  updatedAt: "2026-10-21T00:00:00.000Z",
};

describe("assistant contracts", () => {
  it("keeps create/configure inputs independent from inference and requires optimistic revision", () => {
    const create = decodeAssistantCreateInput({
      environmentId: "environment-1",
      commandId: "command-1",
      configuration,
      initialMessage: "Start immediately",
      runId: "run-1",
    });
    expect(create).not.toHaveProperty("initialMessage");
    expect(create).not.toHaveProperty("runId");
    const update = {
      environmentId: "environment-1",
      assistantId: "assistant-1",
      commandId: "command-2",
      configuration,
    };
    expect(() => decodeAssistantUpdateConfigurationInput(update)).toThrow();
    expect(
      decodeAssistantUpdateConfigurationInput({
        ...update,
        expectedRevision: 3,
      }).expectedRevision,
    ).toBe(3);
    expect(() =>
      decodeAssistantUpdateConfigurationInput({
        ...update,
        expectedRevision: -1,
      }),
    ).toThrow();
  });

  it("retains identity across unknown read states but rejects malformed known provisioning", () => {
    const decode = decodeAssistantDetail;
    const detail = {
      summary: { ...summary, lifecycle: "future-state", provisioningState: "future-state" },
      configuration: {
        environmentId: "environment-1",
        assistantId: "assistant-1",
        revision: 3,
        configuration,
        createdAt: summary.createdAt,
      },
      provisioning: { state: "future-state", privateFuturePayload: "discard" },
    };
    const result = decode(detail);
    expect(result.summary.binding.canonicalThreadId).toBe("thread-1");
    expect(isUnknownUnionMember(result.provisioning)).toBe(true);
    expect(() => decode({ ...detail, provisioning: { state: "ready" } })).toThrow();
    expect(
      decode({
        ...detail,
        provisioning: { state: "failed", binding, reason: "Install Git", retryable: true },
      }).summary.assistantId,
    ).toBe("assistant-1");
  });

  it("bounds list and activity reads without accepting transcripts in shell summaries", () => {
    const query = { environmentId: "environment-1", includeArchived: false, limit: 100 };
    expect(decodeAssistantListInput(query).limit).toBe(100);
    for (const limit of [0, 101]) {
      expect(() => decodeAssistantListInput({ ...query, limit })).toThrow();
      expect(() =>
        decodeAssistantActivityListInput({
          ...query,
          assistantId: "assistant-1",
          limit,
        }),
      ).toThrow();
    }
    const decoded = decodeAssistantListResult({
      assistants: [{ ...summary, transcript: ["secret"], memories: ["secret"] }],
      nextCursor: null,
    });
    expect(decoded.assistants[0]).not.toHaveProperty("transcript");
    expect(decoded.assistants[0]).not.toHaveProperty("memories");
    expect(() =>
      decodeAssistantListResult({
        assistants: Array.from({ length: 101 }, () => summary),
        nextCursor: null,
      }),
    ).toThrow();
  });

  it("distinguishes scheduler dispatch from actual V2 run completion", () => {
    const decode = decodeAssistantRunSummary;
    expect(decode(run).runId).toBeNull();
    expect(() => decode({ ...run, status: "completed" })).toThrow();
    const completed = decode({
      ...run,
      phase: "execution",
      status: "completed",
      runId: "run-1",
      runAttemptId: "attempt-1",
    });
    expect(completed.configurationRevision).toBe(3);
    expect(completed.runId).toBe("run-1");
    expect(decode({ ...run, status: "future-status" }).status).toBe("future-status");
  });

  it("records pre-admission terminal outcomes without fabricating V2 lineage", () => {
    for (const status of ["failed", "cancelled", "interrupted", "uncertain"]) {
      const dispatch = decodeAssistantRunSummary({ ...run, status });
      expect(dispatch.phase).toBe("dispatch");
      expect(dispatch.status).toBe(status);
      expect(dispatch.runId).toBeNull();
      expect(dispatch.runAttemptId).toBeNull();
      expect(() => decodeAssistantRunSummary({ ...run, phase: "execution", status })).toThrow();
    }
  });

  it("requires run lineage for admitted states and rejects orphan attempts", () => {
    expect(() => decodeAssistantRunSummary({ ...run, runAttemptId: "attempt-1" })).toThrow();
    expect(() => decodeAssistantRunSummary({ ...run, runId: "run-1" })).toThrow();
    for (const status of ["queued", "running", "waiting", "completed"]) {
      expect(() => decodeAssistantRunSummary({ ...run, status })).toThrow();
      expect(() => decodeAssistantRunSummary({ ...run, phase: "execution", status })).toThrow();
      expect(
        decodeAssistantRunSummary({ ...run, phase: "execution", runId: "run-1", status }).runId,
      ).toBe("run-1");
    }
    expect(() =>
      decodeAssistantRunSummary({ ...run, phase: "execution", runId: "run-1" }),
    ).toThrow();
    expect(
      decodeAssistantRunSummary({
        ...run,
        phase: "execution",
        runId: "run-1",
        status: "future-status",
      }).status,
    ).toBe("future-status");
    expect(() =>
      decodeAssistantRunSummary({
        ...run,
        status: "future-status",
        runAttemptId: "attempt-1",
      }),
    ).toThrow();
  });

  it("requires explicit restore and revision on lifecycle mutations", () => {
    const input = {
      environmentId: "environment-1",
      assistantId: "assistant-1",
      commandId: "command-1",
      expectedRevision: 3,
    };
    const decode = decodeAssistantLifecycleInput;
    expect(decode({ ...input, action: "restore" }).action).toBe("restore");
    expect(() => decode({ ...input, action: "resume-and-run" })).toThrow();
  });

  it("keeps assistant memory private from its backing project and binds grants to exact revisions", () => {
    const owner = decodeMemoryOwner({
      kind: "assistant",
      assistantId: "assistant-1",
    });
    const backingProject = decodeMemoryOwner({
      kind: "project",
      projectId: "project-1",
    });
    expect(memoryOwnerEquals(owner, backingProject)).toBe(false);
    expect(memoryOwnerEquals(owner, owner)).toBe(true);
    const grant = {
      id: "grant-1",
      environmentId: "environment-1",
      source: { owner, sourceId: "source-1", sourceRevision: 2 },
      recipient: backingProject,
      ownerRevision: 3,
      recipientRevision: 1,
      createdAt: summary.createdAt,
      revokedAt: null,
    };
    expect(decodeMemoryGrant(grant).source.sourceRevision).toBe(2);
    const { recipientRevision: _recipientRevision, ...missingRevision } = grant;
    expect(() => decodeMemoryGrant(missingRevision)).toThrow();
    expect(() =>
      decodeMemoryGrant({ ...grant, source: { owner, sourceId: "source-1" } }),
    ).toThrow();
    expect(() =>
      decodeMemoryGrantListInput({
        environmentId: "environment-1",
        owner,
        limit: 101,
      }),
    ).toThrow();
  });
});
