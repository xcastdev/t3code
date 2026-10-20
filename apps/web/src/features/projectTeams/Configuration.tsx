import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  canonicalProjectWorkPayload,
  CommandId,
  PROJECT_TEAM_DEFAULT_LIMITS,
  ProjectTeamConfigurationIntent,
  ProjectTeamRecord,
  ProjectWorkWriteResult,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { RefreshCwIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { WorkCard } from "../../components/work/WorkDataNotice";
import {
  WorkDisclosure,
  WorkSectionHeader,
  WorkTime,
  workSelectClass,
  workStateLabel,
} from "../../components/work/WorkLayout";
import {
  WorkTeamFoundation,
  type WorkTeamFoundationView,
} from "../../components/work/WorkTeamFoundation";
import { projectWorkCommandFailure } from "../../components/work/workCommandFailure";
import { randomUUID } from "../../lib/utils";
import { projectWorkEnvironment } from "../../state/projectWork";
import { useAtomCommand } from "../../state/use-atom-command";

interface ConfigurationProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly writesSupported: boolean;
  readonly providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: ProviderDriverKind;
    readonly enabled: boolean;
    readonly label: string;
    readonly models: ReadonlyArray<string>;
  }>;
}
type Values = Omit<
  ProjectTeamConfigurationIntent,
  "type" | "commandId" | "projectId" | "expectedRevision" | "expectedConfigurationGeneration"
>;
type FormValues = Omit<Values, "providerInstanceId" | "taskPriorities"> & {
  readonly providerInstanceId: string;
  readonly taskPriorities: ReadonlyArray<{ readonly taskId: string; readonly priority: number }>;
};
type Profile = Values["profiles"][number];
type Limits = Extract<ProjectTeamRecord, { kind: "limits" }>;
const roles = [
  "coordinator",
  "investigator",
  "planner",
  "implementer",
  "reviewer",
  "integrator",
] as const;
const knownRecord = Schema.is(ProjectTeamRecord);
const decode = Schema.decodeUnknownSync(ProjectTeamConfigurationIntent);
const decodeReceipt = Schema.decodeSync(ProjectWorkWriteResult);
const equal = (left: unknown, right: unknown) =>
  canonicalProjectWorkPayload(left) === canonicalProjectWorkPayload(right);
const unavailable = () =>
  new Error("Configuration changed or is unavailable. Refresh and reload before saving.");

/** Read the same human-installed generation used by the server, across all model policies. */
function recordedConfiguration(records: ReadonlyArray<ProjectTeamRecord>) {
  const installed = records.filter(
    (record): record is Limits =>
      record.kind === "limits" &&
      record.providerInstanceId !== undefined &&
      record.profileRecordIds !== undefined,
  );
  const generation = installed.reduce((value, record) => Math.max(value, record.generation), 0);
  if (!Number.isSafeInteger(generation) || generation >= Number.MAX_SAFE_INTEGER)
    throw unavailable();
  if (installed.length === 0) return { generation, values: null };
  if (generation < 1) throw unavailable();
  const policies = installed.filter((record) => record.generation === generation);
  const first = policies[0]!;
  const ids = first.profileRecordIds!;
  const shared = (policy: (typeof installed)[number]) => ({
    status: policy.status,
    providerInstanceId: policy.providerInstanceId,
    projectPriority: policy.projectPriority,
    taskPriorities: policy.taskPriorities,
    environmentModelCalls: policy.environmentModelCalls,
    projectWritableWorkers: policy.projectWritableWorkers,
    delegationDepth: policy.delegationDepth,
    repairAllowance: policy.repairAllowance,
    profileRecordIds: [...policy.profileRecordIds!].sort(),
  });
  if (
    ids.length !== 6 ||
    new Set(ids).size !== 6 ||
    policies.some((policy) => !equal(shared(policy), shared(first)))
  )
    throw unavailable();
  const profiles: Profile[] = ids.map((id) => {
    const role = records.find((record) => record.recordId === id);
    if (
      role?.kind !== "role-revision" ||
      role.status !== "available" ||
      role.generation !== generation
    )
      throw unavailable();
    const { instructions, skills, tools, model, memoryAccess, delegationDepth } = role;
    const members = records.filter(
      (record) =>
        record.kind === "member" &&
        record.roleRevisionId === role.recordId &&
        record.status !== "retired",
    );
    if (
      members.length !== 1 ||
      members[0]!.generation !== generation ||
      members[0]!.kind !== "member" ||
      members[0]!.coordinator !== (role.role === "coordinator") ||
      members[0]!.status !== (first.status === "configured" ? "active" : "paused")
    )
      throw unavailable();
    return { role: role.role, instructions, skills, tools, model, memoryAccess, delegationDepth };
  });
  const values: Values = {
    enabled: first.status === "configured",
    providerInstanceId: first.providerInstanceId!,
    projectPriority: first.projectPriority!,
    taskPriorities: first.taskPriorities!,
    profiles: roles.map((role) => profiles.find((profile) => profile.role === role)!),
    modelPolicies: policies.map(({ model, tokenLimit, durationLimitMs, modelCalls }) => ({
      model,
      tokenLimit,
      durationLimitMs,
      modelCalls,
    })),
    environmentModelCalls: first.environmentModelCalls,
    projectWritableWorkers: first.projectWritableWorkers,
    delegationDepth: first.delegationDepth,
    repairAllowance: first.repairAllowance,
  };
  if (
    records.some(
      (record) =>
        record.kind === "limits" &&
        record.status === "configured" &&
        record.generation !== generation,
    )
  )
    throw unavailable();
  validateValues(values);
  return { generation, values };
}

