import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  ProjectTeamRunBinding,
  ProjectTeamRoleRevision,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  PiNativeReference,
  PiWorkerIdentity,
  PiWorkerOperation,
} from "../provider/pi/PiWorkerProtocol.ts";
import { PiManagedProcessAllocationSchema } from "../provider/pi/PiManagedProcess.ts";
import { readPiNativeSessionWithBytes } from "../provider/pi/PiNativeSessionReader.ts";

const encode = canonicalProjectWorkPayload;
const digest = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const strict = { onExcessProperty: "error" } as const;
const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter((v) => v === v.trim()),
);
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Positive = Safe.check(Schema.isGreaterThan(0));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const bounded = (bytes: number) =>
  Schema.String.check(Schema.makeFilter((v) => Buffer.byteLength(v) <= bytes));
const Path = bounded(4096).check(
  Schema.isPattern(/^\/(?:[^/\0]+(?:\/[^/\0]+)*)?$/),
  Schema.makeFilter((v) => !v.split("/").some((part) => part === "." || part === "..")),
);
const Ownership = Schema.Struct({
  projectId: Id,
  taskId: Id,
  bindingId: Id,
  generation: Safe,
  providerInstanceId: Id,
  threadId: Id,
  specRevision: Safe,
  planRevision: Safe,
});
const CaptureFields = Schema.Struct({
  ...Ownership.fields,
  operationId: Id,
  sessionDirectoryRoot: Path,
  expectedCwd: Path,
  native: PiNativeReference,
  expectedBriefing: bounded(131072).check(Schema.isMinLength(1)),
});
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: Id,
  ...Ownership.fields,
  operationId: Id,
  sessionDirectoryRoot: Path,
  expectedCwd: Path,
  native: PiNativeReference,
  briefingSHA256: Digest,
  contentSHA256: Digest,
  byteCount: Positive.check(Schema.isLessThanOrEqualTo(4194304)),
});
export type ProjectTeamReviewFreshnessReceipt = typeof Manifest.Type;
export type ProjectTeamReviewFreshnessCaptureInput<
  E = never,
  R = never,
> = typeof CaptureFields.Type & {
  readonly assertCurrent: Effect.Effect<void, E, R>;
};
export class ProjectTeamReviewFreshnessError extends Schema.TaggedError<ProjectTeamReviewFreshnessError>()(
  "ProjectTeamReviewFreshnessError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "inherited-transaction",
      "invalid-operation",
      "not-fresh",
      "conflict",
      "unavailable",
    ]),
  },
) {
  override readonly stack = this.message;
}
const deny = (reason: ProjectTeamReviewFreshnessError["reason"]) =>
  new ProjectTeamReviewFreshnessError({ reason });
