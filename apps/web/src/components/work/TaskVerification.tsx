import { sha256 } from "@noble/hashes/sha2";
import { asProjectWorkVerificationJob } from "@t3tools/client-runtime/project-work";
import { projectWorkEnvironment } from "../../state/projectWork";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  ProjectTeamRecord,
  ProjectWorkTask,
  ProjectWorkCriterion,
  ProjectWorkWriteIntent,
  canonicalProjectWorkPayload,
  type ProjectTeamWriteIntent,
  type ProjectTeamRecord as TeamRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { WorkCard } from "./WorkDataNotice";
import { projectWorkCommandFailure } from "./workCommandFailure";
import type {
  EnvironmentId,
  ProjectId,
  ProjectTeamRecordRead,
  ProjectWorkTaskContext,
} from "@t3tools/contracts";
import {
  beginGuidedTaskSubmission,
  createGuidedTaskDraftState,
  discardGuidedTaskDraft,
  editGuidedTaskDraft,
  recordGuidedTaskDraftOutcome,
  retryGuidedTaskSubmission,
  type GuidedTaskDraftStore,
  type GuidedTaskDraftSubmission,
} from "./guidedTaskDraft";
export const TaskVerificationDraftContext = createContext<GuidedTaskDraftStore | null>(null);
/** WorkPage supplies a registry read, so a stale rendered control cannot retain access. */
export const TaskVerificationAccessContext = createContext<(() => void) | null>(null);
export interface TaskVerificationSnapshot {
  readonly context: ProjectWorkTaskContext;
  readonly records: ReadonlyArray<ProjectTeamRecordRead>;
}
export interface TaskVerificationProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly context: ProjectWorkTaskContext | null;
  readonly records: ReadonlyArray<ProjectTeamRecordRead>;
  readonly current: boolean;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly verify: () => TaskVerificationSnapshot;
  readonly onWrite: (intent: ProjectWorkWriteIntent) => Promise<void>;
  readonly onRefresh: () => void;
}

type VerificationIntent = Extract<
  ProjectTeamWriteIntent,
  { readonly type: "project-team.verification.propose" | "project-team.gate.respond" }