function validateValues(values: FormValues) {
  decode({
    ...values,
    type: "project-team.configure",
    commandId: "validation",
    projectId: "validation",
    expectedRevision: 0,
    expectedConfigurationGeneration: 0,
  });
  const selected = new Set(values.profiles.map((profile) => profile.model));
  if (
    selected.has("unconfigured") ||
    selected.size !== values.modelPolicies.length ||
    values.modelPolicies.some((policy) => !selected.has(policy.model)) ||
    new Set(values.taskPriorities.map((item) => item.taskId)).size !==
      values.taskPriorities.length ||
    values.profiles.some(
      (profile) =>
        new Set(profile.skills).size !== profile.skills.length ||
        new Set(profile.tools).size !== profile.tools.length,
    )
  )
    throw unavailable();
}

type Draft = {
  readonly values: FormValues;
  readonly revision: number;
  readonly generation: number;
};
type Submission = {
  readonly command: ProjectTeamConfigurationIntent;
  readonly status: "sending" | "uncertain" | "accepted";
  readonly receiptRevision?: number;
};
function commandValues(command: ProjectTeamConfigurationIntent): Values {
  const {
    type: _type,
    commandId: _command,
    projectId: _project,
    expectedRevision: _revision,
    expectedConfigurationGeneration: _generation,
    ...values
  } = command;
  return values;
}
function sameValues(left: Values | null, right: Values) {
  if (!left) return false;
  return equal(
    {
      ...left,
      modelPolicies: [...left.modelPolicies].sort((a, b) => a.model.localeCompare(b.model)),
    },
    {
      ...right,
      modelPolicies: [...right.modelPolicies].sort((a, b) => a.model.localeCompare(b.model)),
    },
  );
}
const explicitRejection = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  [
    "stale-revision",
    "invalid-state",
    "permission-denied",
    "forbidden",
    "unauthorized",
    "not-found",
    "invalid-request",
    "authority-required",
  ].includes(String(error.code));

/** Configuration records new profiles and limits; assignment dispatch remains a separate action. */
export function Configuration(props: ConfigurationProps) {
  if (!props.supported) return <p>This environment does not support team configuration.</p>;
  return (
    <WorkTeamFoundation {...props}>
      {(foundation) => (
        <ConfigurationForm
          key={JSON.stringify([props.environmentId, props.projectId])}
          {...props}
          foundation={foundation}
        />
      )}
    </WorkTeamFoundation>
  );
}

