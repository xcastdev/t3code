import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  type ProjectTeamGuidedIntent,
  type ProjectTeamWriteIntent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  beginGuidedTaskSubmission,
  clearGuidedTaskSubmission,
  compareGuidedTaskDraft,
  createGuidedTaskDraftState,
  discardGuidedTaskDraft,
  editGuidedTaskDraft,
  rebaseGuidedTaskDraft,
  recordGuidedTaskDraftOutcome,
  retryGuidedTaskSubmission,
  type GuidedTaskDraftKey,
  type GuidedTaskDraftState,
} from "./guidedTaskDraft";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Plan = Extract<ProjectTeamGuidedIntent, { type: "project-team.plan.propose" }>;
const projectId = ProjectId.make("project-1");
const taskId = ProjectWorkTaskId.make("task-1");
const environmentId = EnvironmentId.make("environment-1");
const fields = { content: "Keep these unsaved findings", notes: "My local changes" };
const plan = (overrides: Partial<Plan> = {}): Plan => ({
  type: "project-team.plan.propose",
  commandId: CommandId.make("draft-reference"),
  projectId,
  taskId,
  expectedRevision: 10,
  expectedTaskRevision: 7,
  specRevision: 2,
  content: "The original plan",
  dependencyTaskIds: [],
  previousPlanId: "plan-3",
  expectedPreviousPlanRevision: 3,
  ...overrides,
});
const key = (overrides: Partial<GuidedTaskDraftKey> = {}): GuidedTaskDraftKey => ({
  environmentId,
  projectId,
  taskId,
  kind: "project-team.plan.propose",
  ...overrides,
});
const changed = (result: { readonly ok: boolean; readonly state: GuidedTaskDraftState }) => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error("Expected successful draft transition");
  return result.state;
};
const edited = (state = createGuidedTaskDraftState(), draftKey = key(), input: unknown = plan()) =>
  changed(editGuidedTaskDraft(state, draftKey, input, fields));
