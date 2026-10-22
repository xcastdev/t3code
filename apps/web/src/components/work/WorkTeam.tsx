import {
  asProjectTeamRecord,
  projectWorkSelectionIsCurrent,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import { CommandId, type ProjectTeamRecordRead } from "@t3tools/contracts";
import { useId, useState } from "react";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  WorkField,
  WorkFormStatus,
  WorkMeta,
  WorkRevision,
  WorkRow,
  WorkSection,
} from "./WorkLayout";
import { WorkRecordsNotice, WorkReviewChanged } from "./WorkNotice";
import { useWorkRecords, workRecordsBlockedReason } from "./useWorkRecords";
import type { WorkWriter } from "./useWorkWriter";
import {
  buildTeamConfigurationIntent,
  emptyTeamConfiguration,
  MEMORY_ACCESS,
  recordedTeamConfiguration,
  syncModelPolicies,
  type TeamConfigurationValues,
} from "./workLogic";
import { workStateLabel } from "./workModel";
import { newCommandId } from "./workTaskSurface";

const MEMORY_LABELS = { none: "No memory", project: "Project memory", shared: "Shared memory" };
const LIMIT_FIELDS = [
  ["environmentModelCalls", "Environment model calls", 128],
  ["projectWritableWorkers", "Writable workers", 64],
  ["delegationDepth", "Delegation depth", 8],
  ["repairAllowance", "Repair allowance", 16],
] as const;

const VALIDATION_COMMAND_ID = CommandId.make("validation");

interface Draft {
  readonly values: TeamConfigurationValues;
  readonly selected: ProjectWorkSelection;
  readonly generation: number;
  /** The configured values the draft was opened from. */
  readonly recorded: TeamConfigurationValues | null;
  /** Set for the one-step enable/disable confirmation, which resends the recorded values. */
  readonly toggle: boolean;
}

/**
 * Human team setup: one provider, a model and instructions per role, and the
 * limits each model runs under. Saving records configuration only; workers
 * start one at a time from an approved task.
 */
