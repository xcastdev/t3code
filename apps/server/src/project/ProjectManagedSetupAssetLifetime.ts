import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeUtil from "node:util";
import { PiManagedProcessAllocationSchema } from "../provider/pi/PiManagedProcess.ts";
import { ProjectManagedSetupError } from "./ProjectManagedSetup.ts";
import { makeProjectManagedSetupJournal } from "./ProjectManagedSetupJournal.ts";

const positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const natural = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const absolute = text.check(Schema.isPattern(/^\/[^\0\r\n]*$/));
const file = Schema.Struct({ source: absolute, target: absolute, dev: natural, ino: positive });
const stage = Schema.Struct({
  directory: absolute,
  files: Schema.Array(file).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
const input = Schema.Struct({
  setupId: text,
  dispatchId: text,
  bindingId: text,
  generation: natural,
  threadId: text,
  worktreePath: absolute,
  deadlineAtMs: positive,
});
const row = Schema.Struct({
  rowId: Schema.Int,
  setup_id: text,
  dispatch_id: text,
  unit: Schema.NullOr(text),
  selection_json: Schema.String,
  allocation_json: Schema.NullOr(Schema.String),
  status: Schema.Literals([
    "selected",
    "no-script",
    "allocated",
    "claimed",
    "captured",
    "completed",
    "failed",
    "uncertain",
  ]),
  owner_json: Schema.NullOr(Schema.String),
  drain_json: Schema.NullOr(Schema.String),
  input_json: Schema.String,
  activation: Schema.Literals(["unlaunched", "claimed", "owned"]),
  started_pid: Schema.NullOr(positive),
  receipt_json: Schema.NullOr(Schema.String),
  uncertainty_json: Schema.NullOr(Schema.String),
  environment_id: text,
  binding_id: text,
  generation: natural,
  worktree: absolute,
  attempt_deadline_at_ms: positive,
  intent_json: Schema.String,
  bounded: Schema.Literal(1),
});
// This projection checks original ownership, without consulting replayable project state.
const dispatchIdentity = Schema.fromJsonString(
  Schema.Struct({
    request: Schema.Struct({ dispatchId: text, setupId: text }),
    compiledClaim: Schema.Struct({
      transition: Schema.Struct({
        kind: Schema.Literal("claim"),
        binding: Schema.Struct({
          environmentId: text,
          recordId: text,
          generation: natural,
          threadId: text,
          worktree: absolute,
        }),
      }),
    }),
    limits: Schema.Struct({ deadlineAtMs: positive }),
  }),
);
const selectionClosure = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("script"),
    launch: Schema.Struct({
      runtimeFiles: Schema.Array(Schema.Struct({ source: absolute, target: absolute })).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(256),
      ),
    }),
  }),
]);
const closure = Schema.Struct({
  selection: selectionClosure,
  allocation: Schema.NullOr(PiManagedProcessAllocationSchema),
});
const uncertaintyClosure = Schema.Struct({
  expected: Schema.NullOr(closure),
  selection: Schema.NullOr(selectionClosure),
  allocation: Schema.NullOr(PiManagedProcessAllocationSchema),
});
const decodeSelectionClosure = Schema.decodeUnknownEffect(Schema.fromJsonString(selectionClosure));
const decodeAllocationClosure = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PiManagedProcessAllocationSchema),
  { onExcessProperty: "error" },
);
const decodeReceiptClosure = Schema.decodeUnknownEffect(Schema.fromJsonString(closure));
const decodeUncertaintyClosure = Schema.decodeUnknownEffect(
  Schema.fromJsonString(uncertaintyClosure),
);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const strict = { onExcessProperty: "error" } as const;
const decodeStage = Schema.decodeUnknownEffect(stage, strict);
const decodePage = Schema.decodeUnknownEffect(
  Schema.Array(row).check(Schema.isMaxLength(16)),
  strict,
);
const decodeInput = Schema.decodeUnknownEffect(Schema.fromJsonString(input), strict);
const decodeDispatch = Schema.decodeUnknownEffect(dispatchIdentity);
const same = NodeUtil.isDeepStrictEqual;