function submit(
  state: GuidedTaskDraftState,
  draftKey = key(),
  input: unknown = plan({ commandId: CommandId.make("command-1"), content: fields.content }),
) {
  const result = beginGuidedTaskSubmission(state, draftKey, input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error("Expected successful submission transition");
  return result;
}
const expectRefusal = (
  result: { readonly ok: boolean; readonly state: GuidedTaskDraftState },
  original: GuidedTaskDraftState,
  reason: string,
) => {
  expect(result).toMatchObject({ ok: false, reason });
  expect(result.state).toBe(original);
};
const gate = (
  overrides: Partial<Extract<ProjectTeamWriteIntent, { type: "project-team.gate.respond" }>> = {},
): Extract<ProjectTeamWriteIntent, { type: "project-team.gate.respond" }> => ({
  type: "project-team.gate.respond",
  commandId: CommandId.make("gate-reference"),
  projectId,
  taskId,
  expectedRevision: 10,
  expectedTaskRevision: 7,
  specRevision: 2,
  planRevision: 3,
  gateId: "plan-gate-3",
  expectedGateRevision: 1,
  response: "approved",
  ...overrides,
});

describe("guided task drafts and exact submissions", () => {
  it("retains waiver criterion and specification targets when the task revision is unchanged", () => {
    const input: Extract<ProjectTeamGuidedIntent, { type: "project-team.criterion.waiver" }> = {
      type: "project-team.criterion.waiver",
      commandId: CommandId.make("waiver-source"),
      projectId,
      taskId,
      expectedRevision: 10,
      expectedTaskRevision: 7,
      expectedSpecRevision: 2,
      criterionId: ProjectWorkCriterionId.make("criterion-one"),
      expectedCriterionRevision: 3,
      expectedSpecificationHash: "a".repeat(64),
      action: { kind: "waive", reason: "A deliberate human exception", evidenceIds: [] },
    };
    const draftKey = key({ kind: input.type });
    const state = edited(createGuidedTaskDraftState(), draftKey, input);
    for (const change of [
      { criterionId: ProjectWorkCriterionId.make("criterion-two") },
      { expectedCriterionRevision: 4 },
      { expectedSpecificationHash: "b".repeat(64) },
    ]) {
      const next = { ...input, ...change, commandId: CommandId.make("waiver-attempt") };
      expect(compareGuidedTaskDraft(state, draftKey, next)?.targetsChanged).toBe(true);
      expectRefusal(beginGuidedTaskSubmission(state, draftKey, next), state, "target-changed");
    }
    const sent = submit(state, draftKey, { ...input, commandId: CommandId.make("waiver-command") });
    const uncertain = changed(
      recordGuidedTaskDraftOutcome(sent.state, sent.submission, "uncertain"),
    );
    const retry = retryGuidedTaskSubmission(uncertain, draftKey);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.submission.intentJson).toBe(sent.submission.intentJson);
  });

  it("retains an exact verification proposal and refuses changed binding or criterion targets", () => {
    const input = {
      type: "project-team.verification.propose" as const,
      commandId: CommandId.make("verification-command"),
      projectId,
      taskId,
      expectedRevision: 10,
      expectedTaskRevision: 7,
      specRevision: 2,
      planRevision: 3,
      jobId: "verification-job",
      bindingId: "settled-binding",
      expectedBindingRevision: 2,
      generation: 8,
      criterionIds: [ProjectWorkCriterionId.make("criterion-1")],
      command: {
        executable: "/opt/test runner",
        argv: ["", "$(literal); *"],
        environment: "clean" as const,
        limits: { maxDurationMs: 120000, maxOutputBytes: 65536 },
      },
    };
    const owner = key({ kind: "project-team.verification.propose" });
    const state = edited(createGuidedTaskDraftState(), owner, input);
    expectRefusal(
      beginGuidedTaskSubmission(state, owner, { ...input, generation: 9 }),
      state,
      "target-changed",
    );
    expectRefusal(
      beginGuidedTaskSubmission(state, owner, { ...input, criterionIds: ["criterion-2"] }),
      state,
      "target-changed",
    );
    const first = submit(state, owner, input);
    input.command.argv[1] = "mutated";
    const uncertain = changed(
      recordGuidedTaskDraftOutcome(first.state, first.submission, "uncertain"),
    );
    const retry = retryGuidedTaskSubmission(uncertain, owner);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw Error("Expected exact retry");
    expect(retry.submission.intentJson).toBe(first.submission.intentJson);
    expect(JSON.parse(retry.submission.intentJson).command.argv).toEqual(["", "$(literal); *"]);
    expectRefusal(
      retryGuidedTaskSubmission(
        uncertain,
        key({ ...owner, environmentId: EnvironmentId.make("foreign") }),
      ),
      uncertain,
      "not-uncertain",
    );
  });
  it("preserves edits and original targets through another device's update; comparison cannot rebase", () => {
    const first = edited();
    const original = first.entries[0]!.originalIntentJson;
    const newer = plan({
      expectedRevision: 11,
      expectedTaskRevision: 8,
      specRevision: 3,
      previousPlanId: "plan-4",
      expectedPreviousPlanRevision: 4,
      content: "Another device's plan",
    });
    const refreshed = changed(editGuidedTaskDraft(first, key(), newer, { notes: "Still local" }));
    expect(refreshed.entries[0]!.fields).toEqual({ ...fields, notes: "Still local" });
    expect(refreshed.entries[0]!.originalIntentJson).toBe(original);
    const comparison = compareGuidedTaskDraft(refreshed, key(), newer);
    expect(comparison).toMatchObject({ originalIntentJson: original, targetsChanged: true });
    expectRefusal(beginGuidedTaskSubmission(refreshed, key(), newer), refreshed, "target-changed");
    const reviewed = changed(rebaseGuidedTaskDraft(refreshed, key(), newer));
    expect(reviewed.entries[0]!.fields).toEqual(refreshed.entries[0]!.fields);
    const sent = submit(reviewed, key(), {
      ...newer,
      commandId: CommandId.make("reviewed-command"),
      content: fields.content,
    });
    expect(sent.submission.intentJson).toContain('"specRevision":3');
    expect(
      changed(recordGuidedTaskDraftOutcome(sent.state, sent.submission, "success")).entries,
    ).toEqual([]);
  });

  it("retains exact validated bytes/ID on uncertainty despite caller mutation and newer detail", () => {
    const input = {
      ...plan({ commandId: CommandId.make("command-1"), content: fields.content }),
      dependencyTaskIds: [ProjectWorkTaskId.make("dependency-1")],
    };
    const initial = edited();
    const sent = submit(initial, key(), input);
    const captured = sent.submission.intentJson;
    input.content = "Mutation after send";
    input.dependencyTaskIds.push(ProjectWorkTaskId.make("dependency-2"));
    const uncertain = changed(
      recordGuidedTaskDraftOutcome(sent.state, sent.submission, "uncertain"),
    );
    expectRefusal(
      editGuidedTaskDraft(uncertain, key(), plan(), { content: "Changed during retry" }),
      uncertain,
      "pending-submission",
    );
    expectRefusal(
      rebaseGuidedTaskDraft(uncertain, key(), plan({ expectedRevision: 20 })),
      uncertain,
      "pending-submission",
    );
    expect(
      compareGuidedTaskDraft(uncertain, key(), plan({ expectedRevision: 20 }))!.targetsChanged,
    ).toBe(true);
    const retry = retryGuidedTaskSubmission(uncertain, key());
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw Error("Expected exact retry");
    expect(retry.submission).toMatchObject({
      commandId: sent.submission.commandId,
      version: sent.submission.version,
      intentJson: captured,
    });
    expect(retry.submission.intentJson).not.toContain("Mutation after send");
    expect(retry.submission.intentJson).not.toContain("dependency-2");
    expect(
      changed(recordGuidedTaskDraftOutcome(retry.state, sent.submission, "success")).entries,
    ).toHaveLength(0);
  });

  it.each(["stale", "denied", "unavailable"] as const)(
    "keeps text on %s, requires a fresh command and explicit review after conflict",
    (outcome) => {
      const sent = submit(edited());
      const failed = changed(recordGuidedTaskDraftOutcome(sent.state, sent.submission, outcome));
      expectRefusal(retryGuidedTaskSubmission(failed, key()), failed, "not-uncertain");
      expectRefusal(
        recordGuidedTaskDraftOutcome(failed, sent.submission, "uncertain"),
        failed,
        "settled-submission",
      );
      expectRefusal(
        recordGuidedTaskDraftOutcome(failed, sent.submission, "success"),
        failed,
        "settled-submission",
      );
      const cleared = changed(clearGuidedTaskSubmission(failed, key()));
      expect(cleared.entries[0]!.fields).toEqual(fields);
      expect(cleared.entries[0]!.pending).toBeUndefined();
      if (outcome === "stale")
        expectRefusal(
          beginGuidedTaskSubmission(
            cleared,
            key(),
            plan({ commandId: CommandId.make("command-2") }),
          ),
          cleared,
          "target-changed",
        );
      const newer = plan({ expectedRevision: 11, expectedTaskRevision: 8 });
      const reviewed = changed(rebaseGuidedTaskDraft(cleared, key(), newer));
      expectRefusal(
        beginGuidedTaskSubmission(reviewed, key(), {
          ...newer,
          commandId: sent.submission.commandId,
        }),
        reviewed,
        "command-id-reused",
      );
      const next = submit(reviewed, key(), {
        ...newer,
        commandId: CommandId.make("command-2"),
        content: fields.content,
      });
      expectRefusal(
        recordGuidedTaskDraftOutcome(next.state, sent.submission, "success"),
        next.state,
        "unmatched-submission",
      );
      expect(next.state.entries[0]!.fields).toEqual(fields);
    },
  );

  it("does not approve a newer gate from refreshed detail and separates approval/proposal kinds", () => {
    const approvalKey = key({ kind: "project-team.gate.respond" });
    const draft = edited(createGuidedTaskDraftState(), approvalKey, gate());
    const newer = gate({
      specRevision: 3,
      gateId: "new-specification-gate",
      expectedGateRevision: 0,
    });
    expect(compareGuidedTaskDraft(draft, approvalKey, newer)!.targetsChanged).toBe(true);
    expectRefusal(beginGuidedTaskSubmission(draft, approvalKey, newer), draft, "target-changed");
    expectRefusal(
      editGuidedTaskDraft(draft, approvalKey, plan(), { content: "Wrong kind" }),
      draft,
      "invalid-input",
    );
    expectRefusal(beginGuidedTaskSubmission(draft, approvalKey, plan()), draft, "invalid-input");
    const reviewed = changed(rebaseGuidedTaskDraft(draft, approvalKey, newer));
    const sent = submit(reviewed, approvalKey, {
      ...newer,
      commandId: CommandId.make("approve-new-target"),
    });
    expect(sent.submission.intentJson).toContain("new-specification-gate");
    expect(draft.entries[0]!.originalIntentJson).toContain("plan-gate-3");
  });

  it.each([
    { expectedRevision: 11 },
    { expectedTaskRevision: 8 },
    { specRevision: 3 },
    { previousPlanId: "replacement" },
    { expectedPreviousPlanRevision: 4 },
    { previousPlanId: undefined, expectedPreviousPlanRevision: undefined },
  ])("refuses silently retargeted plan submission %j", (target) => {
    const draft = edited();
    const next = { ...plan(), ...target, commandId: CommandId.make("new-id") };
    if ("previousPlanId" in target && target.previousPlanId === undefined) {
      delete next.previousPlanId;
      delete next.expectedPreviousPlanRevision;
    }
    expectRefusal(beginGuidedTaskSubmission(draft, key(), next), draft, "target-changed");
  });

  it("isolates environment/project/task/kind identity and same-ID callbacks", () => {
    const identities = [
      key(),
      key({ environmentId: EnvironmentId.make("remote") }),
      key({ projectId: ProjectId.make("project-2") }),
      key({ taskId: ProjectWorkTaskId.make("task-2") }),
      key({ kind: "project-team.gate.respond" }),
    ];
    let state = createGuidedTaskDraftState();
    const receipts = identities.map((draftKey) => {
      const input =
        draftKey.kind === "project-team.gate.respond"
          ? gate({ projectId: draftKey.projectId, taskId: draftKey.taskId })
          : plan({ projectId: draftKey.projectId, taskId: draftKey.taskId });
      state = edited(state, draftKey, input);
      const sent = submit(state, draftKey, { ...input, commandId: CommandId.make("same-id") });
      state = sent.state;
      return sent.submission;
    });
    expect(state.entries).toHaveLength(5);
    const forged = { ...receipts[0]!, key: identities[1]! };
    expectRefusal(
      recordGuidedTaskDraftOutcome(state, forged, "success"),
      state,
      "unmatched-submission",
    );
    const completed = changed(recordGuidedTaskDraftOutcome(state, receipts[0]!, "success"));
    expect(completed.entries).toHaveLength(4);
    expect(completed.entries.every((entry) => entry.fields.content === fields.content)).toBe(true);
  });

  it("an explicit discard clears edits, and a late receipt cannot erase a recreated draft even with an ID reused", () => {
    const old = submit(edited());
    const discarded = changed(discardGuidedTaskDraft(old.state, key()));
    expect(discarded.entries).toEqual([]);
    const newDraft = changed(
      editGuidedTaskDraft(discarded, key(), plan(), { content: "New draft after discard" }),
    );
    const next = submit(
      newDraft,
      key(),
      plan({ commandId: old.submission.commandId, content: "New draft after discard" }),
    );
    expect(next.submission.version).not.toBe(old.submission.version);
    expectRefusal(
      recordGuidedTaskDraftOutcome(next.state, old.submission, "success"),
      next.state,
      "unmatched-submission",
    );
    expect(next.state.entries[0]!.fields.content).toBe("New draft after discard");
  });

  it("explicit uncertain abandonment keeps fields and does not accept an old result as a new save", () => {
    const sent = submit(edited());
    expectRefusal(clearGuidedTaskSubmission(sent.state, key()), sent.state, "pending-submission");
    const uncertain = changed(
      recordGuidedTaskDraftOutcome(sent.state, sent.submission, "uncertain"),
    );
    const cleared = changed(clearGuidedTaskSubmission(uncertain, key()));
    expect(cleared.entries[0]!.fields).toEqual(fields);
    const next = submit(cleared, key(), plan({ commandId: CommandId.make("new-command") }));
    expectRefusal(
      recordGuidedTaskDraftOutcome(next.state, sent.submission, "success"),
      next.state,
      "unmatched-submission",
    );
  });

  it("refuses any previously attempted command ID until explicit discard", () => {
    let state = edited();
    for (const id of ["attempt-one", "attempt-two"]) {
      const sent = submit(state, key(), plan({ commandId: CommandId.make(id) }));
      state = changed(recordGuidedTaskDraftOutcome(sent.state, sent.submission, "denied"));
      state = changed(clearGuidedTaskSubmission(state, key()));
    }
    expectRefusal(
      beginGuidedTaskSubmission(state, key(), plan({ commandId: CommandId.make("attempt-one") })),
      state,
      "command-id-reused",
    );
    expect(state.entries[0]!.fields).toEqual(fields);
  });

  it("refuses safely when bounded command history is full", () => {
    let state = edited();
    for (let index = 0; index < 256; index++) {
      const sent = submit(state, key(), plan({ commandId: CommandId.make(`attempt-${index}`) }));
      state = changed(recordGuidedTaskDraftOutcome(sent.state, sent.submission, "denied"));
      state = changed(clearGuidedTaskSubmission(state, key()));
    }
    expectRefusal(
      beginGuidedTaskSubmission(
        state,
        key(),
        plan({ commandId: CommandId.make("attempt-overflow") }),
      ),
      state,
      "capacity",
    );
    expect(state.entries[0]!.usedCommandIds).toHaveLength(256);
    expect(state.entries[0]!.fields).toEqual(fields);
  });

  it("never evicts dirty or pending entries to retain another task", () => {
    const first = edited(
      createGuidedTaskDraftState({ maxEntries: 2, maxEntryBytes: 4096, maxBytes: 8192 }),
    );
    const pending = submit(first);
    const secondKey = key({ taskId: ProjectWorkTaskId.make("second") });
    const second = edited(pending.state, secondKey, plan({ taskId: secondKey.taskId }));
    const thirdKey = key({ taskId: ProjectWorkTaskId.make("third") });
    expectRefusal(
      editGuidedTaskDraft(second, thirdKey, plan({ taskId: thirdKey.taskId }), fields),
      second,
      "capacity",
    );
    expect(second.entries[0]!.pending?.intentJson).toBe(pending.submission.intentJson);
    expect(second.entries[1]!.fields).toEqual(fields);
  });

  it.each(["a", "🙂", "é", "\u0000", "\ud800"])(
    "counts exact JSON UTF8 and refuses one-byte-short entry/global bounds for %j",
    (text) => {
      const first = changed(
        editGuidedTaskDraft(createGuidedTaskDraftState(), key(), plan(), { content: text }),
      );
      const json = encodeJson(first.entries[0]);
      const bytes = new TextEncoder().encode(json).length;
      const exact = createGuidedTaskDraftState({
        maxEntries: 1,
        maxEntryBytes: bytes,
        maxBytes: bytes,
      });
      expect(editGuidedTaskDraft(exact, key(), plan(), { content: text }).ok).toBe(true);
      const entryShort = createGuidedTaskDraftState({
        maxEntries: 1,
        maxEntryBytes: bytes - 1,
        maxBytes: bytes,
      });
      expectRefusal(
        editGuidedTaskDraft(entryShort, key(), plan(), { content: text }),
        entryShort,
        "entry-limit",
      );
      const globalShort = createGuidedTaskDraftState({
        maxEntries: 1,
        maxEntryBytes: bytes,
        maxBytes: bytes - 1,
      });
      expectRefusal(
        editGuidedTaskDraft(globalShort, key(), plan(), { content: text }),
        globalShort,
        "capacity",
      );
    },
  );

  it("refuses oversized raw input, accessors and cyclic data before schema reads without altering existing drafts", () => {
    const state = edited(
      createGuidedTaskDraftState({ maxEntries: 2, maxEntryBytes: 4096, maxBytes: 8192 }),
    );
    expectRefusal(
      editGuidedTaskDraft(state, key(), plan(), { content: "x".repeat(4097) }),
      state,
      "entry-limit",
    );
    const large = { ...plan(), dependencyTaskIds: Array(4097) };
    expectRefusal(beginGuidedTaskSubmission(state, key(), large), state, "invalid-input");
    let reads = 0;
    const accessor = Object.defineProperty({ ...plan() }, "content", {
      get() {
        reads++;
        return "must not be read";
      },
      enumerable: true,
    });
    expectRefusal(beginGuidedTaskSubmission(state, key(), accessor), state, "invalid-input");
    expect(reads).toBe(0);
    const cyclic: { content: unknown } = { content: null };
    cyclic.content = cyclic;
    expectRefusal(beginGuidedTaskSubmission(state, key(), cyclic), state, "invalid-input");
  });

  it.each(["edit", "compare", "begin", "rebase"] as const)(
    "refuses non-enumerable schema getters before any reads in %s",
    (operation) => {
      const initial = createGuidedTaskDraftState();
      const state = operation === "edit" ? initial : edited(initial);
      let reads = 0;
      const input = Object.defineProperty(plan(), "content", {
        enumerable: false,
        get() {
          reads++;
          return "Hidden getter result";
        },
      });
      const result =
        operation === "edit"
          ? editGuidedTaskDraft(state, key(), input, fields)
          : operation === "compare"
            ? compareGuidedTaskDraft(state, key(), input)
            : operation === "begin"
              ? beginGuidedTaskSubmission(state, key(), input)
              : rebaseGuidedTaskDraft(state, key(), input);
      expect(reads).toBe(0);
      if (operation === "compare") expect(result).toBeNull();
      else expect(result).toMatchObject({ ok: false, state, reason: "invalid-input" });
      expect(state.entries).toEqual(operation === "edit" ? [] : edited(initial).entries);
    },
  );

  it.each(["edit", "compare", "begin", "rebase"] as const)(
    "refuses oversized hidden schema data in %s without changing dirty targets",
    (operation) => {
      const initial = createGuidedTaskDraftState({
        maxEntries: 1,
        maxEntryBytes: 1024,
        maxBytes: 2048,
      });
      const state = operation === "edit" ? initial : edited(initial);
      const input = Object.defineProperty(plan(), "commandId", {
        enumerable: false,
        value: CommandId.make("x".repeat(65536)),
      });
      const result =
        operation === "edit"
          ? editGuidedTaskDraft(state, key(), input, fields)
          : operation === "compare"
            ? compareGuidedTaskDraft(state, key(), input)
            : operation === "begin"
              ? beginGuidedTaskSubmission(state, key(), input)
              : rebaseGuidedTaskDraft(state, key(), input);
      if (operation === "compare") expect(result).toBeNull();
      else expect(result).toMatchObject({ ok: false, state, reason: "invalid-input" });
      if (state.entries[0]) expect(state.entries[0].fields).toEqual(fields);
    },
  );

  it.each([false, true])(
    "refuses indexed array accessors (enumerable=%s) before schema reads",
    (enumerable) => {
      const state = edited();
      let reads = 0;
      const dependencies = Object.defineProperty([ProjectWorkTaskId.make("dependency")], "0", {
        enumerable,
        get() {
          reads++;
          return ProjectWorkTaskId.make("getter-dependency");
        },
      });
      const input = { ...plan(), dependencyTaskIds: dependencies };
      expectRefusal(beginGuidedTaskSubmission(state, key(), input), state, "invalid-input");
      expect(compareGuidedTaskDraft(state, key(), input)).toBeNull();
      expect(reads).toBe(0);
      const normal = { ...plan(), dependencyTaskIds: [ProjectWorkTaskId.make("dependency")] };
      expect(beginGuidedTaskSubmission(state, key(), normal).ok).toBe(true);
    },
  );

  it("refuses sparse/custom-prototype arrays before inherited indexed reads", () => {
    const state = edited();
    let reads = 0;
    const prototype = {
      get 0() {
        reads++;
        return ProjectWorkTaskId.make("inherited-dependency");
      },
    };
    Object.setPrototypeOf(prototype, Array.prototype);
    const dependencies = Array<ProjectWorkTaskId>(1);
    Object.setPrototypeOf(dependencies, prototype);
    expectRefusal(
      beginGuidedTaskSubmission(state, key(), { ...plan(), dependencyTaskIds: dependencies }),
      state,
      "invalid-input",
    );
    expect(reads).toBe(0);
    expect(
      compareGuidedTaskDraft(state, key(), {
        ...plan(),
        dependencyTaskIds: Array<ProjectWorkTaskId>(1),
      }),
    ).toBeNull();
  });

  it("rejects nested hidden control fields and patch fields before reading their getters", () => {
    const controlKey = key({ kind: "project-team.task.control" });
    const controlInput = {
      type: controlKey.kind,
      commandId: CommandId.make("control"),
      projectId,
      taskId,
      expectedRevision: 10,
      expectedTaskRevision: 7,
      control: { action: "pause", reason: "User paused work" },
    };
    const state = edited(createGuidedTaskDraftState(), controlKey, controlInput);
    let reads = 0;
    const control = Object.defineProperty({ ...controlInput.control }, "reason", {
      enumerable: false,
      get() {
        reads++;
        return "Hidden reason";
      },
    });
    expectRefusal(
      beginGuidedTaskSubmission(state, controlKey, { ...controlInput, control }),
      state,
      "invalid-input",
    );
    const patch = Object.defineProperty({ content: "Visible" }, "notes", {
      enumerable: false,
      get() {
        reads++;
        return "Hidden local notes";
      },
    });
    expectRefusal(
      editGuidedTaskDraft(state, controlKey, controlInput, patch),
      state,
      "entry-limit",
    );
    expect(reads).toBe(0);
    expect(beginGuidedTaskSubmission(state, controlKey, controlInput).ok).toBe(true);
  });

  it("does not retain private authority fields, malformed targets or unrelated public write types", () => {
    const state = edited();
    for (const input of [
      { ...plan(), authorized: true },
      { ...plan(), credentials: { token: "must not be retained" } },
      { ...plan(), expectedRevision: -1 },
      { ...plan(), previousPlanId: "unpaired", expectedPreviousPlanRevision: undefined },
      { ...plan(), projectId: ProjectId.make("wrong-project") },
      { ...plan(), type: "project-work.task.approve" },
    ])
      expectRefusal(beginGuidedTaskSubmission(state, key(), input), state, "invalid-input");
    expect(state.entries[0]!.originalIntentJson).not.toContain("credentials");
    expect(compareGuidedTaskDraft(state, key(), { ...plan(), expectedRevision: -1 })).toBe(null);
  });

  it("bounds pending bytes atomically and leaves fields/ID/version available when submission cannot fit", () => {
    const first = edited();
    const savedBytes = new TextEncoder().encode(encodeJson(first.entries[0])).length;
    const narrow = edited(
      createGuidedTaskDraftState({
        maxEntries: 1,
        maxEntryBytes: savedBytes + 100,
        maxBytes: savedBytes + 100,
      }),
    );
    expectRefusal(
      beginGuidedTaskSubmission(narrow, key(), plan({ commandId: CommandId.make("pending-id") })),
      narrow,
      "entry-limit",
    );
    expect(narrow.nextSubmissionVersion).toBe(1);
    expect(narrow.entries[0]!.usedCommandIds).toEqual([]);
    expect(narrow.entries[0]!.fields).toEqual(fields);
  });
  it("preserves existing criterion record targets while allowing explicit add/remove scope edits", () => {
    const oldId = ProjectWorkCriterionId.make("criterion-old");
    const newId = ProjectWorkCriterionId.make("criterion-new");
    const criterion = {
      criterionId: oldId,
      taskId,
      description: "Retained criterion",
      required: true,
      status: "unsatisfied" as const,
      satisfiedByEvidenceIds: [],
      revision: 2,
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const input: Extract<ProjectTeamGuidedIntent, { type: "project-team.specification.propose" }> =
      {
        type: "project-team.specification.propose",
        commandId: CommandId.make("spec-reference"),
        projectId,
        taskId,
        expectedRevision: 10,
        expectedTaskRevision: 7,
        expectedSpecRevision: 2,
        specification: {
          objective: "Proposed scope",
          scopeIn: "Bounded work",
          scopeOut: "Other work",
          criterionIds: [oldId],
          revision: 2,
          protected: false,
        },
        criterionSnapshots: [criterion],
      };
    const draftKey = key({ kind: input.type });
    const draft = edited(createGuidedTaskDraftState(), draftKey, input);
    const revisedRecord = {
      ...input,
      commandId: CommandId.make("spec-new-record"),
      criterionSnapshots: [{ ...criterion, revision: 3 }],
    };
    expectRefusal(
      beginGuidedTaskSubmission(draft, draftKey, revisedRecord),
      draft,
      "target-changed",
    );
    expect(compareGuidedTaskDraft(draft, draftKey, revisedRecord)!.targetsChanged).toBe(true);
    const added = {
      ...input,
      commandId: CommandId.make("spec-add"),
      specification: { ...input.specification, criterionIds: [oldId, newId] },
      criterionSnapshots: [
        { ...criterion, description: "Edited retained criterion" },
        { ...criterion, criterionId: newId, revision: 0 },
      ],
    };
    expect(beginGuidedTaskSubmission(draft, draftKey, added).ok).toBe(true);
    expectRefusal(
      beginGuidedTaskSubmission(draft, draftKey, {
        ...added,
        criterionSnapshots: [criterion, { ...criterion, criterionId: newId, revision: 1 }],
      }),
      draft,
      "target-changed",
    );
    const removed = {
      ...added,
      commandId: CommandId.make("spec-remove"),
      specification: { ...input.specification, criterionIds: [newId] },
      criterionSnapshots: [{ ...criterion, criterionId: newId, revision: 0 }],
    };
    expect(beginGuidedTaskSubmission(draft, draftKey, removed).ok).toBe(true);
  });

  const implementation = () => ({
    type: "project-team.assignment.start" as const,
    assignmentKind: "implementation" as const,
    commandId: CommandId.make("implementation-reference"),
    projectId,
    taskId,
    expectedRevision: 10,
    expectedTaskRevision: 7,
    specRevision: 2,
    objective: "Implement selected approved criteria",
    outputDescriptions: ["Fix", "Focused tests"],
    specificationGateId: "spec-gate",
    expectedSpecificationGateRevision: 1,
    parentPlan: {
      recordId: "plan",
      expectedRecordRevision: 2,
      planRevision: 3,
      gateId: "plan-gate",
      expectedGateRevision: 1,
    },
    parentCriterionIds: [ProjectWorkCriterionId.make("criterion-1")],
  });
  const implementationKey = () =>
    key({ kind: "project-team.assignment.start", assignmentKind: "implementation" });

  it.each(["criteria", "specification", "plan"])(
    "requires explicit review when implementation %s targets change",
    (target) => {
      const input = implementation();
      const draft = edited(createGuidedTaskDraftState(), implementationKey(), input);
      const next = {
        ...input,
        commandId: CommandId.make("implementation-command"),
        ...(target === "criteria"
          ? { parentCriterionIds: [ProjectWorkCriterionId.make("criterion-2")] }
          : {}),
        ...(target === "specification" ? { expectedSpecificationGateRevision: 2 } : {}),
        ...(target === "plan"
          ? { parentPlan: { ...input.parentPlan, expectedRecordRevision: 3 } }
          : {}),
      };
      expect(compareGuidedTaskDraft(draft, implementationKey(), next)?.targetsChanged).toBe(true);
      expectRefusal(
        beginGuidedTaskSubmission(draft, implementationKey(), next),
        draft,
        "target-changed",
      );
      const reviewed = changed(rebaseGuidedTaskDraft(draft, implementationKey(), next));
      expect(beginGuidedTaskSubmission(reviewed, implementationKey(), next).ok).toBe(true);
    },
  );

  it("retains implementation command bytes and selection for uncertain retry without rebasing", () => {
    const input = implementation();
    const draft = edited(createGuidedTaskDraftState(), implementationKey(), input);
    const sent = submit(draft, implementationKey(), {
      ...input,
      commandId: CommandId.make("implementation-command"),
      objective: "Exact retained objective\nwith newline",
    });
    const uncertain = changed(
      recordGuidedTaskDraftOutcome(sent.state, sent.submission, "uncertain"),
    );
    const next = {
      ...input,
      expectedRevision: 11,
      parentCriterionIds: [ProjectWorkCriterionId.make("criterion-2")],
    };
    expectRefusal(
      rebaseGuidedTaskDraft(uncertain, implementationKey(), next),
      uncertain,
      "pending-submission",
    );
    expectRefusal(
      editGuidedTaskDraft(uncertain, implementationKey(), next, {
        parentCriterionIds: '["criterion-2"]',
      }),
      uncertain,
      "pending-submission",
    );
    const retry = retryGuidedTaskSubmission(uncertain, implementationKey());
    expect(retry.ok).toBe(true);
    if (!retry.ok || !("submission" in retry)) throw Error("Expected exact retry");
    expect(retry.submission.intentJson).toBe(sent.submission.intentJson);
    expect(retry.submission.commandId).toBe(sent.submission.commandId);
    expect(JSON.parse(retry.submission.intentJson)).toMatchObject({
      expectedRevision: 10,
      parentCriterionIds: ["criterion-1"],
    });
  });

  it("keeps review and implementation drafts independent under the same wire intent", () => {
    const input = implementation();
    const reviewKey = key({ kind: "project-team.assignment.start" });
    const { parentCriterionIds: _selection, ...base } = input;
    const review = { ...base, assignmentKind: "review", objective: "Independent review" };
    const draft = edited(createGuidedTaskDraftState(), implementationKey(), input);
    const both = edited(draft, reviewKey, review);
    expect(both.entries).toHaveLength(2);
    expect(changed(discardGuidedTaskDraft(both, implementationKey())).entries).toMatchObject([
      { key: reviewKey },
    ]);
    expectRefusal(
      editGuidedTaskDraft(draft, implementationKey(), review, fields),
      draft,
      "invalid-input",
    );
    expectRefusal(editGuidedTaskDraft(both, reviewKey, input, fields), both, "invalid-input");
  });

  it.each([
    [],
    ["criterion-1", "criterion-1"],
    Array.from({ length: 65 }, (_, i) => `criterion-${i}`),
  ])("refuses invalid implementation criterion selection %j", (ids) => {
    const state = createGuidedTaskDraftState();
    expectRefusal(
      editGuidedTaskDraft(
        state,
        implementationKey(),
        { ...implementation(), parentCriterionIds: ids },
        fields,
      ),
      state,
      "invalid-input",
    );
  });

  it.each([
    {
      type: "project-team.investigation.start",
      objective: "Investigate behavior",
      outputDescriptions: ["Findings"],
      issueRecordId: "issue-1",
      expectedIssueRevision: 2,
      changed: { expectedIssueRevision: 3 },
    },
    {
      type: "project-team.assignment.start",
      assignmentKind: "planning",
      objective: "Propose plan",
      outputDescriptions: ["Proposed plan"],
      specRevision: 2,
      specificationGateId: "spec-gate",
      expectedSpecificationGateRevision: 1,
      parentPlan: {
        recordId: "parent-plan",
        expectedRecordRevision: 2,
        planRevision: 2,
        gateId: "parent-plan-gate",
        expectedGateRevision: 1,
      },
      changed: { expectedSpecificationGateRevision: 2 },
    },
    {
      type: "project-team.execution.start",
      specRevision: 2,
      planRevision: 3,
      specGateId: "spec-gate",
      expectedSpecGateRevision: 1,
      planId: "plan-3",
      expectedPlanRecordRevision: 3,
      planGateId: "plan-gate-3",
      expectedPlanGateRevision: 1,
      changed: { expectedPlanGateRevision: 2 },
    },
    {
      type: "project-team.task.control",
      control: {
        action: "reassign",
        reason: "Choose another member",
        recipientMemberId: "member-2",
        expectedMemberRevision: 2,
      },
      changed: {
        control: {
          action: "reassign",
          reason: "Choose another member",
          recipientMemberId: "member-2",
          expectedMemberRevision: 3,
        },
      },
    },
    {
      type: "project-team.assignment.report",
      specRevision: 2,
      planRevision: 3,
      assignmentId: "assignment-1",
      expectedAssignmentRevision: 1,
      summary: "Retained findings",
      evidenceIds: [],
      outputArtifactIds: [],
      outcome: "findings",
      changed: { expectedAssignmentRevision: 2 },
    },
    {
      type: "project-team.repair.resolve",
      episodeId: "episode-1",
      expectedEpisodeRevision: 2,
      failureFingerprint: "canonical-failure",
      relevantRevision: "revision-1",
      decision: "diagnose",
      reason: "Inspect exact failure",
      changed: { relevantRevision: "revision-2" },
    },
  ] as const)("fences $type record/approval targets without generating authority", (fixture) => {
    const { changed: target, ...body } = fixture;
    const input = {
      ...body,
      commandId: CommandId.make("reference"),
      projectId,
      taskId,
      expectedRevision: 10,
      expectedTaskRevision: 7,
    };
    const draftKey = key({ kind: input.type });
    const draft = edited(createGuidedTaskDraftState(), draftKey, input);
    const revised = { ...input, ...target, commandId: CommandId.make("next-command") };
    expectRefusal(beginGuidedTaskSubmission(draft, draftKey, revised), draft, "target-changed");
    expect(compareGuidedTaskDraft(draft, draftKey, revised)!.targetsChanged).toBe(true);
    const reviewed = changed(rebaseGuidedTaskDraft(draft, draftKey, revised));
    expect(beginGuidedTaskSubmission(reviewed, draftKey, revised).ok).toBe(true);
  });
});
