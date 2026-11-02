import {
  projectWorkSelectionIsCurrent,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import {
  CommandId,
  PROJECT_TEAM_PRESETS,
  type ProjectWorkTaskId,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { useId, useState } from "react";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { WorkTeamMembers } from "./WorkTeamRoster";
import { useWorkTeamRoster } from "./useWorkTeamRoster";
import { WorkAvatarEditor } from "./WorkAvatarEditor";
import { WorkMemberAvatar } from "./WorkMemberAvatar";
import { memberAvatarIdentity } from "./workTeamView";
import { Input } from "../ui/input";
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
import { workRecordsBlockedReason } from "./useWorkRecords";
import type { WorkWriter } from "./useWorkWriter";
import {
  buildTeamConfigurationIntent,
  emptyTeamConfiguration,
  fillPresetNames,
  MEMORY_ACCESS,
  recordedTeamConfiguration,
  syncModelPolicies,
  teamEffortControl,
  teamEffortValue,
  teamProviderOf,
  type TeamConfigurationValues,
  type TeamProfile,
  withTeamEffort,
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
export function WorkTeam({
  scope,
  writer,
  onOpenTask,
}: {
  scope: ProjectWorkScope;
  writer: WorkWriter;
  onOpenTask: (id: ProjectWorkTaskId) => void;
}) {
  const { limits, roles, members, records, roster } = useWorkTeamRoster(scope);
  const providersByEnvironment = useEnvironmentProviders();
  const [draft, setDraft] = useState<Draft | null>(null);
  const key = "team:configure";

  const sets = [limits, roles, members];
  const complete = sets.every((set) => set.complete);
  const revision =
    complete && sets.every((set) => set.revision === limits.revision) ? limits.revision : null;
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
  const availableModels = new Map(
    providers.map((entry) => [
      entry.instanceId as string,
      new Set(entry.models.map((model) => model.slug)),
    ]),
  );
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
          availableModels,
        });
  // Validation only; the sent intent gets its own command ID when saving.
  const built = build(VALIDATION_COMMAND_ID);
  const buildReason = built !== null && "reason" in built ? built.reason : null;

  const open = (toggle: boolean) => {
    if (recorded === null || revision === null) return;
    const empty = emptyTeamConfiguration();
    // A new team starts every member on the first enabled provider; each can change it.
    const values =
      recorded.kind === "configured"
        ? recorded.values
        : providers[0] === undefined
          ? empty
          : {
              ...empty,
              profiles: empty.profiles.map((profile) => ({
                ...profile,
                providerInstanceId: providers[0]!.instanceId,
              })),
            };
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
      grouped={false}
      className="mx-auto w-full max-w-6xl gap-3"
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
      <WorkRecordsNotice set={limits} subject="team limits" />
      <WorkRecordsNotice set={roles} subject="role profiles" />
      <WorkRecordsNotice set={members} subject="team members" />
      {recorded === null ? null : recorded.kind === "none" ? (
        <p className="m-0 rounded-xl border border-dashed border-border/70 px-4 py-3 text-sm text-muted-foreground">
          Meet Quinn, Iris, Sage, Otto, Vera and Wren. Set up a provider and models, then override
          any name or role instructions.
        </p>
      ) : recorded.kind === "unreadable" ? (
        <WorkFormStatus tone="muted" message={recorded.reason} />
      ) : (
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/40 p-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant={recorded.values.enabled ? "success" : "outline"}>
              {recorded.values.enabled ? "Enabled" : "Disabled"}
            </Badge>
            <span className="min-w-0 truncate text-sm font-medium">
              {[
                ...new Set(
                  recorded.values.profiles.map((profile) =>
                    providerLabel(teamProviderOf(recorded.values, profile)),
                  ),
                ),
              ].join(" · ")}
            </span>
            <WorkRevision className="ms-auto text-muted-foreground">
              generation {recorded.generation}
            </WorkRevision>
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-2 @2xl/work:grid-cols-4">
            {LIMIT_FIELDS.map(([field, label]) => (
              <div
                key={field}
                className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border/60 bg-background/40 px-3 py-2"
              >
                <span className="text-lg leading-6 font-semibold tabular-nums">
                  {recorded.values[field] ?? 0}
                </span>
                <span className="truncate text-xs text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
          <WorkMeta>
            Enabling a team doesn't start anything. Each worker starts from an approved task.
          </WorkMeta>
        </div>
      )}
      {configured && roster.length > 0 ? (
        <div className="flex min-w-0 items-baseline gap-2 px-1 pt-2">
          <h3 className="m-0 text-sm font-medium">Members</h3>
          <span className="text-xs tabular-nums text-muted-foreground">{roster.length}</span>
          <WorkMeta className="ms-auto tabular-nums">
            {roster.filter((member) => member.activity.state === "running").length} working
          </WorkMeta>
        </div>
      ) : null}
      {configured ? <WorkTeamMembers scope={scope} onOpenTask={onOpenTask} /> : null}
      {draft !== null ? (
        <WorkRow className="gap-4 rounded-xl border border-border/60 bg-card/40 py-4">
          {changed ? (
            <WorkReviewChanged
              onReview={() => {
                if (recorded === null || recorded.kind === "unreadable" || blocked !== null) return;
                const latest = recorded.kind === "configured" ? recorded.values : null;
                setDraft({
                  ...draft,
                  selected: current,
                  generation: recorded.generation,
                  recorded: latest,
                  values:
                    draft.toggle && latest ? { ...latest, enabled: !latest.enabled } : draft.values,
                });
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
              recorded={draft.recorded}
              providers={providers.map((entry) => ({
                id: entry.instanceId,
                label: entry.displayName,
                models: entry.models.map((model) => ({
                  slug: model.slug,
                  name: model.name,
                  descriptors: model.capabilities?.optionDescriptors,
                })),
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
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined;
  }>;
}

const DEFAULT_EFFORT = "__default";

/** A member's provider, model and reasoning effort; changing a provider asks for its model again. */
function MemberRouteFields(props: {
  readonly providers: ReadonlyArray<ProviderChoice>;
  readonly providerItems: Record<string, string>;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly options: TeamProfile["options"];
  readonly onChange: (update: (profile: TeamProfile) => TeamProfile) => void;
}) {
  // Options belong to one model, so they are dropped whenever the route changes.
  const withoutOptions = ({ options: _options, ...profile }: TeamProfile): TeamProfile => profile;
  const provider = props.providers.find((entry) => entry.id === props.providerInstanceId);
  const model = provider?.models.find((entry) => entry.slug === props.model);
  const effort = teamEffortControl(model?.descriptors);
  const chosenEffort = effort ? teamEffortValue(props.options, effort.descriptor.id) : null;
  const modelItems = Object.fromEntries(
    (provider?.models ?? []).map((entry) => [entry.slug, entry.name]),
  );
  const effortItems = effort
    ? {
        [DEFAULT_EFFORT]: "Model default",
        ...Object.fromEntries(effort.choices.map((choice) => [choice.id, choice.label])),
      }
    : {};
  return (
    <div className="grid gap-2 sm:col-span-2 sm:grid-cols-3">
      <WorkField label="Provider">
        {(id) => (
          <Select
            value={props.providerInstanceId || null}
            items={props.providerItems}
            onValueChange={(value) => {
              if (typeof value !== "string" || value === props.providerInstanceId) return;
              props.onChange((profile) => ({
                ...withoutOptions(profile),
                providerInstanceId: value as NonNullable<TeamProfile["providerInstanceId"]>,
                model: "",
              }));
            }}
          >
            <SelectTrigger id={id}>
              <SelectValue placeholder="Choose a provider" />
            </SelectTrigger>
            <SelectPopup>
              {props.providers.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
      </WorkField>
      <WorkField label="Model">
        {(id) => (
          <Select
            value={props.model || null}
            items={modelItems}
            onValueChange={(value) =>
              typeof value === "string" &&
              value !== props.model &&
              // Effort levels belong to one model; a new model starts at its default.
              props.onChange((profile) => ({ ...withoutOptions(profile), model: value }))
            }
          >
            <SelectTrigger id={id} disabled={provider === undefined}>
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectPopup>
              {(provider?.models ?? []).map((entry) => (
                <SelectItem key={entry.slug} value={entry.slug}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
      </WorkField>
      <WorkField label={effort?.descriptor.label ?? "Effort"}>
        {(id) => (
          <Select
            value={effort ? (chosenEffort ?? DEFAULT_EFFORT) : null}
            items={effortItems}
            onValueChange={(value) => {
              if (effort === null || typeof value !== "string") return;
              props.onChange((profile) => {
                const options = withTeamEffort(
                  profile.options,
                  effort.descriptor.id,
                  value === DEFAULT_EFFORT ? null : value,
                );
                return options === undefined
                  ? withoutOptions(profile)
                  : { ...withoutOptions(profile), options };
              });
            }}
          >
            <SelectTrigger id={id} disabled={effort === null}>
              <SelectValue placeholder={model ? "Not adjustable" : "Choose a model first"} />
            </SelectTrigger>
            <SelectPopup>
              {effort ? <SelectItem value={DEFAULT_EFFORT}>Model default</SelectItem> : null}
              {(effort?.choices ?? []).map((choice) => (
                <SelectItem key={choice.id} value={choice.id}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
      </WorkField>
    </div>
  );
}

function TeamForm({
  values,
  recorded,
  providers,
  onChange,
}: {
  readonly values: TeamConfigurationValues;
  readonly recorded: TeamConfigurationValues | null;
  readonly providers: ReadonlyArray<ProviderChoice>;
  readonly onChange: (values: TeamConfigurationValues) => void;
}) {
  const enabledId = useId();
  const providerItems = Object.fromEntries(providers.map((entry) => [entry.id, entry.label]));
  const providerName = (id: string) =>
    providers.find((entry) => entry.id === id)?.label ?? `${id} (unavailable)`;
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
      {providers.length === 0 ? (
        <WorkMeta>No providers are enabled on this environment. Enable one in Settings.</WorkMeta>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <WorkMeta>
          Start with the predefined agents, then make them your own. Names don't change a role's
          permissions.
        </WorkMeta>
        {values.profiles.some((p) => !p.name?.trim()) ? (
          <Button size="sm" variant="outline" onClick={() => onChange(fillPresetNames(values))}>
            Use preset names ({values.profiles.filter((p) => !p.name?.trim()).length})
          </Button>
        ) : null}
      </div>
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
              <legend className="px-1 text-sm font-medium">
                <span className="inline-flex items-center gap-2">
                  <WorkMemberAvatar
                    member={memberAvatarIdentity(
                      profile.role,
                      profile.name ?? profile.role,
                      profile.avatar,
                    )}
                  />
                  {profile.name?.trim() || workStateLabel(profile.role)} ·{" "}
                  {workStateLabel(profile.role)}
                </span>
              </legend>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                {PROJECT_TEAM_PRESETS[profile.role].specialty}
              </p>
              <WorkAvatarEditor
                identity={memberAvatarIdentity(profile.role, profile.name ?? profile.role)}
                preset={PROJECT_TEAM_PRESETS[profile.role].avatar}
                name={profile.name?.trim() || workStateLabel(profile.role)}
                avatar={profile.avatar}
                others={values.profiles.flatMap((p, at) =>
                  at !== index && p.avatar ? [p.avatar] : [],
                )}
                onChange={(avatar) => set({ avatar })}
              />
              <WorkField label="Display name">
                {(id) => (
                  <Input
                    id={id}
                    maxLength={40}
                    placeholder={workStateLabel(profile.role)}
                    value={profile.name ?? ""}
                    onChange={(event) => set({ name: event.target.value })}
                  />
                )}
              </WorkField>
              <div className="flex flex-wrap items-end gap-2">
                {profile.name?.trim() &&
                profile.name.trim() !== PROJECT_TEAM_PRESETS[profile.role].name ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => set({ name: PROJECT_TEAM_PRESETS[profile.role].name })}
                  >
                    Use {PROJECT_TEAM_PRESETS[profile.role].name}
                  </Button>
                ) : null}
                {(profile.name ?? "") !==
                (recorded?.profiles.find((p) => p.role === profile.role)?.name ?? "") ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      set({
                        name: recorded?.profiles.find((p) => p.role === profile.role)?.name ?? "",
                      })
                    }
                  >
                    Revert name
                  </Button>
                ) : null}
              </div>
              <MemberRouteFields
                providers={providers}
                providerItems={providerItems}
                providerInstanceId={teamProviderOf(values, profile)}
                model={profile.model}
                options={profile.options}
                onChange={(update) =>
                  onChange({
                    ...values,
                    profiles: values.profiles.map((entry, at) =>
                      at === index ? update(entry) : entry,
                    ),
                  })
                }
              />
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
          <span className="text-sm font-medium">Limits per provider and model</span>
          {values.modelPolicies.map((policy, index) => {
            const set = (patch: Partial<typeof policy>) =>
              onChange({
                ...values,
                modelPolicies: values.modelPolicies.map((entry, at) =>
                  at === index ? { ...entry, ...patch } : entry,
                ),
              });
            return (
              <div
                key={`${teamProviderOf(values, policy)}:${policy.model}`}
                className="grid gap-2 sm:grid-cols-3"
              >
                <WorkNumber
                  label={`${providerName(teamProviderOf(values, policy))} · ${policy.model}: tokens`}
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
