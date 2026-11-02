import {
  projectWorkSelectionIsCurrent,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import {
  CommandId,
  type EnvironmentId,
  PROJECT_TEAM_PRESETS,
  type ProjectWorkTaskId,
} from "@t3tools/contracts";
import { ArrowLeftIcon, PencilIcon, PowerIcon, PowerOffIcon } from "lucide-react";
import { useId, useState } from "react";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { ModelSelectionPicker } from "../chat/ModelSelectionPicker";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
  teamProviderOf,
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
  readonly view: DraftView;
}

/**
 * What the draft edits. A configured team is edited one member, or the team settings, at a
 * time; each still sends the whole configuration with everything else as recorded.
 */
type DraftView =
  | { readonly kind: "setup" }
  | { readonly kind: "member"; readonly role: TeamConfigurationValues["profiles"][number]["role"] }
  | { readonly kind: "settings" }
  /** The one-step enable/disable confirmation, which resends the recorded values. */
  | { readonly kind: "toggle" };

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

  const open = (view: DraftView) => {
    const toggle = view.kind === "toggle";
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
      view,
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
  const reviewLatest = () => {
    if (draft === null || recorded === null || recorded.kind === "unreadable" || blocked !== null)
      return;
    const latest = recorded.kind === "configured" ? recorded.values : null;
    // A member or settings edit keeps its own change on top of what is now recorded.
    const rebased =
      latest === null
        ? draft.values
        : draft.view.kind === "toggle"
          ? { ...latest, enabled: !latest.enabled }
          : draft.view.kind === "member"
            ? syncModelPolicies({
                ...latest,
                profiles: latest.profiles.map((profile) =>
                  profile.role === (draft.view as { role: string }).role
                    ? (draft.values.profiles.find((entry) => entry.role === profile.role) ??
                      profile)
                    : profile,
                ),
              })
            : draft.view.kind === "settings"
              ? {
                  ...latest,
                  modelPolicies: draft.values.modelPolicies,
                  ...Object.fromEntries(
                    LIMIT_FIELDS.flatMap(([field]) =>
                      draft.values[field] === undefined ? [] : [[field, draft.values[field]]],
                    ),
                  ),
                }
              : draft.values;
    setDraft({
      ...draft,
      selected: current,
      generation: recorded.generation,
      recorded: latest,
      values: rebased,
    });
  };
  const providerChoices = providers.map((entry) => ({
    id: entry.instanceId as string,
    label: entry.displayName,
    models: entry.models.map((model) => ({ slug: model.slug, name: model.name })),
  }));

  const configured = recorded?.kind === "configured" ? recorded.values : null;
  // Picking a route re-syncs the policies, so an untouched draft may differ only in their order.
  const dirty =
    draft !== null &&
    (draft.recorded === null ||
      (JSON.stringify(draft.values) !== JSON.stringify(draft.recorded) &&
        JSON.stringify(draft.values) !== JSON.stringify(syncModelPolicies(draft.recorded))));
  const editing =
    draft !== null && (draft.view.kind === "member" || draft.view.kind === "settings");
  const providerLabel = (id: string) =>
    providers.find((entry) => entry.instanceId === id)?.displayName ?? `${id} (unavailable)`;

  return (
    <WorkSection
      title={
        <span className="flex min-w-0 items-center gap-2">
          Team
          {configured && !editing ? (
            <>
              <Badge variant={configured.enabled ? "success" : "outline"}>
                {configured.enabled ? "Enabled" : "Disabled"}
              </Badge>
              <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">
                {[
                  ...new Set(
                    configured.profiles.map((profile) =>
                      providerLabel(teamProviderOf(configured, profile)),
                    ),
                  ),
                ].join(" · ")}
              </span>
            </>
          ) : null}
        </span>
      }
      grouped={false}
      className="mx-auto w-full max-w-6xl gap-3"
      actions={
        draft === null && recorded !== null && recorded.kind !== "unreadable" ? (
          configured ? (
            <>
              <EditIconButton
                label="Edit team settings"
                disabled={blocked !== null}
                reason={blocked}
                onClick={() => open({ kind: "settings" })}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={configured.enabled ? "Disable team" : "Enable team"}
                      disabled={blocked !== null}
                      onClick={() => open({ kind: "toggle" })}
                    />
                  }
                >
                  {configured.enabled ? <PowerOffIcon /> : <PowerIcon />}
                </TooltipTrigger>
                <TooltipPopup>
                  {blocked ??
                    (configured.enabled
                      ? "Disable team"
                      : "Enable team. Nothing starts until you start an approved task.")}
                </TooltipPopup>
              </Tooltip>
            </>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={blocked !== null}
              title={blocked ?? undefined}
              onClick={() => open({ kind: "setup" })}
            >
              Set up team
            </Button>
          )
        ) : null
      }
    >
      <WorkRecordsNotice set={limits} subject="team limits" />
      <WorkRecordsNotice set={roles} subject="role profiles" />
      <WorkRecordsNotice set={members} subject="team members" />
      {editing && draft !== null ? (
        <TeamEditView
          draft={draft}
          scope={scope}
          providers={providerChoices}
          changed={changed}
          dirty={dirty}
          blocked={blocked}
          buildReason={buildReason}
          pending={writer.pendingKey === key}
          busy={writer.pendingKey !== null}
          failure={writer.failureFor(key)}
          onChange={update}
          onReview={reviewLatest}
          onSave={() => void save()}
          onCancel={() => setDraft(null)}
        />
      ) : recorded === null ? null : recorded.kind === "none" ? (
        <p className="m-0 rounded-xl border border-dashed border-border/70 px-4 py-3 text-sm text-muted-foreground">
          Meet Quinn, Iris, Sage, Otto, Vera and Wren. Set up a provider and models, then override
          any name or role instructions.
        </p>
      ) : recorded.kind === "unreadable" ? (
        <WorkFormStatus tone="muted" message={recorded.reason} />
      ) : (
        <div className="grid min-w-0 grid-cols-2 gap-2 @2xl/work:grid-cols-4">
          {LIMIT_FIELDS.map(([field, label]) => (
            <div
              key={field}
              className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border/60 bg-card/40 px-3 py-2"
            >
              <span className="text-lg leading-6 font-semibold tabular-nums">
                {recorded.values[field] ?? 0}
              </span>
              <span className="truncate text-xs text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      )}
      {configured && !editing && roster.length > 0 ? (
        <div className="flex min-w-0 items-baseline gap-2 px-1 pt-2">
          <h3 className="m-0 text-sm font-medium">Members</h3>
          <span className="text-xs tabular-nums text-muted-foreground">{roster.length}</span>
          <WorkMeta className="ms-auto tabular-nums">
            {roster.filter((member) => member.activity.state === "running").length} working
          </WorkMeta>
        </div>
      ) : null}
      {configured && !editing ? (
        <WorkTeamMembers
          scope={scope}
          onOpenTask={onOpenTask}
          {...(blocked === null && draft === null
            ? {
                onEditMember: (role: string) => {
                  const profile = configured.profiles.find((entry) => entry.role === role);
                  if (profile) open({ kind: "member", role: profile.role });
                },
              }
            : {})}
        />
      ) : null}
      {draft !== null && !editing ? (
        <WorkRow className="gap-4 rounded-xl border border-border/60 bg-card/40 py-4">
          {changed ? <WorkReviewChanged onReview={reviewLatest} /> : null}
          {draft.view.kind === "toggle" ? (
            <p className="text-sm">
              {draft.values.enabled ? "Enable" : "Disable"} the recorded team at generation{" "}
              <WorkRevision>{draft.generation}</WorkRevision>? Profiles and limits stay the same.
            </p>
          ) : (
            <TeamForm
              environmentId={scope.environmentId}
              values={draft.values}
              recorded={draft.recorded}
              providers={providerChoices}
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
                : draft.view.kind === "toggle"
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

function EditIconButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly reason: string | null;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        <PencilIcon />
      </TooltipTrigger>
      <TooltipPopup>{props.reason ?? props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** One member, or the team settings, edited in place of the Team tab's read view. */
function TeamEditView(props: {
  readonly draft: Draft;
  readonly scope: ProjectWorkScope;
  readonly providers: ReadonlyArray<ProviderChoice>;
  readonly changed: boolean;
  readonly dirty: boolean;
  readonly blocked: string | null;
  readonly buildReason: string | null;
  readonly pending: boolean;
  readonly busy: boolean;
  readonly failure: string | null;
  readonly onChange: (values: TeamConfigurationValues) => void;
  readonly onReview: () => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const { draft, view } = { draft: props.draft, view: props.draft.view };
  const index =
    view.kind === "member"
      ? draft.values.profiles.findIndex((profile) => profile.role === view.role)
      : -1;
  const profile = index < 0 ? null : draft.values.profiles[index]!;
  const title = profile ? profile.name?.trim() || workStateLabel(profile.role) : "Team settings";
  return (
    <div className="flex min-w-0 flex-col gap-4 rounded-xl border border-border/70 bg-card/40 p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Back to team"
                onClick={props.onCancel}
              />
            }
          >
            <ArrowLeftIcon />
          </TooltipTrigger>
          <TooltipPopup>Back to team, discarding changes</TooltipPopup>
        </Tooltip>
        {profile ? (
          <WorkMemberAvatar
            member={memberAvatarIdentity(
              profile.role,
              profile.name ?? profile.role,
              profile.avatar,
            )}
            large
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="m-0 truncate text-sm font-semibold">{title}</h3>
          <WorkMeta className="truncate">
            {profile
              ? workStateLabel(profile.role)
              : "Limits for each provider and model, and for the whole team."}
          </WorkMeta>
        </div>
        <Button
          size="sm"
          disabled={
            !props.dirty ||
            props.changed ||
            props.blocked !== null ||
            props.buildReason !== null ||
            props.busy
          }
          onClick={props.onSave}
        >
          {props.pending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
      {props.changed ? <WorkReviewChanged onReview={props.onReview} /> : null}
      {profile ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <MemberFields
            environmentId={props.scope.environmentId}
            values={draft.values}
            index={index}
            recorded={draft.recorded}
            onChange={props.onChange}
          />
        </div>
      ) : (
        <TeamSettingsFields
          values={draft.values}
          providers={props.providers}
          onChange={props.onChange}
        />
      )}
      <WorkFormStatus tone="muted" message={props.changed ? null : props.buildReason} />
      <WorkFormStatus message={props.failure} />
    </div>
  );
}

interface ProviderChoice {
  readonly id: string;
  readonly label: string;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
}

interface TeamFieldsProps {
  readonly values: TeamConfigurationValues;
  readonly providers: ReadonlyArray<ProviderChoice>;
  readonly onChange: (values: TeamConfigurationValues) => void;
}

/** Setting up a new team edits every member and the team settings at once. */
function TeamForm({
  environmentId,
  values,
  recorded,
  providers,
  onChange,
}: TeamFieldsProps & {
  readonly environmentId: EnvironmentId;
  readonly recorded: TeamConfigurationValues | null;
}) {
  const enabledId = useId();
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
        {values.profiles.map((profile, index) => (
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
            <MemberFields
              environmentId={environmentId}
              values={values}
              index={index}
              recorded={recorded}
              onChange={onChange}
            />
          </fieldset>
        ))}
      </div>
      <TeamSettingsFields values={values} providers={providers} onChange={onChange} />
    </div>
  );
}

/** One member's avatar, name, model route, memory, instructions and delegation depth. */
function MemberFields({
  environmentId,
  values,
  index,
  recorded,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly values: TeamConfigurationValues;
  readonly index: number;
  readonly recorded: TeamConfigurationValues | null;
  readonly onChange: (values: TeamConfigurationValues) => void;
}) {
  const profile = values.profiles[index]!;
  const set = (patch: Partial<typeof profile>) =>
    onChange({
      ...values,
      profiles: values.profiles.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)),
    });
  return (
    <>
      <p className="text-xs text-muted-foreground sm:col-span-2">
        {PROJECT_TEAM_PRESETS[profile.role].specialty}
      </p>
      <WorkAvatarEditor
        identity={memberAvatarIdentity(profile.role, profile.name ?? profile.role)}
        preset={PROJECT_TEAM_PRESETS[profile.role].avatar}
        name={profile.name?.trim() || workStateLabel(profile.role)}
        avatar={profile.avatar}
        others={values.profiles.flatMap((p, at) => (at !== index && p.avatar ? [p.avatar] : []))}
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
        {profile.name?.trim() && profile.name.trim() !== PROJECT_TEAM_PRESETS[profile.role].name ? (
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
      <div className="sm:col-span-2">
        <WorkField label="Model">
          {() => (
            <div>
              <ModelSelectionPicker
                environmentId={environmentId}
                selection={
                  profile.providerInstanceId && profile.model
                    ? {
                        instanceId: profile.providerInstanceId,
                        model: profile.model,
                        ...(profile.options === undefined ? {} : { options: profile.options }),
                      }
                    : null
                }
                disabled={false}
                onChange={(selection) =>
                  onChange({
                    ...values,
                    profiles: values.profiles.map((entry, at) => {
                      if (at !== index) return entry;
                      const { options: _options, ...rest } = entry;
                      // The picker owns the route: its options replace the member's.
                      return {
                        ...rest,
                        providerInstanceId: selection.instanceId,
                        model: selection.model,
                        ...(selection.options === undefined || selection.options.length === 0
                          ? {}
                          : { options: selection.options }),
                      };
                    }),
                  })
                }
              />
            </div>
          )}
        </WorkField>
      </div>
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
    </>
  );
}

/** Team-wide limits: per provider and model, and for the whole team. */
function TeamSettingsFields({ values, providers, onChange }: TeamFieldsProps) {
  const providerName = (id: string) =>
    providers.find((entry) => entry.id === id)?.label ?? `${id} (unavailable)`;
  const modelName = (id: string, model: string) =>
    providers.find((entry) => entry.id === id)?.models.find((entry) => entry.slug === model)
      ?.name ?? model;
  return (
    <div className="flex flex-col gap-4">
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
                  label={`${providerName(teamProviderOf(values, policy))} · ${modelName(teamProviderOf(values, policy), policy.model)}: tokens`}
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