>;
type Gate = Extract<TeamRecord, { readonly kind: "gate" }>;
type Preview = NonNullable<ReturnType<typeof asProjectWorkVerificationJob>>;
type Review = {
  readonly gateId: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly record: Preview;
};
const digest = (value: unknown) =>
  [...sha256(new TextEncoder().encode(canonicalProjectWorkPayload(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
type Binding = Extract<TeamRecord, { readonly kind: "run-binding" }>;
const isRecord = Schema.is(ProjectTeamRecord);
const knownRecord = (value: unknown): value is TeamRecord => isRecord(value);
const knownTask = Schema.is(ProjectWorkTask);
const knownCriterion = Schema.is(ProjectWorkCriterion);
const jsonIntent = Schema.fromJsonString(ProjectWorkWriteIntent);
const decodeIntent = Schema.decodeUnknownSync(jsonIntent);
const decodeWrite = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
const decodeArguments = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const one = <T,>(values: ReadonlyArray<T>) => (values.length === 1 ? values[0] : undefined);
const changed = () =>
  new Error("The verification target changed. Refresh and review it before submitting.");

function selection(
  snapshot: TaskVerificationSnapshot,
  props: Pick<TaskVerificationProps, "environmentId" | "projectId" | "context">,
) {
  const { context, records } = snapshot;
  const task = context.task;
  if (
    context.projectId !== props.projectId ||
    task.projectId !== props.projectId ||
    task.taskId !== props.context?.task.taskId ||
    !knownTask(task) ||
    !Number.isSafeInteger(context.revision) ||
    records.length > 2048 ||
    !records.every(
      (r) =>
        knownRecord(r) &&
        r.projectId === props.projectId &&
        Number.isSafeInteger(r.revision) &&
        r.revision <= context.revision,
    ) ||
    new Set(records.map((r) => r.recordId)).size !== records.length ||
    !context.criteria.every((c) => knownCriterion(c) && c.taskId === task.taskId) ||
    new Set(context.criteria.map((c) => c.criterionId)).size !== context.criteria.length
  )
    return null;
  const known = records.filter(knownRecord);
  const taskRecords = known.filter((r) => "taskId" in r && r.taskId === task.taskId);
  const membership = one(taskRecords.filter((r) => r.kind === "task-membership"));
  const plans = taskRecords.filter(
    (r): r is Extract<TeamRecord, { kind: "plan-revision" }> =>
      r.kind === "plan-revision" && r.status === "proposed",
  );
  const plan = one(
    plans.filter((r) => r.kind === "plan-revision" && r.specRevision === task.specRevision),
  );
  const bindings = taskRecords.filter(
    (r): r is Binding =>
      r.kind === "run-binding" &&
      r.environmentId === props.environmentId &&
      r.status === "settled" &&
      r.specRevision === task.specRevision &&
      r.planRevision === plan?.planRevision &&
      r.generation === r.leaseGeneration &&
      r.repairEpisodeId === undefined &&
      known.filter(
        (role) =>
          role.kind === "role-revision" &&
          role.recordId === r.roleRevisionId &&
          role.role === "implementer",
      ).length === 1,
  );
  const gates = taskRecords.filter(
    (r): r is Gate => r.kind === "gate" && r.gate === "verification",
  );
  const eligible =
    membership?.kind === "task-membership" &&
    membership.status === "active" &&
    membership.executionKind === "managed" &&
    membership.deliverableKind === "code" &&
    (membership.controlState === undefined || membership.controlState === "active") &&
    task.specification?.revision === task.specRevision &&
    task.state !== "draft" &&
    task.state !== "canceled" &&
    task.state !== "completed" &&
    plans.length === 1 &&
    plan?.kind === "plan-revision" &&
    !context.activeAttempt &&
    !taskRecords.some((r) => r.kind === "run-binding" && r.status !== "settled");
  return {
    task,
    context,
    plan: plan?.kind === "plan-revision" ? plan : undefined,
    bindings,
    gates,
    eligible,
  };
}

function reviewTarget(
  snapshot: TaskVerificationSnapshot,
  props: Pick<TaskVerificationProps, "environmentId" | "projectId" | "context">,
  gate: Gate,
  preview: Preview,
) {
  const found = selection(snapshot, props);
  const manifest = preview.manifest;
  if (
    !found ||
    !found.plan ||
    found.gates.filter((g) => g.verificationJobId === gate.verificationJobId).length !== 1 ||
    gate.verificationJobId !== manifest.jobId ||
    preview.sha256 !== gate.contentHash ||
    digest(manifest) !== preview.sha256 ||
    manifest.environmentId !== props.environmentId ||
    manifest.projectId !== props.projectId ||
    manifest.taskId !== found.task.taskId ||
    manifest.specRevision !== found.task.specRevision ||
    gate.specRevision !== manifest.specRevision ||
    gate.planRevision !== manifest.planRevision ||
    found.plan.planRevision !== manifest.planRevision ||
    found.plan.contentHash !== manifest.planHash
  )
    return null;
  const binding = found.bindings.find(
    (b) =>
      b.recordId === manifest.bindingId &&
      b.generation === manifest.generation &&
      b.worktree === manifest.target.worktree &&
      b.branch === manifest.target.branchRef,
  );
  if (
    !binding ||
    !manifest.criteria.every(
      (item) =>
        found.task.specification?.criterionIds.includes(item.criterionId) &&
        found.context.criteria.some(
          (c) => c.criterionId === item.criterionId && c.revision === item.revision,
        ),
    )
  )
    return null;
  return canonicalProjectWorkPayload({
    revision: found.context.revision,
    task: found.task,
    gate,
    binding,
    plan: found.plan,
    criteria: found.context.criteria.filter((c) =>
      manifest.criteria.some((item) => item.criterionId === c.criterionId),
    ),
  });
}

export function TaskVerification(props: TaskVerificationProps) {
  return (
    <VerificationSession
      key={JSON.stringify([props.environmentId, props.projectId, props.context?.task.taskId])}
      {...props}
    />
  );
}
function VerificationSession(props: TaskVerificationProps) {
  const [gatePage, setGatePage] = useState(0);
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(false);
  const readVersion = useRef(0);
  const readPreview = useAtomQueryRunner(projectWorkEnvironment.verificationJob, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const verifyAccess = useContext(TaskVerificationAccessContext);
  const pageStore = useContext(TaskVerificationDraftContext);
  const [localSnapshot, changedDrafts] = useState(createGuidedTaskDraftState);
  const localDrafts = useRef(localSnapshot);
  const localStore = useMemo<GuidedTaskDraftStore>(
    () => ({
      snapshot: localSnapshot,
      read: () => localDrafts.current,
      write: (state) => {
        localDrafts.current = state;
        changedDrafts(state);
      },
    }),
    [localSnapshot],
  );
  const store = pageStore ?? localStore;
  const draftSnapshot = pageStore?.snapshot ?? localSnapshot;
  const ownerDrafts = draftSnapshot.entries.filter(
    (entry) =>
      entry.key.environmentId === props.environmentId &&
      entry.key.projectId === props.projectId &&
      entry.key.taskId === props.context?.task.taskId &&
      (entry.key.kind === "project-team.verification.propose" ||
        entry.key.kind === "project-team.gate.respond"),
  );
  const retained = ownerDrafts.find((entry) => entry.pending);
  const pending = retained?.pending
    ? {
        json: retained.pending.intentJson,
        fingerprint: retained.fields.fingerprint ?? "",
        uncertain: retained.pending.status === "uncertain",
        submission: retained.pending,
      }
    : null;
  const [executable, setExecutable] = useState(retained?.fields.executable ?? "");
  const [argv, setArgv] = useState(retained?.fields.argv ?? "[]");
  const [duration, setDuration] = useState(retained?.fields.duration ?? "120000");
  const [output, setOutput] = useState(retained?.fields.output ?? "65536");
  const [covered, setCovered] = useState<ReadonlyArray<string>>(() =>
    retained ? decodeArguments(retained.fields.covered ?? "[]") : [],
  );
  const [selected, setSelected] = useState<Binding | null>(() => {
    const record: unknown = retained?.fields.binding ? JSON.parse(retained.fields.binding) : null;
    return knownRecord(record) && record.kind === "run-binding" ? record : null;
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const busy = sending || pending?.submission.status === "sending";
  const lock = useRef(false);
  const mounted = useRef(false);
  const live = useRef(props);
  const [acceptedRevision, setAcceptedRevision] = useState<number | null>(null);
  useLayoutEffect(() => {
    live.current = props;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const target = useMemo(
    () =>
      props.context
        ? selection(
            { context: props.context, records: props.records },
            {
              environmentId: props.environmentId,
              projectId: props.projectId,
              context: props.context,
            },
          )
        : null,
    [props.context, props.records, props.projectId, props.environmentId],
  );
  const lastGatePage = Math.max(0, Math.ceil((target?.gates.length ?? 0) / 8) - 1);
  const visibleGatePage = Math.min(gatePage, lastGatePage);
  const access = props.current && props.connected && props.enabled && props.supported;
  const usableReview = useMemo(() => {
    const gate = target?.gates.find((g) => g.recordId === review?.gateId);
    return access &&
      target &&
      gate &&
      review &&
      review.revision === target.context.revision &&
      reviewTarget(
        { context: target.context, records: props.records },
        { environmentId: props.environmentId, projectId: props.projectId, context: props.context },
        gate,
        review.record,
      ) === review.fingerprint
      ? review
      : null;
  }, [access, target, review, props.records, props.environmentId, props.projectId, props.context]);
  const currentSelected = target?.bindings.find(
    (b) =>
      b.recordId === selected?.recordId &&
      canonicalProjectWorkPayload(b) === canonicalProjectWorkPayload(selected),
  );
  const fingerprint = (snapshot: TaskVerificationSnapshot, intent: VerificationIntent) => {
    const found = selection(snapshot, live.current);
    if (!found) throw changed();
    if (intent.type === "project-team.verification.propose") {
      const binding = found.bindings.find((b) => b.recordId === intent.bindingId);
      if (
        !found.eligible ||
        !binding ||
        !found.plan ||
        binding.revision !== intent.expectedBindingRevision ||
        binding.generation !== intent.generation ||
        found.plan.planRevision !== intent.planRevision ||
        !intent.criterionIds.every((id) =>
          found.context.criteria.some(
            (c) => c.criterionId === id && found.task.specification?.criterionIds.includes(id),
          ),
        )
      )
        throw changed();
      return canonicalProjectWorkPayload({
        revision: found.context.revision,
        task: found.task,
        plan: found.plan,
        binding,
        criteria: found.context.criteria.filter((c) => intent.criterionIds.includes(c.criterionId)),
      });
    }
    const gate = found.gates.find((g) => g.recordId === intent.gateId);
    if (
      !gate ||
      gate.status !== "pending" ||
      gate.revision !== intent.expectedGateRevision ||
      gate.specRevision !== intent.specRevision ||
      gate.planRevision !== intent.planRevision
    )
      throw changed();
    if (intent.response === "approved") {
      const fresh =
        review && review.gateId === gate.recordId && review.revision === snapshot.context.revision
          ? reviewTarget(snapshot, live.current, gate, review.record)
          : null;
      if (!fresh || fresh !== review?.fingerprint)
        throw new Error("Load and review the exact current verification preview before approval.");
      return fresh;
    }
    return canonicalProjectWorkPayload({
      revision: found.context.revision,
      task: found.task,
      gate,
    });
  };
  const verify = (intent: VerificationIntent) => {
    const p = live.current;
    if (!mounted.current || !p.current || !p.connected || !p.enabled || !p.supported)
      throw new Error("Reconnect with project work access before submitting verification.");
    verifyAccess?.();
    const snapshot = p.verify();
    if (
      snapshot.context.revision !== intent.expectedRevision ||
      snapshot.context.task.revision !== intent.expectedTaskRevision ||
      snapshot.context.task.specRevision !== intent.specRevision ||
      intent.projectId !== p.projectId ||
      intent.taskId !== snapshot.context.task.taskId
    )
      throw changed();
    return fingerprint(snapshot, intent);
  };
  async function send(intent: VerificationIntent, saved?: NonNullable<typeof pending>) {
    if (lock.current) return;
    let submission: GuidedTaskDraftSubmission | undefined;
    const settle = (outcome: Parameters<typeof recordGuidedTaskDraftOutcome>[2]) => {
      if (!submission) return;
      const result = recordGuidedTaskDraftOutcome(store.read(), submission, outcome);
      if (result.ok) store.write(result.state);
    };
    try {
      const reviewed = verify(intent);
      if (saved && reviewed !== saved.fingerprint) throw changed();
      const key = {
        environmentId: props.environmentId,
        projectId: props.projectId,
        taskId: intent.taskId,
        kind: intent.type,
      };
      if (!saved) {
        if (
          store
            .read()
            .entries.some(
              (entry) =>
                entry.key.environmentId === key.environmentId &&
                entry.key.projectId === key.projectId &&
                entry.key.taskId === key.taskId &&
                entry.pending,
            )
        )
          throw new Error(
            "Review the existing pending request before submitting another verification request.",
          );
        const edited = editGuidedTaskDraft(store.read(), key, intent, {
          fingerprint: reviewed,
          executable,
          argv,
          duration,
          output,
          covered: JSON.stringify(covered),
          binding: JSON.stringify(selected),
        });
        if (!edited.ok)
          throw new Error(
            "The verification request cannot be retained. Discard an older local draft before submitting.",
          );
        store.write(edited.state);
      }
      const result = saved
        ? retryGuidedTaskSubmission(store.read(), key)
        : beginGuidedTaskSubmission(store.read(), key, intent);
      if (!result.ok)
        throw new Error(
          "The verification request changed or cannot be retained. Review it before submitting.",
        );
      submission = result.submission;
      store.write(result.state);
      lock.current = true;
      setSending(true);
      setNotice(null);
      await live.current.onWrite(decodeIntent(submission.intentJson));
      let currentAccess = true;
      try {
        verifyAccess?.();
      } catch {
        currentAccess = false;
      }
      if (
        !currentAccess ||
        !live.current.current ||
        !live.current.connected ||
        !live.current.enabled ||
        !live.current.supported
      ) {
        settle("uncertain");
        if (mounted.current) setNotice("Access changed. Reconnect and review the request result.");
        return;
      }
      settle("success");
      if (!mounted.current) return;
      setAcceptedRevision(intent.expectedRevision);
      setNotice(
        intent.type === "project-team.verification.propose"
          ? "Verification proposed. Refresh to review the prepared preview before approval."
          : "Response recorded. Refresh to see the current gate status.",
      );
      live.current.onRefresh();
    } catch (raw) {
      const failure = projectWorkCommandFailure(raw);
      const code: unknown = raw && typeof raw === "object" ? Reflect.get(raw, "code") : undefined;
      const denied =
        failure.staleRevision ||
        [
          "authority-required",
          "unauthorized",
          "permission-denied",
          "invalid-state",
          "invalid-input",
          "unsupported",
          "unavailable",
        ].includes(typeof code === "string" ? code : "");
      if (submission && denied) {
        const result = discardGuidedTaskDraft(store.read(), submission.key);
        if (result.ok) store.write(result.state);
      } else settle("uncertain");
      if (mounted.current) setNotice(failure.message);
    } finally {
      lock.current = false;
      if (mounted.current) setSending(false);
    }
  }
  const response = (gate: Gate, choice: "approved" | "rejected") => {
    if (!target || pending || acceptedRevision === target.context.revision) return;
    void send({
      type: "project-team.gate.respond",
      commandId: CommandId.make(randomUUID()),
      projectId: props.projectId,
      taskId: target.task.taskId,
      expectedRevision: target.context.revision,
      expectedTaskRevision: target.task.revision,
      specRevision: gate.specRevision,
      planRevision: gate.planRevision,
      gateId: gate.recordId,
      expectedGateRevision: gate.revision,
      response: choice,
    });
  };
  async function load(gate: Gate) {
    const version = ++readVersion.current;
    setReview(null);
    setNotice(null);
    setLoading(true);
    try {
      const p = live.current;
      if (!mounted.current || !p.current || !p.connected || !p.enabled || !p.supported)
        throw new Error("Reconnect with project work access before loading a preview.");
      verifyAccess?.();
      const before = p.verify();
      const found = selection(before, p);
      const currentGate = found?.gates.find((g) => g.recordId === gate.recordId);
      if (
        !currentGate ||
        !currentGate.verificationJobId ||
        canonicalProjectWorkPayload(currentGate) !== canonicalProjectWorkPayload(gate)
      )
        throw changed();
      const readTarget = {
        environmentId: p.environmentId,
        projectId: p.projectId,
        taskId: before.context.task.taskId,
        verificationJobId: currentGate.verificationJobId,
      };
      const result = await readPreview(readTarget);
      if (!mounted.current || version !== readVersion.current) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      verifyAccess?.();
      const record = asProjectWorkVerificationJob(result.value, readTarget);
      const now = live.current;
      if (!now.current || !now.connected || !now.enabled || !now.supported)
        throw new Error("Access changed. Reconnect before reviewing a preview.");
      const after = now.verify();
      const fingerprint = record && reviewTarget(after, now, currentGate, record);
      const latest = selection(after, now)?.gates.find((g) => g.recordId === currentGate.recordId);
      if (
        !record ||
        !fingerprint ||
        after.context.revision !== before.context.revision ||
        canonicalProjectWorkPayload(latest) !== canonicalProjectWorkPayload(currentGate)
      )
        throw new Error(
          "The prepared preview is unavailable, unsupported or no longer matches this task and gate. Refresh before approval.",
        );
      setReview({ gateId: gate.recordId, revision: after.context.revision, fingerprint, record });
    } catch (raw) {
      if (mounted.current && version === readVersion.current)
        setNotice(projectWorkCommandFailure(raw).message);
    } finally {
      if (mounted.current && version === readVersion.current) setLoading(false);
    }
  }
  const propose = () => {
    if (
      !target?.plan ||
      !currentSelected ||
      pending ||
      acceptedRevision === target.context.revision
    )
      return;
    try {
      if (argv.length > 32768) throw new Error("Arguments exceed the verification limit.");
      const command = decodeWrite({
        type: "project-team.verification.propose",
        commandId: CommandId.make(randomUUID()),
        projectId: props.projectId,
        taskId: target.task.taskId,
        expectedRevision: target.context.revision,
        expectedTaskRevision: target.task.revision,
        specRevision: target.task.specRevision,
        planRevision: target.plan.planRevision,
        jobId: randomUUID(),
        bindingId: currentSelected.recordId,
        expectedBindingRevision: currentSelected.revision,
        generation: currentSelected.generation,
        criterionIds: covered,
        command: {
          executable,
          argv: decodeArguments(argv),
          environment: "clean",
          limits: { maxDurationMs: Number(duration), maxOutputBytes: Number(output) },
        },
      });
      if (command.type === "project-team.verification.propose") void send(command);
    } catch {
      setNotice(
        "Use an absolute executable path, a JSON array of literal arguments, 1–64 criteria, a timeout of 1–3600000 ms and an output limit of 1–1048576 bytes.",
      );
    }
  };
  return (
    <WorkCard>
      <h4 className="font-medium">Verification</h4>
      <p className="text-sm text-muted-foreground">
        Prepare an exact command for human approval. Approval does not run it or record a
        verification result.
      </p>
      {notice && (
        <p role="status" className="mt-2 text-sm">
          {notice}
        </p>
      )}
      {!access && (
        <p className="mt-2 text-sm">
          {!props.connected
            ? "Reconnect before preparing or responding to verification."
            : !props.enabled || !props.supported
              ? "Verification is unavailable on this environment."
              : "Refresh the task and complete current project work before verification."}
        </p>
      )}
      {access && !target && (
        <p className="mt-2 text-sm">
          Verification data is incomplete or unsupported. Refresh this task.
        </p>
      )}
      {access && target && !target.eligible && (
        <p className="mt-2 text-sm">
          Preparing verification requires an active managed code task, current specification and
          plan, and an original settled implementer.
        </p>
      )}
      {selected && !currentSelected && (
        <p role="status">
          The selected implementation changed. Select it again after reviewing the current work.
        </p>
      )}
      <fieldset disabled={!access || busy || pending !== null} className="mt-3 space-y-3">
        <label className="block text-sm">
          Settled implementation
          <select
            aria-label="Settled implementation"
            value={currentSelected?.recordId ?? ""}
            onChange={(e) =>
              setSelected(target?.bindings.find((b) => b.recordId === e.target.value) ?? null)
            }
            className="mt-1 block w-full rounded-md border bg-background p-2"
          >
            <option value="">Select the original settled implementer</option>
            {target?.bindings.map((b) => (
              <option key={b.recordId} value={b.recordId}>
                {b.recordId} · {b.worktree} · {b.branch}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Absolute executable
          <Input
            aria-label="Verification executable"
            value={executable}
            onChange={(e) => setExecutable(e.target.value)}
            placeholder="/absolute/path/to/test-runner"
          />
        </label>
        <label className="block text-sm">
          Literal arguments (JSON array)
          <Textarea
            aria-label="Verification arguments"
            value={argv}
            onChange={(e) => setArgv(e.target.value)}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          For example ["--filter", "remote reconnect"]. Arguments are passed in order without a
          shell, using a clean environment.
        </p>
        <div className="flex flex-wrap gap-3">
          <label className="text-sm">
            Timeout (ms)
            <Input
              aria-label="Verification timeout"
              type="number"
              min={1}
              max={3600000}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </label>
          <label className="text-sm">
            Output limit (bytes)
            <Input
              aria-label="Verification output limit"
              type="number"
              min={1}
              max={1048576}
              value={output}
              onChange={(e) => setOutput(e.target.value)}
            />
          </label>
        </div>
        <div>
          <p className="text-sm">Criterion coverage</p>
          {target?.context.criteria
            .filter((c) => target.task.specification?.criterionIds.includes(c.criterionId))
            .map((c) => (
              <label key={c.criterionId} className="mt-1 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Cover ${c.description}`}
                  checked={covered.includes(c.criterionId)}
                  onChange={(e) =>
                    setCovered((ids) =>
                      e.target.checked
                        ? [...ids, c.criterionId]
                        : ids.filter((id) => id !== c.criterionId),
                    )
                  }
                />
                {c.description}
              </label>
            ))}
        </div>
        <Button
          size="sm"
          disabled={
            !target?.eligible ||
            !currentSelected ||
            covered.length === 0 ||
            acceptedRevision === target?.context.revision ||
            target.gates.some((g) => g.status === "pending")
          }
          onClick={propose}
        >
          Propose verification
        </Button>
      </fieldset>
      {target?.gates.slice(visibleGatePage * 8, visibleGatePage * 8 + 8).map((gate) => {
        const currentReview = usableReview?.gateId === gate.recordId ? usableReview.record : null;
        const manifest = currentReview?.manifest;
        return (
          <section key={gate.recordId} className="mt-4 space-y-2 border-t pt-3">
            <h5 className="font-medium">
              {gate.status === "pending"
                ? "Prepared · waiting for approval"
                : gate.status === "approved"
                  ? "Approved"
                  : `Verification gate · ${gate.status}`}
            </h5>
            <p className="break-all text-xs text-muted-foreground">
              Job {gate.verificationJobId} · Hash {gate.contentHash}
            </p>
            {(gate.status === "pending" || gate.status === "approved") && (
              <Button
                size="sm"
                variant="outline"
                disabled={!access || loading || busy}
                onClick={() => void load(gate)}
              >
                {loading ? "Loading verification preview…" : "Load verification preview"}
              </Button>
            )}
            {manifest && (
              <div className="space-y-2 text-sm">
                <dl className="grid gap-1">
                  <dt>Executable</dt>
                  <dd className="break-all font-mono">{manifest.command.executable}</dd>
                  <dt>Arguments in order</dt>
                  <dd>
                    <ol className="list-inside list-decimal font-mono">
                      {manifest.command.argv.map((argument, index) => (
                        <li key={index} className="break-all">
                          {JSON.stringify(argument)}
                        </li>
                      ))}
                    </ol>
                  </dd>
                  <dt>Environment</dt>
                  <dd>Clean</dd>
                  <dt>Timeout / output limit</dt>
                  <dd>
                    {manifest.command.limits.maxDurationMs} ms /{" "}
                    {manifest.command.limits.maxOutputBytes} bytes
                  </dd>
                  <dt>Repository</dt>
                  <dd className="break-all font-mono">{manifest.target.repository}</dd>
                  <dt>Worktree</dt>
                  <dd className="break-all font-mono">{manifest.target.worktree}</dd>
                  <dt>Branch</dt>
                  <dd className="break-all font-mono">{manifest.target.branchRef}</dd>
                  <dt>Base / head</dt>
                  <dd className="break-all font-mono">
                    {manifest.target.baseSha} / {manifest.target.headSha}
                  </dd>
                  <dt>Tested commit / tree</dt>
                  <dd className="break-all font-mono">
                    {manifest.target.testedCommit} / {manifest.target.testedTree}
                  </dd>
                  <dt>Specification / plan revisions</dt>
                  <dd>
                    {manifest.specRevision} / {manifest.planRevision}
                  </dd>
                  <dt>Executable / runtime closure hashes</dt>
                  <dd className="break-all font-mono">
                    {manifest.executable.sha256} / {manifest.executable.runtimeClosureSha256}
                  </dd>
                </dl>
                <p>Criterion coverage</p>
                <ul>
                  {manifest.criteria.map((item) => (
                    <li key={item.criterionId}>
                      {item.criterionId} · revision {item.revision} ·{" "}
                      {
                        target.context.criteria.find((c) => c.criterionId === item.criterionId)
                          ?.description
                      }
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {gate.status === "pending" && (
              <div className="flex gap-2">
                <Button
                  aria-label="Approve verification"
                  size="sm"
                  disabled={
                    !access ||
                    !currentReview ||
                    busy ||
                    pending !== null ||
                    acceptedRevision === target.context.revision
                  }
                  onClick={() => response(gate, "approved")}
                >
                  Approve verification
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !access ||
                    busy ||
                    pending !== null ||
                    acceptedRevision === target.context.revision
                  }
                  onClick={() => response(gate, "rejected")}
                >
                  Reject verification
                </Button>
              </div>
            )}
          </section>
        );
      })}
      {lastGatePage > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={visibleGatePage === 0}
            onClick={() => setGatePage(visibleGatePage - 1)}
          >
            Previous verification gates
          </Button>
          <span className="text-sm">
            {visibleGatePage + 1} / {lastGatePage + 1}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={visibleGatePage === lastGatePage}
            onClick={() => setGatePage(visibleGatePage + 1)}
          >
            Next verification gates
          </Button>
        </div>
      )}
      {pending?.uncertain && (
        <div className="mt-3 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!access || busy}
            onClick={() => {
              const intent = decodeIntent(pending.json);
              if (
                intent.type === "project-team.verification.propose" ||
                intent.type === "project-team.gate.respond"
              )
                void send(intent, pending);
            }}
          >
            Retry exact verification request
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              const result = discardGuidedTaskDraft(store.read(), pending.submission.key);
              if (result.ok) store.write(result.state);
              setNotice(
                "Local request discarded. Refresh to check its retained status before proposing again.",
              );
              props.onRefresh();
            }}
          >
            Discard pending request
          </Button>
        </div>
      )}
    </WorkCard>
  );
}
