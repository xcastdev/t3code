import {
  ProjectTeamGuidedIntent,
  ProjectWorkWriteIntent,
  type CommandId,
  type EnvironmentId,
  type ProjectId,
  type ProjectTeamWriteIntent,
  type ProjectWorkTaskId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

type DraftIntent =
  | ProjectTeamGuidedIntent
  | Extract<ProjectTeamWriteIntent, { type: "project-team.gate.respond" }>;
export interface GuidedTaskDraftKey {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly taskId: ProjectWorkTaskId;
  readonly kind: DraftIntent["type"];
}
export type GuidedTaskDraftOutcome = "success" | "uncertain" | "stale" | "denied" | "unavailable";
export interface GuidedTaskDraftSubmission {
  readonly key: GuidedTaskDraftKey;
  readonly version: number;
  readonly commandId: CommandId;
  /** Validated intent bytes. The environment is selected separately by key. */
  readonly intentJson: string;
  readonly status: Exclude<GuidedTaskDraftOutcome, "success"> | "sending";
}
export interface GuidedTaskDraft {
  readonly key: GuidedTaskDraftKey;
  readonly fields: Readonly<Record<string, string>>;
  readonly originalIntentJson: string;
  readonly needsReview: boolean;
  readonly usedCommandIds: ReadonlyArray<CommandId>;
  readonly pending?: GuidedTaskDraftSubmission;
}
export interface GuidedTaskDraftState {
  readonly entries: ReadonlyArray<GuidedTaskDraft>;
  readonly nextSubmissionVersion: number;
  readonly limits: {
    readonly maxEntries: number;
    readonly maxEntryBytes: number;
    readonly maxBytes: number;
  };
}
type Refusal =
  | "invalid-input"
  | "entry-limit"
  | "capacity"
  | "missing-draft"
  | "pending-submission"
  | "target-changed"
  | "command-id-reused"
  | "not-uncertain"
  | "unmatched-submission"
  | "settled-submission";
type Change =
  | { readonly ok: true; readonly state: GuidedTaskDraftState }
  | { readonly ok: false; readonly state: GuidedTaskDraftState; readonly reason: Refusal };
const intentJson = Schema.fromJsonString(ProjectWorkWriteIntent);
const encodeIntent = Schema.encodeSync(intentJson);
const decodeIntent = Schema.decodeUnknownSync(intentJson);
const decodeInput = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
const isGuided = Schema.is(ProjectTeamGuidedIntent);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sameKey = (a: GuidedTaskDraftKey, b: GuidedTaskDraftKey) =>
  a.environmentId === b.environmentId &&
  a.projectId === b.projectId &&
  a.taskId === b.taskId &&
  a.kind === b.kind;
const refuse = (state: GuidedTaskDraftState, reason: Refusal) => ({
  ok: false as const,
  state,
  reason,
});

// Bound raw input before schema decoding/encoding. Count JSON UTF8, including escapes,
// with bounded structure traversal; hidden fields, getters and cycles are refused.
// Schema reads non-enumerable fields too, so enumeration must inspect every own key.
function jsonBytes(value: unknown, limit: number): number | null {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const add = (count: number) => (bytes += count) <= limit;
  const text = (value: string) => {
    if (value.length > limit - bytes || !add(2)) return false;
    for (const character of value) {
      const code = character.codePointAt(0)!;
      const count =
        character === '"' || character === "\\" || "\b\f\n\r\t".includes(character)
          ? 2
          : code < 32 || (code >= 0xd800 && code <= 0xdfff)
            ? 6
            : code < 0x80
              ? 1
              : code < 0x800
                ? 2
                : code < 0x10000
                  ? 3
                  : 4;
      if (!add(count)) return false;
    }
    return true;
  };
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 4096 || depth > 12) return false;
    if (typeof value === "string") return text(value);
    if (value === null) return add(4);
    if (typeof value === "boolean") return add(value ? 4 : 5);
    if (typeof value === "number") return Number.isFinite(value) && add(String(value).length);
    if (typeof value !== "object" || ancestors.has(value)) return false;
    const array = Array.isArray(value);
    if (
      array
        ? value.length > 4096 || Object.getPrototypeOf(value) !== Array.prototype
        : Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
    )
      return false;
    ancestors.add(value);
    if (!add(2)) return false;
    let count = 0;
    const keys = Reflect.ownKeys(value);
    if (keys.length > (array ? 4097 : 128)) return false;
    for (const key of keys) {
      // Native array length is fixed as a data property. Every position must be
      // own enumerable data; holes could let Schema read an inherited getter.
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor))
        return false;
      if (array && key !== String(count)) return false;
      if (descriptor.value === undefined && !array) continue;
      if (++count > 1 && !add(1)) return false;
      if (!array && (!text(key) || !add(1))) return false;
      if (!visit(descriptor.value, depth + 1)) return false;
    }
    if (array && count !== value.length) return false;
    ancestors.delete(value);
    return true;
  };
  return visit(value, 0) ? bytes : null;
}

