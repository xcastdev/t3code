import { asProjectWorkVerificationJob } from "@t3tools/client-runtime/project-work";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { mobileWorkEnvironment } from "./workEnvironment";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  CommandId,
  ProjectTeamRecord,
  ProjectWorkWriteIntent,
  canonicalProjectWorkPayload,
  type ProjectTeamRecord as TeamRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { Notice, WorkButton, WorkCard } from "./WorkScreens";
import {
  publicWorkRejection,
  reviewMobileWork,
  type MobileWorkCurrent,
  type MobileWorkScope,
} from "./workActions";

type Intent = Extract<
  ProjectWorkWriteIntent,
  { type: "project-team.verification.propose" | "project-team.gate.respond" }
>;
type Gate = Extract<TeamRecord, { kind: "gate" }>;
type Preview = NonNullable<ReturnType<typeof asProjectWorkVerificationJob>>;
type Review = { readonly gateId: string; readonly fingerprint: string; readonly preview: Preview };
type Binding = Extract<TeamRecord, { kind: "run-binding" }>;
export interface MobileVerificationRequest {
  readonly owner: MobileWorkScope;
  readonly json: string;
  readonly fingerprint: string;
  readonly status: "sending" | "uncertain" | "accepted" | "denied";
  readonly notice: string;
  readonly fields: {
    readonly executable: string;
    readonly argv: string;
    readonly duration: string;
    readonly output: string;
    readonly criteria: ReadonlyArray<string>;
    readonly binding: Binding | null;
  };
}
export interface MobileVerificationStore {
  readonly snapshot: ReadonlyArray<MobileVerificationRequest>;
  readonly read: () => ReadonlyArray<MobileVerificationRequest>;
  readonly write: (entries: ReadonlyArray<MobileVerificationRequest>) => void;
}
export interface WorkVerificationProps {
  readonly current: MobileWorkCurrent;
  readonly readCurrent: () => MobileWorkCurrent;
  readonly send: (intent: ProjectWorkWriteIntent) => Promise<void>;
  readonly store: MobileVerificationStore;
  readonly onRefresh: () => void;
}
const isRecord = Schema.is(ProjectTeamRecord);
const knownRecord = (value: unknown): value is TeamRecord => isRecord(value);
const jsonCodec = Schema.fromJsonString(ProjectWorkWriteIntent);
const encodeIntent = Schema.encodeSync(jsonCodec);
const decodeIntent = Schema.decodeUnknownSync(jsonCodec);
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecord);
const copyBinding = (binding: Binding | null) => {
  if (!binding) return null;
  const copied = decodeRecord(JSON.parse(canonicalProjectWorkPayload(binding)));
  if (copied.kind !== "run-binding") throw changed();
  return copied;
};
const decodeWrite = Schema.decodeUnknownSync(ProjectWorkWriteIntent);
const decodeArguments = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const own = (a: MobileWorkScope, b: MobileWorkScope) =>
  a.environmentId === b.environmentId && a.projectId === b.projectId && a.taskId === b.taskId;
const changed = () =>
  Error("Verification target changed. Refresh and review it before submitting.");