const isError = Schema.is(ProjectTeamReviewFreshnessError);
const isCapture = Schema.is(CaptureFields);
const SessionOwner = Schema.Struct({ ...Ownership.fields, sessionId: Id });
const isSessionOwner = Schema.is(SessionOwner);
const decodeSessionOwner = Schema.decodeUnknownSync(SessionOwner, strict);
const isId = Schema.is(Id);
const isSafe = Schema.is(Safe);
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeManifest = Schema.decodeUnknownSync(Manifest, strict);
const decodeNative = Schema.decodeUnknownSync(PiNativeReference, strict);
const Request = Schema.Struct({
  operationId: Id,
  threadId: ThreadId,
  kind: Schema.Literal("initialize"),
  runtimeMode: Schema.optionalKey(Schema.Literal("approval-required")),
  cwd: Schema.optionalKey(bounded(4096)),
  modelSelection: Schema.optionalKey(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      model: Id,
      options: Schema.optionalKey(Schema.JsonObject),
    }),
  ),
  resumeCursor: Schema.optionalKey(Schema.NullOr(PiNativeReference)),
  skillPlan: Schema.optionalKey(Schema.JsonObject),
});
const Limits = Schema.Struct({ maximumTokens: Positive, deadlineAtMs: Positive });
const Intent = Schema.Struct({
  request: Request,
  binding: ProjectTeamRunBinding,
  role: ProjectTeamRoleRevision,
  allocation: PiManagedProcessAllocationSchema,
  resourceHash: Digest,
  rootBudget: Schema.Struct({ rootTaskId: Id, ...Limits.fields }),
  operationLimits: Limits,
});
const Drain = Schema.Struct({
  unit: Id,
  invocation: Id,
  cgroup: bounded(4096),
  ownerPid: Positive,
  memoryBytes: Positive,
  swapBytes: Schema.Literal(0),
  oomGroup: Schema.Literal(1),
  launcherPid: Positive,
  childPid: Positive,
  childExitCode: Schema.Literal(0),
  kernel: bounded(128),
});
const Owner = Schema.Struct({
  type: Schema.Literal("owner"),
  unit: Id,
  nonce: Id,
  invocation: Id,
  cgroup: bounded(4096),
  pid: Positive,
  memoryBytes: Positive,
  swapBytes: Schema.Literal(0),
  oomGroup: Schema.Literal(1),
});
const Terminal = Schema.Struct({
  identity: PiWorkerIdentity,
  operation: PiWorkerOperation,
  outcome: Schema.Literal("success"),
  ownerCaptured: Schema.Literal(true),
  native: PiNativeReference,
  drain: Drain,
  accountingReceipts: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(0)),
});
const decodeIntent = Schema.decodeUnknownSync(Intent, strict);
const decodeTerminal = Schema.decodeUnknownSync(Terminal, strict);
const decodeDrain = Schema.decodeUnknownSync(Drain, strict);
const decodeOwner = Schema.decodeUnknownSync(Owner, strict);
const Timestamp = bounded(32).check(
  Schema.makeFilter((v) => {
    const date = DateTime.make(v);
    return Option.isSome(date) && DateTime.formatIso(date.value) === v;
  }),
);
const Token = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const Header = Schema.Struct({
  type: Schema.Literal("session"),
  version: Schema.Literal(3),
  id: Token,
  timestamp: Timestamp,
  cwd: Path,
});
const EntryFields = { id: Token, parentId: Schema.NullOr(Token), timestamp: Timestamp };
const Entry = Schema.Union([
  Schema.Struct({
    ...EntryFields,
    type: Schema.Literal("custom"),
    customType: Schema.Literal("t3-approved-initial-context"),
    data: Schema.Struct({ text: bounded(131072).check(Schema.isMinLength(1)) }),
  }),
  Schema.Struct({
    ...EntryFields,
    type: Schema.Literal("message"),
    message: Schema.Struct({
      role: Schema.Literal("user"),
      timestamp: Safe,
      content: Schema.Array(
        Schema.Struct({ type: Schema.Literal("text"), text: bounded(131072) }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
    }),
  }),
  Schema.Struct({
    ...EntryFields,
    type: Schema.Literal("model_change"),
    provider: Id,
    modelId: Id,
  }),
  Schema.Struct({
    ...EntryFields,
    type: Schema.Literal("thinking_level_change"),
    thinkingLevel: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh"]),
  }),
  Schema.Struct({
    ...EntryFields,
    type: Schema.Literal("session_info"),
    name: Schema.optionalKey(bounded(4000)),
  }),
]);
const decodeHeader = Schema.decodeUnknownSync(Header, strict);
const decodeEntry = Schema.decodeUnknownSync(Entry, strict);

// Inspect every entry, including unused branches. The supplied initial briefing is
// permitted context; prior conversation or extension-injected context is not.
function qualifyRaw(raw: string, manifest: ProjectTeamReviewFreshnessReceipt) {
  if (
    Buffer.byteLength(raw) !== manifest.byteCount ||
    digest(raw) !== manifest.contentSHA256 ||
    !raw.endsWith("\n")
  )
    throw deny("not-fresh");
  const lines = raw.slice(0, -1).split("\n");
  if (lines.length < 2 || lines.length > 10001) throw deny("not-fresh");
  const header = decodeHeader(parseJson(lines[0]!));
  if (
    header.id !== manifest.native.sessionId ||
    header.cwd !== manifest.expectedCwd ||
    !manifest.native.persisted
  )
    throw deny("not-fresh");
  let previous: string | null = null;
  const ids = new Set<string>();
  let briefing: string | undefined;
  let hasMessage = false;
  for (const line of lines.slice(1)) {
    const entry = decodeEntry(parseJson(line));
    if (entry.parentId !== previous || ids.has(entry.id)) throw deny("not-fresh");
    ids.add(entry.id);
    previous = entry.id;
    if (entry.type === "custom") {
      if (briefing !== undefined || hasMessage) throw deny("not-fresh");
      briefing = entry.data.text;
    }
    if (entry.type === "message") {
      if (hasMessage) throw deny("not-fresh");
      const text = entry.message.content[0]!.text;
      if (briefing !== undefined) {
        if (text !== "Session initialized. Approved context is supplied separately.")
          throw deny("not-fresh");
      } else {
        // Older initialized journals retained the briefing in a single user message.
        // Keep those immutable freshness receipts readable.
        briefing = text;
      }
      hasMessage = true;
    }
  }
  if (
    previous !== manifest.native.leafId ||
    !hasMessage ||
    briefing === undefined ||
    digest(briefing) !== manifest.briefingSHA256
  )
    throw deny("not-fresh");
  return briefing;
}
interface OperationRow {
  operationId: string;
  environmentId: string;
  projectId: string;
  bindingId: string;
  generation: number;
  providerInstanceId: string;
  threadId: string;
  workerId: string;
  ordinal: number;
  kind: string;
  status: string;
  requestHash: string;
  intent: string | null;
  native: string | null;
  terminal: string | null;
}
interface ReceiptRow {
  operationId: string;
  environmentId: string;
  projectId: string;
  bindingId: string;
  generation: number;
  providerInstanceId: string;
  threadId: string;
  sessionId: string;
  manifest: string | null;
  raw: string | null;
}

/** Retained initialization observations only. The caller establishes current authority separately. */
export const makeProjectTeamReviewFreshness = Effect.fn("makeProjectTeamReviewFreshness")(
  function* (options: { readonly environmentId: string }) {
    const environmentId = options.environmentId;
    if (!isId(environmentId)) return yield* deny("invalid-input");
    const sql = yield* SqlClient.SqlClient;
    const independent = Effect.gen(function* () {
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* deny("inherited-transaction");
      const supplied = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (Option.isSome(supplied) && supplied.value !== sql)
        return yield* deny("inherited-transaction");
    });
    const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause))
            return Effect.failCause(
              Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)),
            );
          const failure = Cause.squash(cause);
          return Effect.fail(isError(failure) ? failure : deny("unavailable"));
        }),
      );
    const checkOperation = Effect.fn("ReviewFreshness.checkOperation")(function* (
      manifest: ProjectTeamReviewFreshnessReceipt,
      latest: boolean,
    ) {
      const rows =
        yield* sql<OperationRow>`SELECT operation_id AS operationId,environment_id AS environmentId,
        project_id AS projectId,binding_id AS bindingId,generation,provider_instance_id AS providerInstanceId,
        thread_id AS threadId,worker_id AS workerId,operation_ordinal AS ordinal,operation_kind AS kind,status,
        request_hash AS requestHash,
        CASE WHEN length(CAST(intent_json AS BLOB))<=1048576 THEN intent_json END AS intent,
        CASE WHEN length(CAST(native_json AS BLOB))<=8192 THEN native_json END AS native,
        CASE WHEN length(CAST(terminal_json AS BLOB))<=262144 THEN terminal_json END AS terminal
        FROM project_team_pi_operation WHERE operation_id=${manifest.operationId} LIMIT 2`;
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        row.intent === null ||
        row.native === null ||
        row.terminal === null ||
        !isSafe(row.ordinal) ||
        row.kind !== "initialize" ||
        row.status !== "settled" ||
        row.environmentId !== environmentId ||
        row.projectId !== manifest.projectId ||
        row.bindingId !== manifest.bindingId ||
        row.generation !== manifest.generation ||
        row.providerInstanceId !== manifest.providerInstanceId ||
        row.threadId !== manifest.threadId
      )
        return yield* deny("invalid-operation");
      const intent = decodeIntent(parseJson(row.intent));
      const native = decodeNative(parseJson(row.native));
      const terminal = decodeTerminal(parseJson(row.terminal));
      const binding = intent.binding;
      if (
        encode(parseJson(row.intent)) !== encode(intent) ||
        encode(parseJson(row.native)) !== encode(native) ||
        encode(parseJson(row.terminal)) !== encode(terminal) ||
        digest(encode(intent.request)) !== row.requestHash ||
        binding.environmentId !== environmentId ||
        binding.projectId !== manifest.projectId ||
        binding.taskId !== manifest.taskId ||
        binding.recordId !== manifest.bindingId ||
        binding.generation !== manifest.generation ||
        binding.providerInstanceId !== manifest.providerInstanceId ||
        binding.threadId !== manifest.threadId ||
        binding.specRevision !== manifest.specRevision ||
        binding.planRevision !== manifest.planRevision ||
        intent.role.role !== "reviewer" ||
        intent.role.projectId !== binding.projectId ||
        intent.role.recordId !== binding.roleRevisionId ||
        digest(intent.role.instructions) !== binding.configuration.instructionsHash ||
        intent.request.operationId !== manifest.operationId ||
        intent.request.threadId !== binding.threadId ||
        (intent.request.resumeCursor !== undefined && intent.request.resumeCursor !== null) ||
        (intent.request.cwd !== undefined && intent.request.cwd !== binding.worktree) ||
        encode(native) !== encode(manifest.native) ||
        encode(terminal.native) !== encode(native) ||
        terminal.operation.operationId !== manifest.operationId ||
        terminal.operation.operationKind !== "initialize" ||
        terminal.identity.workerId !== row.workerId ||
        terminal.identity.generation !== manifest.generation ||
        manifest.sessionDirectoryRoot !== intent.allocation.launch.nativeStateRoot + "/sessions"
      )
        return yield* deny("invalid-operation");
      const processes = yield* sql<{
        unit: string;
        status: string;
        allocation: string | null;
        owner: string | null;
        drain: string | null;
      }>`
        SELECT unit,status,
          CASE WHEN length(CAST(allocation_json AS BLOB))<=262144 THEN allocation_json END AS allocation,
          CASE WHEN length(CAST(owner_json AS BLOB))<=262144 THEN owner_json END AS owner,
          CASE WHEN length(CAST(drain_json AS BLOB))<=262144 THEN drain_json END AS drain
        FROM project_team_pi_process WHERE operation_id=${manifest.operationId} LIMIT 2`;
      const process = processes[0];
      if (
        processes.length !== 1 ||
        !process ||
        process.status !== "drained" ||
        process.allocation === null ||
        process.owner === null ||
        process.drain === null
      )
        return yield* deny("invalid-operation");
      const owner = decodeOwner(parseJson(process.owner));
      const drain = decodeDrain(parseJson(process.drain));
      if (
        encode(parseJson(process.allocation)) !== encode(intent.allocation) ||
        process.unit !== intent.allocation.unit ||
        encode(drain) !== encode(terminal.drain) ||
        owner.unit !== process.unit ||
        drain.unit !== process.unit ||
        owner.nonce !== intent.allocation.nonce ||
        owner.invocation !== drain.invocation ||
        owner.cgroup !== drain.cgroup ||
        owner.pid !== drain.ownerPid ||
        owner.memoryBytes !== drain.memoryBytes ||
        owner.memoryBytes !== intent.allocation.policy.memoryBytes ||
        (drain.kernel !== "removed" &&
          drain.kernel !== "populated 0\nfrozen 0\n" &&
          drain.kernel !== "populated 0\nfrozen 0")
      )
        return yield* deny("invalid-operation");
      if (latest) {
        const successors = yield* sql`SELECT operation_id FROM project_team_pi_operation
          WHERE environment_id=${environmentId} AND (binding_id=${manifest.bindingId} AND generation=${manifest.generation}
            OR provider_instance_id=${manifest.providerInstanceId} AND thread_id=${manifest.threadId})
          AND (operation_ordinal>${row.ordinal} OR status IN ('prepared','starting','running','quarantine')) LIMIT 1`;
        if (successors.length) return yield* deny("invalid-operation");
      }
    });
    const readInside = Effect.fn("ReviewFreshness.readInside")(function* (operationId: string) {
      const rows =
        yield* sql<ReceiptRow>`SELECT operation_id AS operationId,environment_id AS environmentId,
        project_id AS projectId,binding_id AS bindingId,generation,provider_instance_id AS providerInstanceId,
        thread_id AS threadId,session_id AS sessionId,
        CASE WHEN length(CAST(manifest_json AS BLOB))<=32768 THEN manifest_json END AS manifest,
        CASE WHEN length(CAST(native_jsonl AS BLOB)) BETWEEN 1 AND 4194304 THEN native_jsonl END AS raw
        FROM project_team_review_freshness WHERE operation_id=${operationId} LIMIT 2`;
      const row = rows[0];
      if (rows.length === 0) return undefined;
      if (rows.length !== 1 || !row || row.manifest === null || row.raw === null)
        return yield* deny("conflict");
      const manifest = decodeManifest(parseJson(row.manifest));
      if (
        encode(manifest) !== row.manifest ||
        manifest.environmentId !== environmentId ||
        manifest.operationId !== row.operationId ||
        row.operationId !== operationId ||
        manifest.environmentId !== row.environmentId ||
        manifest.projectId !== row.projectId ||
        manifest.bindingId !== row.bindingId ||
        manifest.generation !== row.generation ||
        manifest.providerInstanceId !== row.providerInstanceId ||
        manifest.threadId !== row.threadId ||
        manifest.native.sessionId !== row.sessionId
      )
        return yield* deny("conflict");
      qualifyRaw(row.raw, manifest);
      yield* checkOperation(manifest, false);
      return manifest;
    });
    const captureOwned = Effect.fn("ReviewFreshness.capture")(function* <E, R>(
      input: typeof CaptureFields.Type,
      assertCurrent: Effect.Effect<void, E, R>,
    ) {
      yield* independent;
      yield* assertCurrent;
      const prior = yield* sql.withTransaction(readInside(input.operationId));
      const expected = {
        version: 1 as const,
        environmentId,
        projectId: input.projectId,
        taskId: input.taskId,
        bindingId: input.bindingId,
        generation: input.generation,
        providerInstanceId: input.providerInstanceId,
        threadId: input.threadId,
        operationId: input.operationId,
        specRevision: input.specRevision,
        planRevision: input.planRevision,
        sessionDirectoryRoot: input.sessionDirectoryRoot,
        expectedCwd: input.expectedCwd,
        native: input.native,
        briefingSHA256: digest(input.expectedBriefing),
      };
      if (prior !== undefined) {
        const { byteCount: _count, contentSHA256: _hash, ...original } = prior;
        if (encode(original) !== encode(expected)) return yield* deny("conflict");
        yield* sql.withTransaction(checkOperation(prior, true));
        yield* assertCurrent;
        return prior;
      }
      const snapshot = yield* Effect.tryPromise({
        try: () => readPiNativeSessionWithBytes(input),
        catch: () => deny("not-fresh"),
      });
      yield* assertCurrent;
      const manifest = {
        ...expected,
        byteCount: snapshot.byteCount,
        contentSHA256: snapshot.contentSHA256,
      };
      const raw = snapshot.bytes.toString("utf8");
      if (
        digest(snapshot.bytes) !== snapshot.contentSHA256 ||
        snapshot.bytes.length !== snapshot.byteCount ||
        qualifyRaw(raw, manifest) !== input.expectedBriefing
      )
        return yield* deny("not-fresh");
      const encoded = encode(manifest);
      if (Buffer.byteLength(encoded) > 32768) return yield* deny("invalid-input");
      yield* assertCurrent;
      // Host callbacks can perform authority SQL; keep them outside this owned transaction.
      const retained = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* checkOperation(manifest, true);
          yield* sql`INSERT INTO project_team_review_freshness
          (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,session_id,manifest_json,native_jsonl)
          VALUES (${manifest.operationId},${environmentId},${manifest.projectId},${manifest.bindingId},${manifest.generation},
            ${manifest.providerInstanceId},${manifest.threadId},${manifest.native.sessionId},${encoded},${raw}) ON CONFLICT(operation_id) DO NOTHING`;
          const receipt = yield* readInside(input.operationId);
          if (receipt === undefined || encode(receipt) !== encoded) return yield* deny("conflict");
          const rows = yield* sql<{
            raw: string;
          }>`SELECT native_jsonl AS raw FROM project_team_review_freshness WHERE operation_id=${input.operationId}`;
          if (rows[0]?.raw !== raw) return yield* deny("conflict");
          yield* checkOperation(manifest, true);
          return receipt;
        }),
      );
      yield* assertCurrent;
      return retained;
    });
    const readRetained = Effect.fn("ReviewFreshness.readRetained")(function* (operationId: string) {
      yield* independent;
      if (!isId(operationId)) return yield* deny("invalid-input");
      return yield* sql.withTransaction(readInside(operationId));
    });
    const readSessionInside = Effect.fn("ReviewFreshness.readSessionInside")(function* (
      fields: typeof SessionOwner.Type,
    ) {
      const rows = yield* sql<{
        operationId: string;
      }>`SELECT operation_id AS operationId FROM project_team_review_freshness
          WHERE environment_id=${environmentId} AND binding_id=${fields.bindingId} AND generation=${fields.generation}
            AND provider_instance_id=${fields.providerInstanceId} AND thread_id=${fields.threadId} AND session_id=${fields.sessionId} LIMIT 2`;
      if (rows.length !== 1) return yield* deny("conflict");
      const receipt = yield* readInside(rows[0]!.operationId);
      if (
        receipt === undefined ||
        receipt.projectId !== fields.projectId ||
        receipt.taskId !== fields.taskId ||
        receipt.specRevision !== fields.specRevision ||
        receipt.planRevision !== fields.planRevision
      )
        return yield* deny("conflict");
      return receipt;
    });
    const readSessionOwned = Effect.fn("ReviewFreshness.readForSession")(function* (
      fields: typeof SessionOwner.Type,
    ) {
      yield* independent;
      return yield* sql.withTransaction(readSessionInside(fields));
    });
    const readSessionInTransaction = Effect.fn("ReviewFreshness.readForSessionInTransaction")(
      function* (fields: typeof SessionOwner.Type) {
        const supplied = yield* Effect.serviceOption(SqlClient.SqlClient);
        if (
          Option.isNone(supplied) ||
          supplied.value !== sql ||
          Option.isNone(yield* Effect.serviceOption(sql.transactionService))
        )
          return yield* deny("inherited-transaction");
        // Bind only after checking the caller; keep its transaction connection loan.
        return yield* readSessionInside(fields).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
      },
    );
    return {
      capture: <E, R>(input: ProjectTeamReviewFreshnessCaptureInput<E, R>) => {
        const { assertCurrent, ...fields } = input;
        if (!isCapture(fields)) return Effect.fail(deny("invalid-input"));
        return protect(captureOwned(structuredClone(fields), assertCurrent));
      },
      readRetained: (operationId: string) => protect(readRetained(operationId)),
      readForSession: (input: typeof SessionOwner.Type) =>
        isSessionOwner(input)
          ? protect(readSessionOwned(structuredClone(input)))
          : Effect.fail(deny("invalid-input")),
      readForSessionInTransaction: (input: typeof SessionOwner.Type) => {
        let fields: typeof SessionOwner.Type;
        try {
          const copy: unknown = structuredClone(input);
          fields = decodeSessionOwner(copy);
          if (encode(copy) !== encode(fields)) return Effect.fail(deny("invalid-input"));
        } catch {
          return Effect.fail(deny("invalid-input"));
        }
        return protect(readSessionInTransaction(fields));
      },
    };
  },
);
