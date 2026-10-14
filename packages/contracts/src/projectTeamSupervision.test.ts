import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { ProjectWorkReadIntent } from "./projectWork.ts";
import { ProjectTeamSupervisionSummary } from "./projectTeamSupervision.ts";

const decode = Schema.decodeUnknownSync(ProjectTeamSupervisionSummary);
const decodeRead = Schema.decodeUnknownSync(ProjectWorkReadIntent);
const decodeEnvironment = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const counts = {
  draft: 0,
  specified: 0,
  ready: 0,
  "in-progress": 0,
  blocked: 0,
  "in-review": 0,
  completed: 0,
  failed: 0,
  canceled: 0,
  unknown: 0,
  total: 0,
};
const summary = {
  projectId: "project",
  availability: "available",
  revision: 7,
  taskCounts: counts,
  missions: { items: [], hasMore: false },
  bindings: { items: [], hasMore: false },
  blockers: { items: [], hasMore: false },
  questions: { items: [], hasMore: false },
};
const common = {
  recordId: "binding",
  revision: 5,
  generation: 1,
  status: "running",
  supported: true,
};
const binding = {
  ...common,
  taskId: "task",
  attemptId: "attempt",
  memberId: "member",
  roleRevisionId: "role-at-start",
  providerInstanceId: "pi",
  model: "recorded-cheap-model",
  workerThreadId: "thread",
  profile: {
    ...common,
    recordId: "role-at-start",
    status: "retired",
    roleId: "implementer",
    roleRevision: 1,
    role: "implementer",
    model: "profile-model",
  },
};