function snapshot(state: GuidedTaskDraftState, key: GuidedTaskDraftKey, input: unknown) {
  if (jsonBytes(input, state.limits.maxEntryBytes) === null) return null;
  try {
    const intent = decodeInput(input);
    if (
      !(isGuided(intent) || intent.type === "project-team.gate.respond") ||
      intent.type !== key.kind ||
      intent.projectId !== key.projectId ||
      intent.taskId !== key.taskId
    )
      return null;
    const json = encodeIntent(intent);
    if (
      json.length > state.limits.maxEntryBytes ||
      new TextEncoder().encode(json).length > state.limits.maxEntryBytes
    )
      return null;
    return { intent, json };
  } catch {
    return null;
  }
}

// Only revision/record targets are compared; proposal text and gate responses remain editable.
function targets(intent: ProjectWorkWriteIntent): string {
  const fields = [
    "expectedRevision",
    "expectedTaskRevision",
    "expectedSpecRevision",
    "specRevision",
    "planRevision",
    "specGateId",
    "expectedSpecGateRevision",
    "planId",
    "expectedPlanRecordRevision",
    "planGateId",
    "expectedPlanGateRevision",
    "gateId",
    "expectedGateRevision",
    "previousPlanId",
    "expectedPreviousPlanRevision",
    "assignmentId",
    "expectedAssignmentRevision",
    "issueRecordId",
    "expectedIssueRevision",
    "specificationGateId",
    "expectedSpecificationGateRevision",
    "parentPlan",
    "episodeId",
    "expectedEpisodeRevision",
    "failureFingerprint",
    "relevantRevision",
  ];
  const values = Object.fromEntries(
    fields.flatMap((field) => {
      const value: unknown = Reflect.get(intent, field);
      return value === undefined ? [] : [[field, value]];
    }),
  );
  if (intent.type === "project-team.task.control") {
    values.control = {
      action: intent.control.action,
      ...(intent.control.action === "reassign"
        ? {
            recipientMemberId: intent.control.recipientMemberId,
            expectedMemberRevision: intent.control.expectedMemberRevision,
          }
        : {}),
    };
  }
  return encodeJson(values);
}

function sameTargets(original: ProjectWorkWriteIntent, next: ProjectWorkWriteIntent) {
  if (targets(original) !== targets(next)) return false;
  if (original.type !== "project-team.specification.propose" || next.type !== original.type)
    return true;
  // Add/remove is a scope edit under the original aggregate CAS. Retained criteria
  // keep their exact record targets; only new criteria may start at revision zero.
  return next.criterionSnapshots.every((criterion) => {
    const previous = original.criterionSnapshots.find(
      (item) => item.criterionId === criterion.criterionId,
    );
    return (
      criterion.taskId === next.taskId &&
      (previous
        ? criterion.revision === previous.revision && criterion.taskId === previous.taskId
        : criterion.revision === 0)
    );
  });
}