function ConfigurationForm(
  props: ConfigurationProps & { readonly foundation: WorkTeamFoundationView },
) {
  const write = useAtomCommand(projectWorkEnvironment.write, {
    reportFailure: false,
    reportDefect: false,
  });
  const result = useAtomValue(
    projectWorkEnvironment.foundationPage({
      environmentId: props.environmentId,
      projectId: props.projectId,
    }),
  );
  const active = props.connected && props.enabled && props.writesSupported;
  const [epoch, setEpoch] = useState({ active, blocked: result });
  if (epoch.active !== active) setEpoch({ active, blocked: result });
  const refresh = useEffectEvent(() => props.foundation.refresh());
  useLayoutEffect(() => {
    if (active) refresh();
  }, [active]);
  const owner = useRef(false);
  const access = useRef(props);
  useLayoutEffect(() => {
    access.current = props;
  });
  useLayoutEffect(() => {
    owner.current = true;
    return () => {
      owner.current = false;
    };
  }, []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const pending = useRef<Submission | null>(null);
  const [notice, setNotice] = useState("");
  const storeSubmission = (value: Submission | null) => {
    pending.current = value;
    setSubmission(value);
  };
  let recorded: ReturnType<typeof recordedConfiguration> | null = null;
  try {
    recorded = recordedConfiguration(props.foundation.snapshot.records.filter(knownRecord));
  } catch {
    /* Incomplete lineage remains read-only. */
  }
  const fresh =
    active &&
    epoch.active === active &&
    result !== epoch.blocked &&
    result._tag === "Success" &&
    !result.waiting &&
    props.foundation.current;
  const occupied = props.foundation.snapshot.records.some(
    (record) =>
      (record.kind === "run-binding" && record.status !== "settled") ||
      (record.kind === "reservation" && record.status === "held"),
  );
  const available = fresh && recorded !== null && !occupied;
  const changed =
    draft !== null &&
    (draft.revision !== props.foundation.snapshot.revision ||
      draft.generation !== recorded?.generation);
  const provider = props.providers.find(
    (item) =>
      item.instanceId === draft?.values.providerInstanceId &&
      item.enabled &&
      item.driverKind === "piAgent",
  );
  const catalogueValid =
    provider !== undefined &&
    draft?.values.profiles.every((profile) => provider.models.includes(profile.model));
  let valid = false;
  try {
    if (draft) {
      validateValues(draft.values);
      valid = true;
    }
  } catch {
    /* The exact wire schema is the form's validation boundary. */
  }
  const canReconcile =
    available &&
    catalogueValid &&
    submission?.status === "uncertain" &&
    ((props.foundation.snapshot.revision === submission.command.expectedRevision &&
      recorded?.generation === submission.command.expectedConfigurationGeneration) ||
      (recorded?.generation === submission.command.expectedConfigurationGeneration + 1 &&
        sameValues(recorded.values, commandValues(submission.command))));
  const superseded =
    available &&
    submission?.status === "accepted" &&
    recorded !== null &&
    recorded.generation > submission.command.expectedConfigurationGeneration + 1 &&
    props.foundation.snapshot.revision !== null &&
    props.foundation.snapshot.revision >= (submission.receiptRevision ?? Infinity);
  const complete =
    submission?.status === "accepted" &&
    fresh &&
    recorded?.generation === submission.command.expectedConfigurationGeneration + 1 &&
    props.foundation.snapshot.revision !== null &&
    props.foundation.snapshot.revision >= (submission.receiptRevision ?? Infinity) &&
    sameValues(recorded.values, commandValues(submission.command));
  useEffect(() => {
    if (!complete || !recorded || !submission || !owner.current) return;
    setDraft({
      values: recorded.values!,
      revision: props.foundation.snapshot.revision!,
      generation: recorded.generation,
    });
    pending.current = null;
    setSubmission(null);
    setNotice("Configuration saved in the recorded project. No assignment was started.");
    setEditorEpoch((value) => value + 1);
  }, [complete, recorded, submission, props.foundation.snapshot.revision]);
  const updatedAt = props.foundation.snapshot.records.reduce(
    (latest, record) => (record.updatedAt > latest ? record.updatedAt : latest),
    "",
  );
  function load() {
    if (!available || (pending.current && !superseded)) return;
    const latest = props.foundation.verify();
    const current = recordedConfiguration(latest.records.filter(knownRecord));
    if (
      pending.current &&
      (pending.current.status !== "accepted" ||
        current.generation <= pending.current.command.expectedConfigurationGeneration + 1 ||
        latest.revision! < (pending.current.receiptRevision ?? Infinity))
    )
      return;
    storeSubmission(null);
    setDraft({
      revision: latest.revision!,
      generation: current.generation,
      values: current.values ?? {
        enabled: false,
        providerInstanceId: "",
        projectPriority: 0,
        taskPriorities: [],
        profiles: roles.map((role) => ({
          role,
          instructions: "",
          skills: [],
          tools: [],
          model: "",
          memoryAccess: "none",
          delegationDepth: 0,
        })),
        modelPolicies: [],
        ...PROJECT_TEAM_DEFAULT_LIMITS,
      },
    });
    setNotice("");
    setEditorEpoch((value) => value + 1);
  }
  function update(values: FormValues) {
    if (draft && !pending.current) setDraft({ ...draft, values });
  }
  function checkedCurrent() {
    const currentAccess = access.current;
    if (
      !owner.current ||
      !currentAccess.connected ||
      !currentAccess.enabled ||
      !currentAccess.supported ||
      !currentAccess.writesSupported ||
      !fresh
    )
      throw unavailable();
    const snapshot = currentAccess.foundation.verify();
    const current = recordedConfiguration(snapshot.records.filter(knownRecord));
    if (
      snapshot.records.some(
        (record) =>
          (record.kind === "run-binding" && record.status !== "settled") ||
          (record.kind === "reservation" && record.status === "held"),
      )
    )
      throw unavailable();
    return { snapshot, current };
  }
  async function send(retry: boolean) {
    let command: ProjectTeamConfigurationIntent | undefined;
    try {
      const { snapshot, current } = checkedCurrent();
      if (retry) {
        const previous = pending.current;
        if (previous?.status !== "uncertain") return;
        command = previous.command;
        const unchanged =
          snapshot.revision === command.expectedRevision &&
          current.generation === command.expectedConfigurationGeneration;
        const recordedOriginal =
          current.generation === command.expectedConfigurationGeneration + 1 &&
          sameValues(current.values, commandValues(command));
        if (!unchanged && !recordedOriginal) throw unavailable();
      } else {
        if (
          !draft ||
          pending.current ||
          !catalogueValid ||
          !valid ||
          snapshot.revision !== draft.revision ||
          current.generation !== draft.generation
        )
          throw unavailable();
        command = decode({
          ...draft.values,
          type: "project-team.configure",
          commandId: CommandId.make(randomUUID()),
          projectId: props.projectId,
          expectedRevision: snapshot.revision,
          expectedConfigurationGeneration: current.generation,
        });
      }
      const currentProvider = access.current.providers.find(
        (item) =>
          item.instanceId === command!.providerInstanceId &&
          item.enabled &&
          item.driverKind === "piAgent",
      );
      if (
        !currentProvider ||
        command.profiles.some((profile) => !currentProvider.models.includes(profile.model))
      )
        throw unavailable();
      storeSubmission({ command, status: "sending" });
      setNotice("Saving configuration. Waiting for the authoritative receipt.");
      const outcome = await write({ environmentId: props.environmentId, input: command });
      if (!owner.current || pending.current?.command !== command) return;
      if (outcome._tag === "Failure") throw squashAtomCommandFailure(outcome);
      const receipt = decodeReceipt(outcome.value);
      if (
        receipt.projectId !== command.projectId ||
        receipt.receipt.projectId !== command.projectId ||
        receipt.receipt.commandId !== command.commandId ||
        receipt.revision !== receipt.receipt.revision ||
        receipt.revision <= command.expectedRevision
      )
        throw new Error("Configuration receipt could not be verified.");
      storeSubmission({ command, status: "accepted", receiptRevision: receipt.revision });
      setNotice("Receipt accepted. Waiting for the complete recorded configuration to refresh.");
      access.current.foundation.refresh();
    } catch (error) {
      if (!owner.current) return;
      if (command && pending.current?.command === command) {
        if (!retry && explicitRejection(error)) storeSubmission(null);
        else storeSubmission({ command, status: "uncertain" });
      }
      setNotice(projectWorkCommandFailure(error).message);
    }
  }
  const values = draft?.values;
  const locked = !available || changed || submission !== null;
  const selectable = props.providers.filter(
    (item) => item.driverKind === "piAgent" && item.enabled,
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="space-y-2">
        <WorkSectionHeader
          title="Team configuration"
          status={
            <>
              {fresh ? "Current recorded configuration" : "Cached or incomplete configuration"}
              {updatedAt ? (
                <>
                  {" · Last recorded update "}
                  <WorkTime value={updatedAt} />
                </>
              ) : null}
            </>
          }
          description="Choose the Pi provider, a model and instructions for each role, and the limits each model runs under."
          actions={
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={!props.connected || !props.enabled}
                onClick={props.foundation.refresh}
              >
                <RefreshCwIcon aria-hidden />
                Refresh configuration
              </Button>
              <Button
                size="sm"
                variant={values ? "outline" : "default"}
                disabled={!available || (submission !== null && !superseded)}
                onClick={load}
              >
                {values
                  ? "Reload configuration"
                  : recorded?.values
                    ? "Edit configuration"
                    : "Set up team"}
              </Button>
            </>
          }
        />
        <p className="text-xs text-muted-foreground">
          Saving installs new immutable role profiles and limits. It never starts assignments or
          changes a running profile.
        </p>
        {!props.enabled ? (
          <Warning>Project Work is disabled. Enable it before configuring a team.</Warning>
        ) : null}
        {!props.writesSupported ? (
          <Warning>This environment does not support configuration writes.</Warning>
        ) : null}
        {occupied ? (
          <Warning>Stop and drain existing team work before changing configuration.</Warning>
        ) : null}
        {!recorded ? (
          <Warning>
            Configuration lineage is incomplete or unsupported. Refresh before making changes.
          </Warning>
        ) : null}
        {changed ? (
          <Warning>
            The recorded revision or generation changed. Reload configuration before saving.
          </Warning>
        ) : null}
      </div>
      {recorded?.values && !values ? (
        <p className="text-sm text-muted-foreground">
          Recorded team {recorded.values.enabled ? "enabled" : "disabled"} · Provider{" "}
          {recorded.values.providerInstanceId} · Models{" "}
          {recorded.values.modelPolicies.map((policy) => policy.model).join(", ")} · Generation{" "}
          {recorded.generation}
        </p>
      ) : null}
      {values ? (
        <fieldset key={editorEpoch} disabled={locked} className="flex min-w-0 flex-col gap-4">
          <WorkCard className="space-y-3">
            <h3 className="font-medium">Team</h3>
            <label className="flex items-center gap-2 text-sm">
              <input
                aria-label="Enable team"
                type="checkbox"
                checked={values.enabled}
                onChange={(event) => update({ ...values, enabled: event.target.checked })}
              />
              Enable team
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Pi provider
              <select
                aria-label="Pi provider"
                value={values.providerInstanceId}
                onChange={(event) =>
                  update({
                    ...values,
                    providerInstanceId: event.target.value,
                  })
                }
                className={workSelectClass}
              >
                <option value="">Select a provider</option>
                {!selectable.some((item) => item.instanceId === values.providerInstanceId) &&
                values.providerInstanceId ? (
                  <option value={values.providerInstanceId}>
                    Saved provider {values.providerInstanceId} (unavailable)
                  </option>
                ) : null}
                {selectable.map((item) => (
                  <option key={item.instanceId} value={item.instanceId}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            {!provider || provider.models.length === 0 ? (
              <p className="text-sm text-warning-foreground">
                Pi model catalogue unavailable. Configure an enabled Pi provider with model metadata
                in provider settings.
              </p>
            ) : null}
            {!catalogueValid ? (
              <p className="text-sm text-warning-foreground">
                Select available models explicitly. Saved models remain visible and are never
                replaced automatically.
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <NumberInput
                label="Project priority"
                value={values.projectPriority}
                min={Number.MIN_SAFE_INTEGER}
                max={Number.MAX_SAFE_INTEGER}
                onChange={(value) => update({ ...values, projectPriority: value })}
              />
              {(
                [
                  ["environmentModelCalls", "Environment model calls", 128],
                  ["projectWritableWorkers", "Project writable workers", 64],
                  ["delegationDepth", "Team delegation depth", 8],
                  ["repairAllowance", "Repair allowance", 16],
                ] as const
              ).map(([key, label, max]) => (
                <NumberInput
                  key={key}
                  label={label}
                  value={values[key] ?? 0}
                  min={0}
                  max={max}
                  onChange={(value) => update({ ...values, [key]: value })}
                />
              ))}
            </div>
            <WorkDisclosure summary="Task priorities" hint="Optional ordering for current tasks">
              <label className="flex flex-col gap-1 text-sm">
                Task priorities (task ID: priority, one per line)
                <Textarea
                  aria-label="Task priorities"
                  maxLength={40000}
                  defaultValue={values.taskPriorities
                    .map((entry) => `${entry.taskId}: ${entry.priority}`)
                    .join("\n")}
                  onChange={(event) => {
                    const entries = event.target.value
                      .split("\n")
                      .filter(Boolean)
                      .slice(0, 129)
                      .map((line) => {
                        const separator = line.lastIndexOf(":");
                        return {
                          taskId: (separator < 0 ? line : line.slice(0, separator)).trim(),
                          priority: separator < 0 ? NaN : Number(line.slice(separator + 1)),
                        };
                      });
                    update({ ...values, taskPriorities: entries });
                  }}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Use current project task IDs. The server checks membership before recording
                priorities.
              </p>
            </WorkDisclosure>
          </WorkCard>
          {values.profiles.map((profile, index) => (
            <WorkCard key={profile.role} className="space-y-3">
              <h3 className="font-medium">{workStateLabel(profile.role)}</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-sm">
                  Model
                  <select
                    aria-label={`${profile.role} model`}
                    value={profile.model}
                    className={workSelectClass}
                    onChange={(event) => {
                      const profiles = values.profiles.map((item, position) =>
                        position === index ? { ...item, model: event.target.value } : item,
                      );
                      const models = [
                        ...new Set(profiles.map((item) => item.model).filter(Boolean)),
                      ];
                      update({
                        ...values,
                        profiles,
                        modelPolicies: models.map(
                          (model) =>
                            values.modelPolicies.find((policy) => policy.model === model) ?? {
                              model,
                              tokenLimit: NaN,
                              durationLimitMs: NaN,
                              modelCalls: NaN,
                            },
                        ),
                      });
                    }}
                  >
                    <option value="">Select a model</option>
                    {profile.model && !provider?.models.includes(profile.model) ? (
                      <option value={profile.model}>{profile.model} (unavailable)</option>
                    ) : null}
                    {[...new Set(provider?.models ?? [])].map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  Memory access
                  <select
                    aria-label={`${profile.role} memory`}
                    className={workSelectClass}
                    value={profile.memoryAccess}
                    onChange={(event) =>
                      update({
                        ...values,
                        profiles: values.profiles.map((item, position) =>
                          position === index
                            ? {
                                ...item,
                                memoryAccess: event.target.value as Profile["memoryAccess"],
                              }
                            : item,
                        ),
                      })
                    }
                  >
                    <option value="none">None</option>
                    <option value="project">Project</option>
                    <option value="shared">Explicitly shared</option>
                  </select>
                </label>
                <NumberInput
                  label={`${profile.role} delegation depth`}
                  visibleLabel="Delegation depth"
                  value={profile.delegationDepth}
                  min={0}
                  max={8}
                  onChange={(value) =>
                    update({
                      ...values,
                      profiles: values.profiles.map((item, position) =>
                        position === index ? { ...item, delegationDepth: value } : item,
                      ),
                    })
                  }
                />
              </div>
              <label className="flex flex-col gap-1 text-sm">
                Instructions
                <Textarea
                  aria-label={`${profile.role} instructions`}
                  maxLength={32000}
                  value={profile.instructions}
                  onChange={(event) =>
                    update({
                      ...values,
                      profiles: values.profiles.map((item, position) =>
                        position === index ? { ...item, instructions: event.target.value } : item,
                      ),
                    })
                  }
                />
              </label>
              <WorkDisclosure
                summary="Skills and tools"
                hint={`${profile.skills.length} skills · ${profile.tools.length} tools`}
              >
                {(["skills", "tools"] as const).map((key) => (
                  <label key={key} className="flex flex-col gap-1 text-sm">
                    {key === "skills" ? "Skills" : "Tools"} (one per line)
                    <Textarea
                      aria-label={`${profile.role} ${key}`}
                      maxLength={17000}
                      defaultValue={profile[key].join("\n")}
                      onChange={(event) =>
                        update({
                          ...values,
                          profiles: values.profiles.map((item, position) =>
                            position === index
                              ? {
                                  ...item,
                                  [key]: event.target.value
                                    .split("\n")
                                    .map((entry) => entry.trim())
                                    .filter(Boolean),
                                }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
              </WorkDisclosure>
            </WorkCard>
          ))}
          {values.modelPolicies.map((policy, index) => (
            <WorkCard key={policy.model} className="space-y-3">
              <h3 className="font-medium">Limits · {policy.model}</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                {(
                  [
                    ["tokenLimit", "Token limit", Number.MAX_SAFE_INTEGER],
                    ["durationLimitMs", "Time limit (ms)", Number.MAX_SAFE_INTEGER],
                    ["modelCalls", "Concurrent model calls", 128],
                  ] as const
                ).map(([key, label, max]) => (
                  <NumberInput
                    key={key}
                    label={`${policy.model} ${label}`}
                    visibleLabel={label}
                    value={policy[key]}
                    min={1}
                    max={max}
                    onChange={(value) =>
                      update({
                        ...values,
                        modelPolicies: values.modelPolicies.map((item, position) =>
                          position === index ? { ...item, [key]: value } : item,
                        ),
                      })
                    }
                  />
                ))}
              </div>
            </WorkCard>
          ))}
        </fieldset>
      ) : null}
      {values ? (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-border/70 bg-background/95 py-3">
          <Button disabled={locked || !catalogueValid || !valid} onClick={() => void send(false)}>
            Save configuration
          </Button>
          {!catalogueValid || !valid ? (
            <span className="text-xs text-muted-foreground">
              Complete every model and limit before saving.
            </span>
          ) : null}
        </div>
      ) : null}
      {superseded ? (
        <p className="text-sm text-warning-foreground">
          Your configuration was accepted, then replaced by a newer recorded generation. Reload the
          current configuration to continue.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {submission ? (
        <p className="break-all text-xs text-muted-foreground">
          Original command {submission.command.commandId} · {submission.status}
        </p>
      ) : null}
      {submission?.status === "uncertain" ? (
        <>
          <p className="text-sm text-warning-foreground">
            The outcome is uncertain. The original payload is locked. Refresh recorded state, then
            reconcile the exact command receipt.
          </p>
          <Button
            size="sm"
            className="self-start"
            disabled={!canReconcile}
            onClick={() => void send(true)}
          >
            Reconcile original command
          </Button>
        </>
      ) : null}
    </div>
  );
}

function Warning({ children }: { readonly children: ReactNode }) {
  return <p className="text-sm text-warning-foreground">{children}</p>;
}

function NumberInput(props: {
  readonly label: string;
  readonly visibleLabel?: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {props.visibleLabel ?? props.label}
      <Input
        aria-label={props.label}
        type="number"
        min={props.min}
        max={props.max}
        step={1}
        value={Number.isFinite(props.value) ? props.value : ""}
        onChange={(event) =>
          props.onChange(event.target.value === "" ? NaN : Number(event.target.value))
        }
      />
    </label>
  );
}