describe("bounded team supervision contract", () => {
  it("keeps original accounting optional and rejects unsafe recorded totals", () => {
    const accounting = {
      availability: "available",
      projectId: "project",
      environmentId: "environment",
      bindingId: "binding",
      generation: 1,
      taskId: "task",
      attemptId: "attempt",
      observedAt: "2026-10-01T00:00:00.000Z",
      root: {
        taskId: "root",
        maximumTokens: 1000,
        deadlineAtMs: 2000,
        chargedTokens: 200,
        reservedTokens: 50,
        unknownChargedTokens: 40,
        remainingTokens: 750,
        heldCalls: 1,
        quarantinedCalls: 1,
      },
      attempt: {
        maximumTokens: 400,
        deadlineAtMs: 1500,
        chargedTokens: 150,
        reservedTokens: 10,
        unknownChargedTokens: 40,
        remainingTokens: 240,
        heldCalls: 1,
        quarantinedCalls: 1,
      },
    };
    const withAccounting = (value: unknown) => ({
      ...summary,
      bindings: { items: [{ ...binding, accounting: value }], hasMore: false },
    });
    expect(decode(withAccounting(accounting))).toMatchObject({
      bindings: { items: [{ accounting }] },
    });
    expect(decode({ ...summary, bindings: { items: [binding], hasMore: false } })).toMatchObject({
      revision: 7,
    });
    for (const chargedTokens of [-1, Number.MAX_SAFE_INTEGER + 1, "200"])
      expect(() =>
        decode(withAccounting({ ...accounting, root: { ...accounting.root, chargedTokens } })),
      ).toThrow();
  });

  it("accepts monitored accounting policy while retaining charged overshoot", () => {
    const policy = {
      accountingMode: "openai-subscription-monitored",
      thresholdTokens: 64_000,
      observedChargedTokens: 80_384,
      nominalHeldTokens: 0,
      stoppedReason: "threshold-reached",
    };
    const monitored = {
      availability: "available",
      projectId: "project",
      environmentId: "environment",
      bindingId: "binding",
      generation: 1,
      taskId: "task",
      attemptId: "attempt",
      observedAt: "2026-10-01T00:00:00.000Z",
      root: {
        taskId: "root",
        maximumTokens: 64_000,
        deadlineAtMs: 300_000,
        chargedTokens: 80_384,
        reservedTokens: 0,
        unknownChargedTokens: 0,
        remainingTokens: 0,
        heldCalls: 0,
        quarantinedCalls: 0,
        policy,
      },
      attempt: {
        maximumTokens: 64_000,
        deadlineAtMs: 300_000,
        chargedTokens: 80_384,
        reservedTokens: 0,
        unknownChargedTokens: 0,
        remainingTokens: 0,
        heldCalls: 0,
        quarantinedCalls: 0,
        policy,
      },
    };
    expect(
      decode({
        ...summary,
        bindings: { items: [{ ...binding, accounting: monitored }], hasMore: false },
      }),
    ).toMatchObject({ bindings: { items: [{ accounting: monitored }] } });
    expect(() =>
      decode({
        ...summary,
        bindings: {
          items: [
            {
              ...binding,
              accounting: {
                ...monitored,
                root: { ...monitored.root, policy: { ...policy, thresholdTokens: 63_999 } },
              },
            },
          ],
          hasMore: false,
        },
      }),
    ).toThrow();
  });

  it("keeps the frozen binding model separate from the inspected role model", () => {
    const result = decode({ ...summary, bindings: { items: [binding], hasMore: false } });
    expect(result).toMatchObject({
      bindings: { items: [{ model: "recorded-cheap-model", profile: { model: "profile-model" } }] },
    });
  });

  it("bounds worker thread identifiers while retaining their trimmed identity", () => {
    const thread = "t".repeat(256);
    expect(
      decode({
        ...summary,
        bindings: { items: [{ ...binding, workerThreadId: ` ${thread} ` }], hasMore: false },
      }),
    ).toMatchObject({ bindings: { items: [{ workerThreadId: thread }] } });
    expect(() =>
      decode({
        ...summary,
        bindings: { items: [{ ...binding, workerThreadId: "t".repeat(257) }], hasMore: false },
      }),
    ).toThrow();
  });

  it.each(["missing", "deleted", "archived", "tombstoned", "unsupported"])(
    "has no records for unavailable %s projects",
    (availability) => {
      expect(
        decode({
          projectId: "project",
          availability,
          bindings: { items: [binding], hasMore: false },
        }),
      ).toEqual({ projectId: "project", availability });
    },
  );

  it("preserves future states and roles as unsupported metadata", () => {
    expect(
      decode({
        ...summary,
        bindings: {
          items: [
            {
              ...binding,
              status: "future-state",
              supported: false,
              profile: { ...binding.profile, role: "future-role", supported: false },
            },
          ],
          hasMore: true,
        },
      }),
    ).toMatchObject({
      bindings: {
        hasMore: true,
        items: [
          {
            status: "future-state",
            supported: false,
            profile: { role: "future-role", supported: false },
          },
        ],
      },
    });
  });

  it("removes actionable fields and body content from physical malformed markers", () => {
    const marker = {
      recordId: "corrupt",
      revision: 7,
      status: "running",
      supported: false,
      issue: "malformed",
      taskId: "foreign",
      workerThreadId: "foreign-thread",
      objective: "secret",
      model: "foreign-model",
    };
    expect(decode({ ...summary, bindings: { items: [marker], hasMore: false } })).toMatchObject({
      bindings: {
        items: [
          {
            recordId: "corrupt",
            revision: 7,
            status: "running",
            supported: false,
            issue: "malformed",
          },
        ],
      },
    });
    const result = decode({ ...summary, bindings: { items: [marker], hasMore: false } });
    if (result.availability !== "available") throw new Error("Expected available metadata");
    expect(result.bindings.items[0]).toEqual({
      recordId: "corrupt",
      revision: 7,
      status: "running",
      supported: false,
      issue: "malformed",
    });
  });

  it.each(["missions", "bindings", "blockers", "questions"])(
    "rejects an oversized %s preview",
    (key) => {
      const items =
        key === "bindings"
          ? Array.from({ length: 9 }, () => binding)
          : key === "missions"
            ? Array.from({ length: 6 }, () => ({ ...common, title: "Mission" }))
            : key === "blockers"
              ? Array.from({ length: 6 }, () => ({
                  recordId: "blocker",
                  taskId: "task",
                  revision: 7,
                  reason: "Waiting",
                  resolver: "human",
                }))
              : Array.from({ length: 6 }, () => ({
                  ...common,
                  taskId: "task",
                  senderId: "member",
                  targetGateId: "gate",
                  targetRevision: 7,
                }));
      expect(() => decode({ ...summary, [key]: { items, hasMore: true } })).toThrow();
    },
  );

  it("bounds captions and rejects unsafe or negative revisions and counts", () => {
    expect(() =>
      decode({
        ...summary,
        missions: { items: [{ ...common, title: "x".repeat(241) }], hasMore: false },
      }),
    ).toThrow();
    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decode({ ...summary, revision })).toThrow();
      expect(() => decode({ ...summary, taskCounts: { ...counts, total: revision } })).toThrow();
    }
  });

  it("accepts the project-owned read without implying mutation authority", () => {
    expect(
      decodeRead({
        projectId: "project",
        operation: "supervision",
      }),
    ).toMatchObject({ operation: "supervision" });
  });

  it("requires an explicit supervision capability under version skew", () => {
    const old = {
      environmentId: "environment",
      label: "Local",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "old",
      capabilities: { repositoryIdentity: true },
    };
    expect(decodeEnvironment(old).capabilities.projectTeamSupervisionReads).toBeUndefined();
    expect(
      decodeEnvironment({
        ...old,
        capabilities: { ...old.capabilities, projectTeamSupervisionReads: true },
      }).capabilities.projectTeamSupervisionReads,
    ).toBe(true);
  });
});