function replace(
  state: GuidedTaskDraftState,
  key: GuidedTaskDraftKey,
  draft: GuidedTaskDraft | null,
): Change {
  const entries = state.entries.filter((entry) => !sameKey(entry.key, key));
  if (draft) entries.push(Object.freeze(draft));
  if (entries.length > state.limits.maxEntries) return refuse(state, "capacity");
  let total = 0;
  for (const entry of entries) {
    // Reserve status space so a failure receipt cannot itself exceed the retention bound.
    const bytes = jsonBytes(
      entry.pending ? { ...entry, pending: { ...entry.pending, status: "unavailable" } } : entry,
      state.limits.maxEntryBytes,
    );
    if (bytes === null) return refuse(state, "entry-limit");
    if ((total += bytes) > state.limits.maxBytes) return refuse(state, "capacity");
  }
  return { ok: true, state: Object.freeze({ ...state, entries: Object.freeze(entries) }) };
}

export function createGuidedTaskDraftState(
  limits = { maxEntries: 16, maxEntryBytes: 1_048_576, maxBytes: 4_194_304 },
): GuidedTaskDraftState {
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1))
    throw Error("INVALID_DRAFT_LIMITS");
  return Object.freeze({
    entries: Object.freeze([]),
    nextSubmissionVersion: 1,
    limits: Object.freeze({ ...limits }),
  });
}

/** First edit captures its source targets. Later edits retain them, including after server refresh. */
export function editGuidedTaskDraft(
  state: GuidedTaskDraftState,
  key: GuidedTaskDraftKey,
  originalIntent: unknown,
  patch: Readonly<Record<string, string>>,
): Change {
  const existing = state.entries.find((entry) => sameKey(entry.key, key));
  if (existing?.pending) return refuse(state, "pending-submission");
  if (jsonBytes(patch, state.limits.maxEntryBytes) === null) return refuse(state, "entry-limit");
  if (
    Object.keys(patch).length > 64 ||
    Object.values(patch).some((value) => typeof value !== "string")
  )
    return refuse(state, "invalid-input");
  const source = snapshot(state, key, originalIntent);
  if (!source) return refuse(state, "invalid-input");
  const fields = Object.freeze({ ...existing?.fields, ...patch });
  if (Object.keys(fields).length > 64) return refuse(state, "entry-limit");
  return replace(
    state,
    key,
    existing
      ? { ...existing, fields }
      : {
          key: Object.freeze({
            environmentId: key.environmentId,
            projectId: key.projectId,
            taskId: key.taskId,
            kind: key.kind,
          }),
          fields,
          originalIntentJson: source.json,
          needsReview: false,
          usedCommandIds: Object.freeze([]),
        },
  );
}

/** Read-only comparison never accepts a newer approval target. */
export function compareGuidedTaskDraft(
  state: GuidedTaskDraftState,
  key: GuidedTaskDraftKey,
  currentIntent: unknown,
) {
  const draft = state.entries.find((entry) => sameKey(entry.key, key));
  const current = snapshot(state, key, currentIntent);
  if (!draft || !current) return null;
  return Object.freeze({
    originalIntentJson: draft.originalIntentJson,
    currentIntentJson: current.json,
    targetsChanged: !sameTargets(decodeIntent(draft.originalIntentJson), current.intent),
  });
}

/** Explicitly accept reviewed targets while retaining edits. Uncertain/in-flight writes block this. */
export function rebaseGuidedTaskDraft(
  state: GuidedTaskDraftState,
  key: GuidedTaskDraftKey,
  currentIntent: unknown,
): Change {
  const draft = state.entries.find((entry) => sameKey(entry.key, key));
  if (!draft) return refuse(state, "missing-draft");
  if (draft.pending?.status === "sending" || draft.pending?.status === "uncertain")
    return refuse(state, "pending-submission");
  const current = snapshot(state, key, currentIntent);
  if (!current) return refuse(state, "invalid-input");
  const { pending: _pending, ...kept } = draft;
  return replace(state, key, { ...kept, originalIntentJson: current.json, needsReview: false });
}