function view(current: MobileWorkCurrent, owner: MobileWorkScope) {
  const review = reviewMobileWork(current);
  if (
    !own(current, owner) ||
    review.reason !== null ||
    !current.context ||
    current.foundation.records.length > 2048 ||
    !current.foundation.records.every(
      (row) =>
        knownRecord(row) &&
        row.projectId === owner.projectId &&
        row.revision <= current.context!.revision,
    ) ||
    new Set(current.foundation.records.map((row) => row.recordId)).size !==
      current.foundation.records.length
  )
    return null;
  const records = current.foundation.records.filter(knownRecord);
  const plan = review.plan;
  const bindings = records.filter(
    (r): r is Binding =>
      r.kind === "run-binding" &&
      r.taskId === owner.taskId &&
      r.environmentId === owner.environmentId &&
      r.status === "settled" &&
      r.specRevision === current.context?.task.specRevision &&
      r.planRevision === plan?.planRevision &&
      r.generation === r.leaseGeneration &&
      r.repairEpisodeId === undefined &&
      records.filter(
        (role) =>
          role.kind === "role-revision" &&
          role.recordId === r.roleRevisionId &&
          (role.role === "implementer" || role.role === "integrator"),
      ).length === 1,
  );
  return {
    review,
    plan,
    bindings,
    context: current.context,
    gates: review.gates.filter((gate) => gate.gate === "verification"),
    eligible:
      review.membership?.deliverableKind === "code" &&
      review.canInvestigate &&
      current.context.task.state !== "draft" &&
      plan !== null &&
      current.context.task.specification !== undefined,
  };
}
function reviewTarget(
  current: MobileWorkCurrent,
  owner: MobileWorkScope,
  gate: Gate,
  preview: Preview,
) {
  const found = view(current, owner);
  const manifest = preview.manifest;
  if (
    !found ||
    !found.plan ||
    found.gates.filter((g) => g.verificationJobId === gate.verificationJobId).length !== 1 ||
    gate.status !== "pending" ||
    gate.verificationJobId !== manifest.jobId ||
    gate.contentHash !== preview.sha256 ||
    manifest.environmentId !== owner.environmentId ||
    manifest.projectId !== owner.projectId ||
    manifest.taskId !== owner.taskId ||
    manifest.specRevision !== found.context.task.specRevision ||
    gate.specRevision !== manifest.specRevision ||
    gate.planRevision !== manifest.planRevision ||
    found.plan.planRevision !== manifest.planRevision ||
    found.plan.contentHash !== manifest.planHash ||
    (found.plan.integrationSources !== undefined) !== (manifest.integrationCoverage !== undefined)
  )
    return null;
  const binding = found.bindings.find(
    (b) =>
      b.recordId === manifest.bindingId &&
      b.generation === manifest.generation &&
      b.worktree === manifest.target.worktree &&
      b.branch === manifest.target.branchRef,
  );
  const role = binding
    ? current.foundation.records
        .filter(knownRecord)
        .find(
          (record) => record.kind === "role-revision" && record.recordId === binding.roleRevisionId,
        )
    : undefined;
  if (
    !binding ||
    role?.kind !== "role-revision" ||
    (manifest.integration === true) !== (role.role === "integrator") ||
    !manifest.criteria.every(
      (item) =>
        found.context.task.specification?.criterionIds.includes(item.criterionId) &&
        found.context.criteria.some(
          (c) => c.criterionId === item.criterionId && c.revision === item.revision,
        ),
    )
  )
    return null;
  return canonicalProjectWorkPayload({
    revision: found.context.revision,
    task: found.context.task,
    gate,
    binding,
    role,
    plan: found.plan,
    criteria: found.context.criteria.filter((c) =>
      manifest.criteria.some((item) => item.criterionId === c.criterionId),
    ),
  });
}
function replace(
  store: MobileVerificationStore,
  owner: MobileWorkScope,
  request: MobileVerificationRequest | null,
) {
  const entries = [
    ...store.read().filter((entry) => !own(entry.owner, owner)),
    ...(request ? [request] : []),
  ];
  const sizes = entries.map((entry) => new TextEncoder().encode(JSON.stringify(entry)).byteLength);
  if (
    entries.length > 16 ||
    sizes.some((size) => size > 262144) ||
    sizes.reduce((a, b) => a + b, 0) > 1048576
  )
    throw Error(
      "Local verification recovery is full. Discard an older local request before submitting.",
    );
  store.write(entries);
}
export function WorkVerification(props: WorkVerificationProps) {
  return (
    <VerificationSession
      key={JSON.stringify([
        props.current.environmentId,
        props.current.projectId,
        props.current.taskId,
      ])}
      {...props}
    />
  );
}
function VerificationSession(props: WorkVerificationProps) {
  const owner = useMemo(
    () => ({
      environmentId: props.current.environmentId,
      projectId: props.current.projectId,
      taskId: props.current.taskId,
    }),
    [props.current.environmentId, props.current.projectId, props.current.taskId],
  );
  const request = props.store.snapshot.find((entry) => own(entry.owner, owner));
  const [executable, setExecutable] = useState(request?.fields.executable ?? "");
  const [argv, setArgv] = useState(request?.fields.argv ?? "[]");
  const [duration, setDuration] = useState(request?.fields.duration ?? "120000");
  const [output, setOutput] = useState(request?.fields.output ?? "65536");
  const [criteria, setCriteria] = useState<ReadonlyArray<string>>(request?.fields.criteria ?? []);
  const [binding, setBinding] = useState<Binding | null>(request?.fields.binding ?? null);
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(false);
  const [gatePage, setGatePage] = useState(0);
  const readVersion = useRef(0);
  const readPreview = useAtomQueryRunner(mobileWorkEnvironment.verificationJob, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const live = useRef(props);
  const lock = useRef(false);
  useLayoutEffect(() => {
    live.current = props;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const found = useMemo(() => view(props.current, owner), [props.current, owner]);
  const selected = found?.bindings.find(
    (entry) =>
      entry.recordId === binding?.recordId &&
      canonicalProjectWorkPayload(entry) === canonicalProjectWorkPayload(binding),
  );
  const pending = request?.status === "sending" || request?.status === "uncertain";
  const accepted =
    request?.status === "accepted" &&
    decodeIntent(request.json).expectedRevision === found?.context.revision;
  const fingerprint = (current: MobileWorkCurrent, intent: Intent) => {
    const latest = view(current, owner);
    if (
      !latest ||
      intent.projectId !== owner.projectId ||
      intent.taskId !== owner.taskId ||
      latest.context.revision !== intent.expectedRevision ||
      latest.context.task.revision !== intent.expectedTaskRevision ||
      latest.context.task.specRevision !== intent.specRevision
    )
      throw changed();
    if (intent.type === "project-team.gate.respond") {
      const gate = latest.gates.find((g) => g.recordId === intent.gateId);
      if (
        !gate ||
        gate.status !== "pending" ||
        gate.revision !== intent.expectedGateRevision ||
        gate.specRevision !== intent.specRevision ||
        gate.planRevision !== intent.planRevision
      )
        throw changed();
      if (intent.response === "approved") {
        const signature =
          review?.gateId === gate.recordId
            ? reviewTarget(current, owner, gate, review.preview)
            : null;
        if (!signature || signature !== review?.fingerprint)
          throw Error("Load and review the exact current verification preview before approval.");
        return signature;
      }
      return canonicalProjectWorkPayload({
        revision: latest.context.revision,
        task: latest.context.task,
        gate,
      });
    }
    const target = latest.bindings.find((entry) => entry.recordId === intent.bindingId);
    if (
      !latest.plan ||
      !latest.eligible ||
      !target ||
      target.revision !== intent.expectedBindingRevision ||
      target.generation !== intent.generation ||
      latest.plan.planRevision !== intent.planRevision ||
      !intent.criterionIds.every(
        (id) =>
          latest.context.task.specification?.criterionIds.includes(id) &&
          latest.context.criteria.some((criterion) => criterion.criterionId === id),
      )
    )
      throw changed();
    return canonicalProjectWorkPayload({
      revision: latest.context.revision,
      task: latest.context.task,
      plan: latest.plan,
      binding: target,
      criteria: latest.context.criteria.filter((criterion) =>
        intent.criterionIds.includes(criterion.criterionId),
      ),
    });
  };
  async function send(intent: Intent, original?: MobileVerificationRequest) {
    if (!mounted.current || lock.current) return;
    let captured: MobileVerificationRequest | undefined;
    const settle = (status: MobileVerificationRequest["status"], notice: string) => {
      if (
        captured &&
        props.store.read().some((entry) => own(entry.owner, owner) && entry.json === captured?.json)
      )
        replace(props.store, owner, { ...captured, status, notice });
    };
    try {
      const signature = fingerprint(live.current.readCurrent(), intent);
      if (original && signature !== original.fingerprint) throw changed();
      const existing = props.store.read().find((entry) => own(entry.owner, owner));
      if (!original && (existing?.status === "sending" || existing?.status === "uncertain"))
        throw Error("Review the pending verification request before submitting another.");
      captured = original ?? {
        owner,
        json: encodeIntent(intent),
        fingerprint: signature,
        status: "sending",
        notice: "Sending verification request…",
        fields: {
          executable,
          argv,
          duration,
          output,
          criteria: [...criteria],
          binding: copyBinding(binding),
        },
      };
      replace(props.store, owner, { ...captured, status: "sending" });
      lock.current = true;
      setNotice(null);
      await live.current.send(decodeIntent(captured.json));
      if (!view(live.current.readCurrent(), owner)) {
        settle("uncertain", "Access changed. Reconnect and inspect the request result.");
        return;
      }
      settle(
        "accepted",
        intent.type === "project-team.verification.propose"
          ? "Verification proposed. Refresh to inspect the prepared job before approval."
          : "Response recorded. Refresh to see the current gate status.",
      );
      if (mounted.current) live.current.onRefresh();
    } catch (error) {
      const rejection = publicWorkRejection(error);
      settle(
        rejection ? "denied" : "uncertain",
        rejection?.notice ??
          "The response was lost. Retry the exact request after reconnecting or refresh to inspect it.",
      );
      if (mounted.current)
        setNotice(
          error instanceof Error
            ? error.message
            : (rejection?.notice ?? "Verification request unavailable. Review current work."),
        );
    } finally {
      lock.current = false;
    }
  }
  function propose() {
    if (!found?.plan || !selected || pending || accepted) return;
    try {
      if (argv.length > 32768) throw changed();
      const intent = decodeWrite({
        type: "project-team.verification.propose",
        commandId: CommandId.make(uuidv4()),
        projectId: owner.projectId,
        taskId: owner.taskId,
        expectedRevision: found.context.revision,
        expectedTaskRevision: found.context.task.revision,
        specRevision: found.context.task.specRevision,
        planRevision: found.plan.planRevision,
        jobId: uuidv4(),
        bindingId: selected.recordId,
        expectedBindingRevision: selected.revision,
        generation: selected.generation,
        criterionIds: criteria,
        command: {
          executable,
          argv: decodeArguments(argv),
          environment: "clean",
          limits: { maxDurationMs: Number(duration), maxOutputBytes: Number(output) },
        },
      });
      if (intent.type === "project-team.verification.propose") void send(intent);
    } catch {
      setNotice(
        "Use an absolute executable, a JSON array of literal arguments, 1–64 criteria, timeout 1–3600000 ms and output limit 1–1048576 bytes.",
      );
    }
  }
  function respond(gate: Gate, response: "approved" | "rejected") {
    if (!found || pending || accepted) return;
    const intent = decodeWrite({
      type: "project-team.gate.respond",
      commandId: CommandId.make(uuidv4()),
      projectId: owner.projectId,
      taskId: owner.taskId,
      expectedRevision: found.context.revision,
      expectedTaskRevision: found.context.task.revision,
      specRevision: gate.specRevision,
      planRevision: gate.planRevision,
      gateId: gate.recordId,
      expectedGateRevision: gate.revision,
      response,
    });
    if (intent.type === "project-team.gate.respond") void send(intent);
  }
  async function load(gate: Gate) {
    const version = ++readVersion.current;
    setReview(null);
    setNotice(null);
    setLoading(true);
    try {
      const before = view(live.current.readCurrent(), owner);
      const fresh = before?.gates.find((entry) => entry.recordId === gate.recordId);
      if (
        !mounted.current ||
        !before ||
        !fresh?.verificationJobId ||
        canonicalProjectWorkPayload(fresh) !== canonicalProjectWorkPayload(gate)
      )
        throw changed();
      const target = {
        environmentId: owner.environmentId,
        projectId: owner.projectId,
        taskId: owner.taskId,
        verificationJobId: fresh.verificationJobId,
      };
      const result = await readPreview(target);
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const parsed = asProjectWorkVerificationJob(result.value, target);
      if (!parsed) throw Error("The retained verification preview is unsupported or unavailable.");
      // Own a decoded copy before the native digest yields; transport objects cannot change the review.
      const copied = asProjectWorkVerificationJob(
        JSON.parse(canonicalProjectWorkPayload(parsed)),
        target,
      );
      const { CryptoDigestAlgorithm, digestStringAsync } = await import("expo-crypto");
      if (
        !copied ||
        (await digestStringAsync(
          CryptoDigestAlgorithm.SHA256,
          canonicalProjectWorkPayload(copied.manifest),
        )) !== copied.sha256
      )
        throw Error("The prepared verification manifest hash does not match.");
      if (
        before.plan?.integrationSources !== undefined &&
        (await digestStringAsync(
          CryptoDigestAlgorithm.SHA256,
          canonicalProjectWorkPayload(before.plan.integrationSources),
        )) !== copied.manifest.integrationCoverage?.selectionSha256
      )
        throw Error("The verification preview does not cover the approved source selection.");
      const after = live.current.readCurrent();
      const afterGate = view(after, owner)?.gates.find((g) => g.recordId === gate.recordId);
      const signature =
        afterGate && canonicalProjectWorkPayload(afterGate) === canonicalProjectWorkPayload(gate)
          ? reviewTarget(after, owner, afterGate, copied)
          : null;
      if (
        !signature ||
        !before ||
        after.context?.revision !== before.context.revision ||
        canonicalProjectWorkPayload(after.context.task) !==
          canonicalProjectWorkPayload(before.context.task)
      )
        throw changed();
      if (mounted.current && version === readVersion.current)
        setReview({ gateId: gate.recordId, fingerprint: signature, preview: copied });
    } catch (error) {
      if (mounted.current && version === readVersion.current)
        setNotice(
          error instanceof Error
            ? error.message
            : "Verification preview unavailable. Reconnect and review current work.",
        );
    } finally {
      if (mounted.current && version === readVersion.current) setLoading(false);
    }
  }
  const lastPage = Math.max(0, Math.ceil((found?.gates.length ?? 0) / 8) - 1);
  const page = Math.min(gatePage, lastPage);
  const usable =
    review &&
    found?.gates.some(
      (gate) =>
        gate.recordId === review.gateId &&
        reviewTarget(props.current, owner, gate, review.preview) === review.fingerprint,
    )
      ? review
      : null;
  return (
    <WorkCard title="Verification">
      <Notice>
        Prepare an exact command for human approval. Approval does not execute it or establish a
        successful result.
      </Notice>
      <Notice>
        The Linux host must provide the selected assignment's published executable and a clean
        committed original worktree. An arbitrary absolute host path is not available automatically.
      </Notice>
      {notice || request?.notice ? <Notice>{notice ?? request?.notice}</Notice> : null}
      {!found ? (
        <Notice>
          Reconnect and load complete current task and project access before verification.
        </Notice>
      ) : null}
      <Text className="text-sm font-t3-medium text-foreground">Original completed assignment</Text>
      {found?.bindings.map((entry) => (
        <View key={entry.recordId} className="gap-1">
          <Notice>
            {entry.worktree} · {entry.branch} · generation {entry.generation}
          </Notice>
          <WorkButton disabled={pending} onPress={() => setBinding(entry)}>
            Select completed assignment {entry.recordId}
          </WorkButton>
          {selected?.recordId === entry.recordId ? <Notice>Selected assignment</Notice> : null}
        </View>
      ))}
      {binding && !selected ? (
        <Notice>The selected assignment changed. Review and select it again.</Notice>
      ) : null}
      <TextInput
        accessibilityLabel="Verification executable"
        placeholder="/absolute/runtime/executable"
        value={executable}
        editable={found !== null && !pending}
        onChangeText={setExecutable}
        maxLength={4096}
        className="rounded-xl border border-border p-3 text-foreground"
      />
      <TextInput
        accessibilityLabel="Verification arguments"
        placeholder='["--filter", "remote reconnect"]'
        value={argv}
        editable={found !== null && !pending}
        onChangeText={setArgv}
        maxLength={32768}
        multiline
        className="rounded-xl border border-border p-3 text-foreground"
      />
      <Notice>
        Arguments are literal, ordered JSON strings passed without a shell, in a clean environment.
      </Notice>
      <TextInput
        accessibilityLabel="Verification timeout"
        value={duration}
        editable={found !== null && !pending}
        onChangeText={setDuration}
        keyboardType="numeric"
        maxLength={8}
        className="rounded-xl border border-border p-3 text-foreground"
      />
      <TextInput
        accessibilityLabel="Verification output limit"
        value={output}
        editable={found !== null && !pending}
        onChangeText={setOutput}
        keyboardType="numeric"
        maxLength={8}
        className="rounded-xl border border-border p-3 text-foreground"
      />
      <Notice>Timeout in milliseconds · output limit in bytes</Notice>
      {found?.context.criteria
        .filter((entry) =>
          found.context.task.specification?.criterionIds.includes(entry.criterionId),
        )
        .map((entry) => (
          <WorkButton
            key={entry.criterionId}
            disabled={pending}
            onPress={() =>
              setCriteria((ids) =>
                ids.includes(entry.criterionId)
                  ? ids.filter((id) => id !== entry.criterionId)
                  : [...ids, entry.criterionId],
              )
            }
          >
            Cover {entry.description}
          </WorkButton>
        ))}
      <Notice>
        Coverage:{" "}
        {criteria
          .map(
            (id) =>
              found?.context.criteria.find((entry) => entry.criterionId === id)?.description ?? id,
          )
          .join(" · ") || "No criteria selected"}
      </Notice>
      <Notice>
        {criteria.length} criteria selected · {selected?.recordId ?? "No assignment selected"}
      </Notice>
      <WorkButton
        disabled={
          !found?.eligible ||
          !selected ||
          !criteria.length ||
          pending ||
          accepted ||
          found.gates.some((gate) => gate.status === "pending")
        }
        onPress={propose}
      >
        Propose verification
      </WorkButton>
      {found?.gates.slice(page * 8, page * 8 + 8).map((gate) => (
        <View key={gate.recordId} className="gap-2">
          <Notice>
            Verification {gate.verificationJobId} ·{" "}
            {gate.status === "pending" ? "Prepared, awaiting human response" : gate.status} · hash{" "}
            {gate.contentHash}
          </Notice>
          {gate.status === "pending" ? (
            <>
              <WorkButton
                disabled={loading || request?.status === "sending"}
                onPress={() => void load(gate)}
              >
                Review prepared verification
              </WorkButton>
              {usable?.gateId === gate.recordId ? (
                <View className="gap-1">
                  <Notice>
                    {usable.preview.manifest.integrationCoverage !== undefined
                      ? "Combined source integration verification"
                      : usable.preview.manifest.integration === true
                        ? "Integration verification"
                        : "Implementation verification"}
                  </Notice>
                  <Notice>Prepared manifest {usable.preview.sha256}</Notice>
                  {usable.preview.manifest.integrationCoverage ? (
                    <Notice>
                      Approved source selection{" "}
                      {usable.preview.manifest.integrationCoverage.selectionSha256} · combination
                      receipt {usable.preview.manifest.integrationCoverage.combinationSha256}
                    </Notice>
                  ) : null}
                  <Notice>
                    Command {JSON.stringify(usable.preview.manifest.command.executable)} · arguments{" "}
                    {JSON.stringify(usable.preview.manifest.command.argv)}
                  </Notice>
                  <Notice>
                    Clean environment · timeout{" "}
                    {usable.preview.manifest.command.limits.maxDurationMs} ms · output{" "}
                    {usable.preview.manifest.command.limits.maxOutputBytes} bytes
                  </Notice>
                  <Notice>
                    Repository {usable.preview.manifest.target.repository} · worktree{" "}
                    {usable.preview.manifest.target.worktree} · branch{" "}
                    {usable.preview.manifest.target.branchRef}
                  </Notice>
                  <Notice>
                    Base {usable.preview.manifest.target.baseSha} · head{" "}
                    {usable.preview.manifest.target.headSha} · tested commit{" "}
                    {usable.preview.manifest.target.testedCommit} · tested tree{" "}
                    {usable.preview.manifest.target.testedTree}
                  </Notice>
                  <Notice>
                    Specification {usable.preview.manifest.specRevision} · plan{" "}
                    {usable.preview.manifest.planRevision} · binding{" "}
                    {usable.preview.manifest.bindingId} generation{" "}
                    {usable.preview.manifest.generation}
                  </Notice>
                  <Notice>
                    Specification hash {usable.preview.manifest.specificationHash} · plan hash{" "}
                    {usable.preview.manifest.planHash} · workspace receipt{" "}
                    {usable.preview.manifest.workspaceReceiptHash}
                  </Notice>
                  <Notice>
                    Executable hash {usable.preview.manifest.executable.sha256} · runtime closure
                    hash {usable.preview.manifest.executable.runtimeClosureSha256}
                  </Notice>
                  {usable.preview.manifest.criteria.map((criterion) => (
                    <Notice key={criterion.criterionId}>
                      Criterion {criterion.criterionId} revision {criterion.revision}:{" "}
                      {
                        found.context.criteria.find(
                          (entry) => entry.criterionId === criterion.criterionId,
                        )?.description
                      }
                    </Notice>
                  ))}
                </View>
              ) : null}
              <WorkButton
                disabled={!usable || usable.gateId !== gate.recordId || pending || accepted}
                onPress={() => respond(gate, "approved")}
              >
                Approve prepared verification
              </WorkButton>
              <WorkButton disabled={pending || accepted} onPress={() => respond(gate, "rejected")}>
                Reject prepared verification
              </WorkButton>
            </>
          ) : null}
        </View>
      ))}
      {found && found.gates.length > 8 ? (
        <View className="gap-1">
          <Notice>
            Verification gates page {page + 1} of {lastPage + 1}
          </Notice>
          <WorkButton disabled={page === 0} onPress={() => setGatePage(page - 1)}>
            Previous verification gates
          </WorkButton>
          <WorkButton disabled={page === lastPage} onPress={() => setGatePage(page + 1)}>
            Next verification gates
          </WorkButton>
        </View>
      ) : null}
      {request?.status === "uncertain" ? (
        <WorkButton
          disabled={!found}
          onPress={() => {
            const intent = decodeIntent(request.json);
            if (
              intent.type === "project-team.verification.propose" ||
              intent.type === "project-team.gate.respond"
            )
              void send(intent, request);
          }}
        >
          Retry exact verification request
        </WorkButton>
      ) : null}
      {request && request.status !== "sending" ? (
        <WorkButton
          onPress={() => {
            replace(props.store, owner, null);
            setNotice(
              "Local request discarded. Refresh to inspect its recorded result before proposing again.",
            );
            props.onRefresh();
          }}
        >
          Discard local verification request
        </WorkButton>
      ) : null}
    </WorkCard>
  );
}