/** Cleanup knowledge only. Root fences borrowers and owns the eventual removal. */
export const makeProjectManagedSetupAssetLifetime = Effect.fn(
  "makeProjectManagedSetupAssetLifetime",
)(function* (options: { readonly environmentId: string }) {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const journal = yield* makeProjectManagedSetupJournal({
    environmentId: options.environmentId,
    maximumEnvironmentModelCalls: 2,
    validateSelection: () =>
      Effect.fail(new ProjectManagedSetupError({ reason: "Cleanup cannot authorize setup" })),
  });
  const canonical = (value: string) => path.resolve(value) === value;
  const readPage = (cursor: number | undefined, setupId?: string) => sql`
      SELECT setup.rowid AS "rowId",
        CASE WHEN length(CAST(setup.setup_id AS BLOB)) <= 4096 THEN setup.setup_id END AS setup_id,
        CASE WHEN length(CAST(setup.dispatch_id AS BLOB)) <= 4096 THEN setup.dispatch_id END AS dispatch_id,
        CASE WHEN length(CAST(setup.unit AS BLOB)) <= 4096 THEN setup.unit END AS unit,
        CASE WHEN length(CAST(setup.selection_json AS BLOB)) <= 262144 THEN setup.selection_json END AS selection_json,
        CASE WHEN length(CAST(setup.allocation_json AS BLOB)) <= 262144 THEN setup.allocation_json END AS allocation_json,
        CASE WHEN length(CAST(setup.status AS BLOB)) <= 4096 THEN setup.status END AS status,
        CASE WHEN length(CAST(setup.owner_json AS BLOB)) <= 262144 THEN setup.owner_json END AS owner_json,
        CASE WHEN length(CAST(setup.drain_json AS BLOB)) <= 262144 THEN setup.drain_json END AS drain_json,
        CASE WHEN length(CAST(setup.input_json AS BLOB)) <= 262144 THEN setup.input_json END AS input_json,
        CASE WHEN length(CAST(setup.activation AS BLOB)) <= 4096 THEN setup.activation END AS activation,
        setup.started_pid,
        CASE WHEN length(CAST(setup.receipt_json AS BLOB)) <= 262144 THEN setup.receipt_json END AS receipt_json,
        CASE WHEN length(CAST(setup.uncertainty_json AS BLOB)) <= 262144 THEN setup.uncertainty_json END AS uncertainty_json,
        CASE WHEN length(CAST(dispatch.environment_id AS BLOB)) <= 4096 THEN dispatch.environment_id END AS environment_id,
        CASE WHEN length(CAST(dispatch.binding_id AS BLOB)) <= 4096 THEN dispatch.binding_id END AS binding_id,
        dispatch.generation,
        CASE WHEN length(CAST(dispatch.worktree AS BLOB)) <= 4096 THEN dispatch.worktree END AS worktree,
        dispatch.attempt_deadline_at_ms,
        CASE WHEN length(CAST(dispatch.intent_json AS BLOB)) <= 262144 THEN dispatch.intent_json END AS intent_json,
        CASE WHEN
          (setup.unit IS NULL OR length(CAST(setup.unit AS BLOB)) <= 4096) AND
          (setup.allocation_json IS NULL OR length(CAST(setup.allocation_json AS BLOB)) <= 262144) AND
          (setup.owner_json IS NULL OR length(CAST(setup.owner_json AS BLOB)) <= 262144) AND
          (setup.drain_json IS NULL OR length(CAST(setup.drain_json AS BLOB)) <= 262144) AND
          (setup.receipt_json IS NULL OR length(CAST(setup.receipt_json AS BLOB)) <= 262144) AND
          (setup.uncertainty_json IS NULL OR length(CAST(setup.uncertainty_json AS BLOB)) <= 262144)
          THEN 1 ELSE 0 END AS bounded
      FROM project_team_setup_process setup
      LEFT JOIN project_team_dispatch dispatch ON dispatch.dispatch_id=setup.dispatch_id
      WHERE ${setupId === undefined ? sql`1` : sql`setup.setup_id=${setupId}`}
        AND ${cursor === undefined ? sql`1` : sql`setup.rowid > ${cursor}`}
      ORDER BY setup.rowid LIMIT 16`;
  const canRelease = Effect.fn("ProjectManagedSetupAssetLifetime.canRelease")(
    function* (raw: typeof stage.Type) {
      const owned = yield* decodeStage(raw);
      if (
        !canonical(owned.directory) ||
        owned.directory === "/" ||
        new Set(owned.files.map((f) => f.source)).size !== owned.files.length ||
        new Set(owned.files.map((f) => f.target)).size !== owned.files.length ||
        new Set(owned.files.map((f) => `${f.dev}:${f.ino}`)).size !== owned.files.length ||
        owned.files.some(
          (f) =>
            !canonical(f.source) ||
            !canonical(f.target) ||
            !f.source.startsWith(owned.directory + "/"),
        )
      )
        return false;
      const aliases = new Set(owned.files.map((f) => `${f.dev}:${f.ino}`));
      const relevant = (f: {
        readonly source: string;
        readonly dev?: number;
        readonly ino?: number;
      }) =>
        f.source === owned.directory ||
        f.source.startsWith(owned.directory + "/") ||
        aliases.has(`${f.dev}:${f.ino}`);
      const validFiles = (
        files: ReadonlyArray<{ readonly source: string; readonly target: string }>,
      ) =>
        files.length > 0 &&
        files.length <= 256 &&
        new Set(files.map((f) => f.source)).size === files.length &&
        new Set(files.map((f) => f.target)).size === files.length &&
        files.every((f) => canonical(f.source) && canonical(f.target));
      let cursor: number | undefined;
      let matched = 0;
      while (true) {
        const page = yield* decodePage(yield* readPage(cursor));
        for (const current of page) {
          if (cursor !== undefined && current.rowId <= cursor) return false;
          cursor = current.rowId;
          const original = yield* decodeInput(current.input_json);
          const identity = yield* decodeDispatch(current.intent_json);
          const binding = identity.compiledClaim.transition.binding;
          if (
            original.setupId !== current.setup_id ||
            original.dispatchId !== current.dispatch_id ||
            identity.request.setupId !== original.setupId ||
            identity.request.dispatchId !== original.dispatchId ||
            binding.environmentId !== current.environment_id ||
            original.bindingId !== current.binding_id ||
            binding.recordId !== original.bindingId ||
            binding.generation !== original.generation ||
            current.generation !== original.generation ||
            binding.threadId !== original.threadId ||
            binding.worktree !== original.worktreePath ||
            current.worktree !== original.worktreePath ||
            current.attempt_deadline_at_ms !== original.deadlineAtMs ||
            identity.limits.deadlineAtMs !== original.deadlineAtMs
          )
            return false;
          const selection = yield* decodeSelectionClosure(current.selection_json);
          const allocation =
            current.allocation_json === null
              ? null
              : yield* decodeAllocationClosure(current.allocation_json);
          const receiptClosure =
            current.receipt_json === null
              ? null
              : yield* decodeReceiptClosure(current.receipt_json);
          const heldClosure =
            current.uncertainty_json === null
              ? null
              : yield* decodeUncertaintyClosure(current.uncertainty_json);
          if (current.owner_json !== null) yield* decodeJson(current.owner_json);
          if (current.drain_json !== null) yield* decodeJson(current.drain_json);
          const closures = [
            { selection, allocation },
            ...(receiptClosure ? [receiptClosure] : []),
            ...(heldClosure
              ? [
                  { selection: heldClosure.selection, allocation: heldClosure.allocation },
                  ...(heldClosure.expected ? [heldClosure.expected] : []),
                ]
              : []),
          ];
          let references = false;
          for (const candidate of closures) {
            const selected =
              candidate.selection?.kind === "script" ? candidate.selection.launch.runtimeFiles : [];
            const allocated = candidate.allocation?.launch.runtimeFiles ?? [];
            if (
              (selected.length > 0 && !validFiles(selected)) ||
              (allocated.length > 0 && !validFiles(allocated))
            )
              return false;
            if (candidate.selection !== null && !same(candidate.selection, selection)) return false;
            if (candidate.allocation !== null && !same(candidate.allocation, allocation))
              return false;
            references ||= selected.some(relevant) || allocated.some(relevant);
          }
          // Foreign unrelated rows have bounded, canonical, consistent runtime closures in every
          // selection, allocation, receipt and uncertainty copy; none can name this stage or inode.
          // Local rows additionally use the reviewed full ownership/receipt validator.
          const ownership =
            references || current.environment_id === options.environmentId
              ? yield* journal.readOwnership(original)
              : null;
          if ((references || current.environment_id === options.environmentId) && !ownership)
            return false;
          if (references) {
            if (++matched > 1024 || current.environment_id !== options.environmentId) return false;
            if (!ownership) return false;
            const retained = ownership.retained;
            const receipt = retained.receipt;
            if (
              !receipt ||
              receipt.outcome === "skipped" ||
              !retained.allocation ||
              (!receipt.drain && !receipt.reconciliation)
            )
              return false;
            const borrowed = retained.allocation.launch.runtimeFiles.filter(relevant);
            if (
              borrowed.length === 0 ||
              borrowed.some((f) => !owned.files.some((entry) => same(f, entry)))
            )
              return false;
            if (ownership.uncertainty !== null) {
              const held = ownership.uncertainty;
              const { uncertain: _uncertain, ...snapshot } = retained;
              if (
                !same(held.expected, snapshot) ||
                !same(held.selection, retained.selection) ||
                !same(held.allocation, retained.allocation) ||
                !same(held.owner, retained.owner) ||
                !same(held.drain, receipt.drain) ||
                !same(held.reconciliation, receipt.reconciliation)
              )
                return false;
            }
          }
          // Compare every selected scalar and JSON byte after validation; stale reads never release.
          const reread = yield* decodePage(yield* readPage(undefined, current.setup_id));
          if (reread.length !== 1 || !same(current, reread[0])) return false;
        }
        if (page.length < 16) return true;
      }
    },
    Effect.catch(() => Effect.succeed(false)),
  );
  return { canRelease };
});