export function beginGuidedTaskSubmission(
  state: GuidedTaskDraftState,
  key: GuidedTaskDraftKey,
  input: unknown,
) {
  const draft = state.entries.find((entry) => sameKey(entry.key, key));
  if (!draft) return refuse(state, "missing-draft");
  if (draft.pending) return refuse(state, "pending-submission");
  if (draft.needsReview) return refuse(state, "target-changed");
  const prepared = snapshot(state, key, input);
  if (!prepared) return refuse(state, "invalid-input");
  if (draft.usedCommandIds.includes(prepared.intent.commandId))
    return refuse(state, "command-id-reused");
  if (draft.usedCommandIds.length >= 256) return refuse(state, "capacity");
  if (!sameTargets(decodeIntent(draft.originalIntentJson), prepared.intent))
    return refuse(state, "target-changed");
  if (!Number.isSafeInteger(state.nextSubmissionVersion + 1)) return refuse(state, "capacity");
  const submission = Object.freeze({
    key: draft.key,
    version: state.nextSubmissionVersion,
    commandId: prepared.intent.commandId,
    intentJson: prepared.json,
    status: "sending" as const,
  });
  const changed = replace(state, key, {
    ...draft,
    usedCommandIds: Object.freeze([...draft.usedCommandIds, submission.commandId]),
    pending: submission,
  });
  return changed.ok
    ? {
        ...changed,
        state: Object.freeze({
          ...changed.state,
          nextSubmissionVersion: state.nextSubmissionVersion + 1,
        }),
        submission,
      }
    : changed;
}

function matches(
  draft: GuidedTaskDraft | undefined,
  submission: GuidedTaskDraftSubmission,
): draft is GuidedTaskDraft & { pending: GuidedTaskDraftSubmission } {
  return (
    draft?.pending !== undefined &&
    sameKey(draft.key, submission.key) &&
    draft.pending.commandId === submission.commandId &&
    draft.pending.version === submission.version &&
    draft.pending.intentJson === submission.intentJson
  );
}

/** Callbacks carry the original local submission snapshot, never the currently selected task. */
export function recordGuidedTaskDraftOutcome(
  state: GuidedTaskDraftState,
  submission: GuidedTaskDraftSubmission,
  outcome: GuidedTaskDraftOutcome,
): Change {
  const draft = state.entries.find((entry) => sameKey(entry.key, submission.key));
  if (!matches(draft, submission)) return refuse(state, "unmatched-submission");
  if (
    draft.pending.status === "stale" ||
    draft.pending.status === "denied" ||
    draft.pending.status === "unavailable"
  )
    return outcome === draft.pending.status
      ? { ok: true, state }
      : refuse(state, "settled-submission");
  return replace(
    state,
    draft.key,
    outcome === "success"
      ? null
      : {
          ...draft,
          needsReview: draft.needsReview || outcome === "stale",
          pending: Object.freeze({ ...draft.pending, status: outcome }),
        },
  );
}

export function retryGuidedTaskSubmission(state: GuidedTaskDraftState, key: GuidedTaskDraftKey) {
  const draft = state.entries.find((entry) => sameKey(entry.key, key));
  if (!draft?.pending || draft.pending.status !== "uncertain")
    return refuse(state, "not-uncertain");
  const submission = Object.freeze({ ...draft.pending, status: "sending" as const });
  const changed = replace(state, key, { ...draft, pending: submission });
  return changed.ok ? { ...changed, submission } : changed;
}

export function clearGuidedTaskSubmission(
  state: GuidedTaskDraftState,
  key: GuidedTaskDraftKey,
): Change {
  const draft = state.entries.find((entry) => sameKey(entry.key, key));
  if (!draft) return refuse(state, "missing-draft");
  if (draft.pending?.status === "sending") return refuse(state, "pending-submission");
  const { pending: _pending, ...kept } = draft;
  return replace(state, key, kept);
}

/** Discard is local only; it does not cancel or undo a server write. */
export function discardGuidedTaskDraft(
  state: GuidedTaskDraftState,
  key: GuidedTaskDraftKey,
): Change {
  return replace(state, key, null);
}