export function WorkTeam({ scope, writer }: { scope: ProjectWorkScope; writer: WorkWriter }) {
  const limits = useWorkRecords(scope.environmentId, {
    projectId: scope.projectId,
    operation: "foundation-records",
    recordKind: "limits",
  });
  const roles = useWorkRecords(scope.environmentId, {
    projectId: scope.projectId,
    operation: "foundation-records",
    recordKind: "role-revision",
  });
  const members = useWorkRecords(scope.environmentId, {
    projectId: scope.projectId,
    operation: "foundation-records",
    recordKind: "member",
  });
  const providersByEnvironment = useEnvironmentProviders();
  const [draft, setDraft] = useState<Draft | null>(null);
  const key = "team:configure";

  const sets = [limits, roles, members];
  const complete = sets.every((set) => set.complete);
  const revision =
    complete && sets.every((set) => set.revision === limits.revision) ? limits.revision : null;
  const records = sets.flatMap((set) =>
    set.records.flatMap((value): ProjectTeamRecordRead[] => {
      const record = asProjectTeamRecord(value);
      return record === null ? [] : [record];
    }),
  );
  const recorded = revision === null ? null : recordedTeamConfiguration(records);
  const blocked =
    workRecordsBlockedReason(limits, "team limits") ??
    workRecordsBlockedReason(roles, "role profiles") ??
    workRecordsBlockedReason(members, "team members") ??
    (revision === null ? "Team records are catching up." : null) ??
    (writer.canWrite ? null : "This connection is not allowed to change Work here.") ??
    (recorded?.kind === "unreadable" ? recorded.reason : null);
  const current: ProjectWorkSelection = { ...scope, revision: revision ?? -1, taskRevision: 0 };
  const changed =
    draft !== null &&
    (!projectWorkSelectionIsCurrent(draft.selected, current) ||
      draft.generation !== recorded?.generation);

  const providers = deriveProviderInstanceEntries(
    providersByEnvironment.get(scope.environmentId) ?? [],
  ).filter((entry) => entry.enabled);
  const provider = providers.find((entry) => entry.instanceId === draft?.values.providerInstanceId);
  const build = (commandId: CommandId) =>
    draft === null
      ? null
      : buildTeamConfigurationIntent({
          values: draft.values,
          recorded: draft.recorded,
          commandId,
          projectId: scope.projectId,
          expectedRevision: draft.selected.revision,
          expectedConfigurationGeneration: draft.generation,
          availableModels: provider ? new Set(provider.models.map((model) => model.slug)) : null,
        });
  // Validation only; the sent intent gets its own command ID when saving.
  const built = build(VALIDATION_COMMAND_ID);
  const buildReason = built !== null && "reason" in built ? built.reason : null;

  const open = (toggle: boolean) => {
    if (recorded === null || revision === null) return;
    const values = recorded.kind === "configured" ? recorded.values : emptyTeamConfiguration();
    setDraft({
      values: toggle ? { ...values, enabled: !values.enabled } : values,
      selected: current,
      generation: recorded.generation,
      recorded: recorded.kind === "configured" ? recorded.values : null,
      toggle,
    });
  };
  const save = async () => {
    const prepared = build(newCommandId());
    if (draft === null || prepared === null || !("intent" in prepared)) return;
    const sent = await writer.submit(key, draft.selected, current, prepared.intent);
    if (sent) setDraft(null);
  };
  const update = (values: TeamConfigurationValues) =>
    draft && setDraft({ ...draft, values: syncModelPolicies(values) });

  const configured = recorded?.kind === "configured" ? recorded.values : null;
  const providerLabel = (id: string) =>
    providers.find((entry) => entry.instanceId === id)?.displayName ?? `${id} (unavailable)`;

  return (
    <WorkSection
      title="Team"
      description="Roles, models and limits for managed work. Saving records them only; nothing starts."
      actions={
        draft === null && recorded !== null && recorded.kind !== "unreadable" ? (
          <>
            {configured ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={blocked !== null}
                title={blocked ?? undefined}
                onClick={() => open(true)}
              >
                {configured.enabled ? "Disable team…" : "Enable team…"}
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={blocked !== null}
              title={blocked ?? undefined}
              onClick={() => open(false)}
            >
              {configured ? "Edit team" : "Set up team"}
            </Button>
          </>
        ) : null
      }
    >
      <WorkRow>
        <WorkRecordsNotice set={limits} subject="team limits" />
        <WorkRecordsNotice set={roles} subject="role profiles" />
        <WorkRecordsNotice set={members} subject="team members" />
        {recorded === null ? null : recorded.kind === "none" ? (
          <p className="text-sm">No team is configured for this project.</p>
        ) : recorded.kind === "unreadable" ? (
          <WorkFormStatus tone="muted" message={recorded.reason} />
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={recorded.values.enabled ? "success" : "outline"}>
                {recorded.values.enabled ? "Enabled" : "Disabled"}
              </Badge>
              <span className="text-sm">{providerLabel(recorded.values.providerInstanceId)}</span>
              <WorkRevision className="text-muted-foreground">
                generation {recorded.generation}
              </WorkRevision>
            </div>
            <dl className="grid gap-x-4 gap-y-0.5 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
              {recorded.values.profiles.map((profile) => (
                <div key={profile.role} className="contents">
                  <dt className="text-muted-foreground">{workStateLabel(profile.role)}</dt>
                  <dd className="break-words">
                    {profile.model} · {MEMORY_LABELS[profile.memoryAccess]}
                  </dd>
                </div>
              ))}
            </dl>
            <WorkMeta>
              {LIMIT_FIELDS.map(([field, label]) => `${label} ${recorded.values[field] ?? 0}`).join(
                " · ",
              )}
            </WorkMeta>
          </div>
        )}
        <WorkMeta>
          Enabling a team doesn't start anything. Each worker starts from an approved task.
        </WorkMeta>
      </WorkRow>
      {draft !== null ? (
        <WorkRow className="gap-4">
          {changed ? (
            <WorkReviewChanged
              onReview={() => {
                setDraft(null);
              }}
            />
          ) : null}
          {draft.toggle ? (
            <p className="text-sm">
              {draft.values.enabled ? "Enable" : "Disable"} the recorded team at generation{" "}
              <WorkRevision>{draft.generation}</WorkRevision>? Profiles and limits stay the same.
            </p>
          ) : (
            <TeamForm
              values={draft.values}
              providers={providers.map((entry) => ({
                id: entry.instanceId,
                label: entry.displayName,
                models: entry.models.map((model) => ({ slug: model.slug, name: model.name })),
              }))}
              onChange={update}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                changed || blocked !== null || buildReason !== null || writer.pendingKey !== null
              }
              onClick={() => void save()}
            >
              {writer.pendingKey === key
                ? "Saving…"
                : draft.toggle
                  ? draft.values.enabled
                    ? "Enable team"
                    : "Disable team"
                  : "Save team"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
          <WorkFormStatus tone="muted" message={changed ? null : buildReason} />
          <WorkFormStatus message={writer.failureFor(key)} />
        </WorkRow>
      ) : null}
    </WorkSection>
  );
}

interface ProviderChoice {
  readonly id: string;
  readonly label: string;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
}

function TeamForm({
  values,
  providers,
  onChange,
}: {
  readonly values: TeamConfigurationValues;
  readonly providers: ReadonlyArray<ProviderChoice>;
  readonly onChange: (values: TeamConfigurationValues) => void;
}) {
  const enabledId = useId();
  const provider = providers.find((entry) => entry.id === values.providerInstanceId);
  const providerItems = Object.fromEntries(providers.map((entry) => [entry.id, entry.label]));
  const modelItems = Object.fromEntries(
    (provider?.models ?? []).map((model) => [model.slug, model.name]),
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Switch
          id={enabledId}
          checked={values.enabled}
          onCheckedChange={(checked) => onChange({ ...values, enabled: checked })}
        />
        <Label htmlFor={enabledId}>Team enabled</Label>
      </div>
      <WorkField label="Provider">
        {(id) => (
          <Select
            value={values.providerInstanceId || null}
            items={providerItems}
            onValueChange={(value) => {
              if (typeof value !== "string") return;
              // Models belong to one provider; switching asks for each role's model again.
              onChange({
                ...values,
                providerInstanceId: value as TeamConfigurationValues["providerInstanceId"],
                profiles: values.profiles.map((profile) => ({ ...profile, model: "" })),
              });
            }}
          >
            <SelectTrigger id={id}>
              <SelectValue placeholder="Choose a provider" />
            </SelectTrigger>
            <SelectPopup>
              {providers.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
      </WorkField>
      {providers.length === 0 ? (
        <WorkMeta>No providers are enabled on this environment. Enable one in Settings.</WorkMeta>
      ) : null}
      <div className="flex flex-col gap-3">
        {values.profiles.map((profile, index) => {
          const set = (patch: Partial<typeof profile>) =>
            onChange({
              ...values,
              profiles: values.profiles.map((entry, at) =>
                at === index ? { ...entry, ...patch } : entry,
              ),
            });
          return (
            <fieldset
              key={profile.role}
              className="grid gap-2 rounded-lg border border-border/60 p-3 sm:grid-cols-2"
            >
              <legend className="px-1 text-sm font-medium">{workStateLabel(profile.role)}</legend>
              <WorkField label="Model">
                {(id) => (
                  <Select
                    value={profile.model || null}
                    items={modelItems}
                    onValueChange={(value) => typeof value === "string" && set({ model: value })}
                  >
                    <SelectTrigger id={id} disabled={provider === undefined}>
                      <SelectValue placeholder="Choose a model" />
                    </SelectTrigger>
                    <SelectPopup>
                      {(provider?.models ?? []).map((model) => (
                        <SelectItem key={model.slug} value={model.slug}>
                          {model.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
              </WorkField>
              <WorkField label="Memory">
                {(id) => (
                  <Select
                    value={profile.memoryAccess}
                    items={MEMORY_LABELS}
                    onValueChange={(value) => {
                      const access = MEMORY_ACCESS.find((entry) => entry === value);
                      if (access) set({ memoryAccess: access });
                    }}
                  >
                    <SelectTrigger id={id}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {MEMORY_ACCESS.map((access) => (
                        <SelectItem key={access} value={access}>
                          {MEMORY_LABELS[access]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
              </WorkField>
              <div className="sm:col-span-2">
                <WorkField label="Instructions">
                  {(id) => (
                    <Textarea
                      id={id}
                      size="sm"
                      maxLength={32000}
                      value={profile.instructions}
                      onChange={(event) => set({ instructions: event.target.value })}
                    />
                  )}
                </WorkField>
              </div>
              <WorkNumber
                label="Delegation depth"
                value={profile.delegationDepth}
                max={8}
                onChange={(value) => set({ delegationDepth: value })}
              />
            </fieldset>
          );
        })}
      </div>
      {values.modelPolicies.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Limits per model</span>
          {values.modelPolicies.map((policy, index) => {
            const set = (patch: Partial<typeof policy>) =>
              onChange({
                ...values,
                modelPolicies: values.modelPolicies.map((entry, at) =>
                  at === index ? { ...entry, ...patch } : entry,
                ),
              });
            return (
              <div key={policy.model} className="grid gap-2 sm:grid-cols-3">
                <WorkNumber
                  label={`${policy.model}: tokens`}
                  value={policy.tokenLimit}
                  min={1}
                  onChange={(value) => set({ tokenLimit: value })}
                />
                <WorkNumber
                  label="Minutes"
                  value={Math.round(policy.durationLimitMs / 60_000)}
                  min={1}
                  onChange={(value) => set({ durationLimitMs: value * 60_000 })}
                />
                <WorkNumber
                  label="Model calls"
                  value={policy.modelCalls}
                  min={1}
                  max={128}
                  onChange={(value) => set({ modelCalls: value })}
                />
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {LIMIT_FIELDS.map(([field, label, max]) => (
          <WorkNumber
            key={field}
            label={label}
            value={values[field] ?? 0}
            max={max}
            onChange={(value) => onChange({ ...values, [field]: value })}
          />
        ))}
      </div>
      {values.taskPriorities.length > 0 ? (
        <WorkMeta>{values.taskPriorities.length} recorded task priorities are kept.</WorkMeta>
      ) : null}
    </div>
  );
}

function WorkNumber({
  label,
  value,
  min = 0,
  max,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <NumberField
      id={id}
      min={min}
      {...(max === undefined ? {} : { max })}
      step={1}
      value={value}
      onValueChange={(next) => onChange(next === null ? min : Math.trunc(next))}
    >
      <Label htmlFor={id}>{label}</Label>
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${label}`} />
        <NumberFieldInput />
        <NumberFieldIncrement aria-label={`Increase ${label}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}
