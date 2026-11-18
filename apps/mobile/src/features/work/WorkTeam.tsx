import {
  asProjectTeamRecord,
  projectWorkSelectionIsCurrent,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import {
  CommandId,
  PROJECT_TEAM_PRESETS,
  type ProjectTeamRecordRead,
  type ProjectWorkTaskId,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { NumberField } from "../../components/ui/NumberField";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useEnvironmentServerConfig } from "../../state/entities";
import {
  WorkBlock,
  WorkFormActions,
  WorkInput,
  WorkRecordsNotice,
  WorkTaskLink,
  WorkText,
} from "./WorkParts";
import { newCommandId, type WorkWriter } from "./useWork";
import { workRecordsBlockedReason } from "./useWorkRecords";
import { useWorkTeamRoster, type WorkRosterMember } from "./useWorkTeamRoster";
import {
  WorkHeading,
  WorkMemberAvatar,
  WorkStatRow,
  WorkStatTile,
  WorkStatusChip,
  WorkTagChip,
} from "./WorkStatus";
import {
  buildTeamConfigurationIntent,
  emptyTeamConfiguration,
  MEMORY_ACCESS,
  recordedTeamConfiguration,
  syncModelPolicies,
  teamEffortControl,
  teamEffortValue,
  teamProviderOf,
  workRouteLabel,
  type TeamConfigurationValues,
  type TeamProfile,
  withTeamEffort,
} from "@t3tools/client-runtime/project-work-logic";
import { WorkAvatarEditor } from "./WorkAvatarEditor";
import { useWorkProviderCatalog } from "./useWorkProviderCatalog";
import { workStateLabel } from "./workModel";

const VALIDATION_COMMAND_ID = CommandId.make("validation");
const MEMORY_LABELS = { none: "None", project: "Project", shared: "Shared" };
const LIMIT_FIELDS = [
  ["environmentModelCalls", "Environment model calls", 128],
  ["projectWritableWorkers", "Writable workers", 64],
  ["delegationDepth", "Delegation depth", 8],
  ["repairAllowance", "Repair allowance", 16],
] as const;

interface Draft {
  readonly values: TeamConfigurationValues;
  readonly selected: ProjectWorkSelection;
  readonly generation: number;
  /** The configured values the draft was opened from. */
  readonly recorded: TeamConfigurationValues | null;
  readonly view: DraftView;
}

/** A configured team is edited one member, or the team settings, at a time. */
type DraftView =
  | { readonly kind: "setup" }
  | { readonly kind: "member"; readonly role: TeamProfile["role"] }
  | { readonly kind: "settings" }
  | { readonly kind: "toggle" };

/** Human team setup. Saving records profiles and limits only; workers stay off. */
export function WorkTeamSection({
  scope,
  writer,
  onOpenTask,
}: {
  scope: ProjectWorkScope;
  writer: WorkWriter;
  onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { limits, roles, members, roster } = useWorkTeamRoster(scope);
  const serverConfig = useEnvironmentServerConfig(scope.environmentId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const key = "team:configure";

  const sets = [limits, roles, members];
  const revision = sets.every((set) => set.complete && set.revision === limits.revision)
    ? limits.revision
    : null;
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
  const providers = (serverConfig?.providers ?? []).filter((provider) => provider.enabled);
  const catalog = useWorkProviderCatalog(scope.environmentId);
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
  const built = build(VALIDATION_COMMAND_ID);
  const buildReason = built !== null && "reason" in built ? built.reason : null;

  const open = (view: DraftView) => {
    const toggle = view.kind === "toggle";
    if (recorded === null || revision === null) return;
    const empty = emptyTeamConfiguration();
    // A new team starts every member on the first enabled provider; each can change it.
    const first = providers[0];
    const values =
      recorded.kind === "configured"
        ? recorded.values
        : first === undefined
          ? empty
          : {
              ...empty,
              profiles: empty.profiles.map((profile) => ({
                ...profile,
                providerInstanceId: first.instanceId,
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
    if (await writer.submit(key, draft.selected, current, prepared.intent)) setDraft(null);
  };
  const update = (values: TeamConfigurationValues) =>
    draft && setDraft({ ...draft, values: syncModelPolicies(values) });
  const configured = recorded?.kind === "configured" ? recorded.values : null;
  const dirty =
    draft !== null &&
    (draft.recorded === null || JSON.stringify(draft.values) !== JSON.stringify(draft.recorded));
  /** Provider, model and effort, e.g. "Claude · Claude Opus 5.5 · High". */
  const memberRoute = (profile: NonNullable<WorkRosterMember["profile"]>) =>
    workRouteLabel(catalog, {
      // Roles from before members chose a provider ran on their model's team policy.
      providerInstanceId:
        profile.providerInstanceId ??
        records
          .flatMap((record) => (record.kind === "limits" && "model" in record ? [record] : []))
          .filter((record) => record.model === profile.model)
          // A disabled team keeps its policies disabled; the newest still names its provider.
          .sort((a, b) => b.generation - a.generation)[0]?.providerInstanceId,
      model: profile.model,
      options: profile.options,
    });
  const editing = draft !== null && draft.view.kind !== "toggle";
  const working = roster.filter((member) => member.activity.state === "running").length;
  const canAct = draft === null && recorded !== null && recorded.kind !== "unreadable";

  return (
    <View className="gap-3">
      <WorkHeading
        title="Team"
        trailing={
          configured && !editing ? (
            <WorkStatusChip
              state={configured.enabled ? "active" : "paused"}
              tone={configured.enabled ? "success" : "outline"}
              label={configured.enabled ? "Enabled" : "Disabled"}
              icon={null}
            />
          ) : undefined
        }
      />
      <WorkRecordsNotice set={limits} subject="team limits" />
      <WorkRecordsNotice set={roles} subject="role profiles" />
      <WorkRecordsNotice set={members} subject="team members" />
      {recorded === null ? null : recorded.kind === "none" && !editing ? (
        <View className="rounded-2xl border border-dashed border-border px-4 py-3">
          <WorkText muted>
            Meet Quinn, Iris, Sage, Otto, Vera and Wren. Set up a provider and models, then override
            any name or role instructions.
          </WorkText>
        </View>
      ) : recorded.kind === "unreadable" ? (
        <WorkText muted>{recorded.reason}</WorkText>
      ) : recorded.kind === "configured" && !editing ? (
        <View className="gap-2">
          <WorkStatRow>
            {LIMIT_FIELDS.slice(0, 2).map(([field, label]) => (
              <WorkStatTile key={field} value={recorded.values[field] ?? 0} label={label} />
            ))}
          </WorkStatRow>
          <WorkStatRow>
            {LIMIT_FIELDS.slice(2).map(([field, label]) => (
              <WorkStatTile key={field} value={recorded.values[field] ?? 0} label={label} />
            ))}
          </WorkStatRow>
        </View>
      ) : null}
      {canAct ? (
        <ListSection footer="Enabling a team doesn't start anything. Workers start only from approved tasks.">
          {configured ? (
            <>
              <ListActionRow
                icon="slider.horizontal.3"
                label="Edit team settings"
                {...(blocked ? { description: blocked } : {})}
                disabled={blocked !== null}
                onPress={() => open({ kind: "settings" })}
              />
              <ListActionRow
                icon={configured.enabled ? "pause" : "play"}
                label={configured.enabled ? "Disable team…" : "Enable team…"}
                {...(blocked ? { description: blocked } : {})}
                disabled={blocked !== null}
                onPress={() => open({ kind: "toggle" })}
              />
            </>
          ) : (
            <ListActionRow
              icon="person.badge.plus"
              label="Set up team"
              {...(blocked ? { description: blocked } : {})}
              disabled={blocked !== null}
              onPress={() => open({ kind: "setup" })}
            />
          )}
        </ListSection>
      ) : null}
      {configured && !editing && roster.length > 0 ? (
        <WorkHeading
          title="Members"
          count={roster.length}
          trailing={
            <Text textRole="label" className="text-foreground-muted">
              {working} working
            </Text>
          }
        />
      ) : null}
      {configured && !editing
        ? roster.map((member) => (
            <MemberCard
              key={member.recordId}
              member={member}
              scope={scope}
              route={member.profile ? memberRoute(member.profile) : "Unavailable"}
              onOpenTask={onOpenTask}
              {...(blocked === null && draft === null
                ? {
                    onEdit: () => {
                      const profile = configured.profiles.find(
                        (entry) => entry.role === member.role,
                      );
                      if (profile) open({ kind: "member", role: profile.role });
                    },
                  }
                : {})}
            />
          ))
        : null}
      {draft !== null ? (
        <>
          {draft.view.kind === "toggle" ? (
            <ListSection title={draft.values.enabled ? "Enable team" : "Disable team"}>
              <WorkBlock>
                <WorkText>
                  {draft.values.enabled ? "Enable" : "Disable"} the recorded team at generation{" "}
                  {draft.generation}? Profiles and limits stay the same.
                </WorkText>
              </WorkBlock>
            </ListSection>
          ) : (
            <TeamForm
              view={draft.view}
              values={draft.values}
              recorded={draft.recorded}
              providers={providers.map((entry) => ({
                id: entry.instanceId,
                label: entry.displayName ?? entry.instanceId,
                models: entry.models.map((model) => ({
                  slug: model.slug,
                  name: model.name,
                  descriptors: model.capabilities?.optionDescriptors,
                })),
              }))}
              onChange={update}
            />
          )}
          <WorkFormActions
            submitLabel={
              draft.view.kind === "toggle"
                ? draft.values.enabled
                  ? "Enable team"
                  : "Disable team"
                : "Save"
            }
            pending={writer.pendingKey === key}
            disabled={blocked !== null || buildReason !== null || !dirty}
            failure={writer.failureFor(key) ?? (changed ? null : buildReason)}
            changed={changed}
            onReview={() => setDraft(null)}
            onSubmit={() => void save()}
            onCancel={() => setDraft(null)}
          />
        </>
      ) : null}
    </View>
  );
}

const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** One member: who, what they do, how they run, and the task they hold. */
function MemberCard(props: {
  readonly member: WorkRosterMember;
  readonly scope: ProjectWorkScope;
  readonly route: string;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
  readonly onEdit?: () => void;
}) {
  const { member } = props;
  const profile = member.profile;
  const specialty =
    PROJECT_TEAM_PRESETS[member.role as keyof typeof PROJECT_TEAM_PRESETS]?.specialty;
  const facts = [
    ["Model", props.route],
    [
      "Memory",
      profile
        ? `${MEMORY_LABELS[profile.memoryAccess as keyof typeof MEMORY_LABELS] ?? workStateLabel(profile.memoryAccess)}`
        : "Unknown",
    ],
    ...(profile
      ? [
          [
            "Access",
            [
              countLabel(profile.tools.length, "tool"),
              countLabel(profile.skills.length, "skill"),
              `depth ${profile.delegationDepth}`,
            ].join(" · "),
          ] as const,
        ]
      : []),
  ] as const;
  return (
    <ListSection>
      <View className="gap-3 px-4 pt-4 pb-3">
        <View className="flex-row items-start gap-3">
          <WorkMemberAvatar
            role={member.role}
            name={member.name}
            avatar={member.avatar}
            size={44}
          />
          <View className="min-w-0 flex-1 gap-0.5">
            <View className="flex-row items-center gap-2">
              <Text
                textRole="body"
                numberOfLines={1}
                className="shrink font-t3-bold text-foreground"
              >
                {member.name}
              </Text>
              {member.coordinator ? <WorkTagChip label="Leads" /> : null}
            </View>
            <Text textRole="footnote" numberOfLines={1} className="text-foreground-muted">
              {workStateLabel(member.role)}
            </Text>
          </View>
          <WorkStatusChip
            state={member.activity.state}
            label={member.activity.label}
            tone={member.activity.tone}
          />
        </View>
        {specialty ? (
          <Text textRole="footnote" numberOfLines={2} className="text-foreground-muted">
            {specialty}
          </Text>
        ) : null}
        <View className="gap-1 border-t border-separator pt-3">
          {facts.map(([label, value]) => (
            <View key={label} className="flex-row gap-3">
              <Text textRole="label" className="w-16 text-foreground-tertiary">
                {label}
              </Text>
              <Text textRole="label" numberOfLines={1} className="min-w-0 flex-1 text-foreground">
                {value}
              </Text>
            </View>
          ))}
        </View>
      </View>
      {member.taskId ? (
        <WorkTaskLink
          scope={props.scope}
          taskId={member.taskId as ProjectWorkTaskId}
          onOpen={props.onOpenTask}
        />
      ) : (
        <View className="border-t border-separator px-4 py-3">
          <Text textRole="footnote" className="text-foreground-tertiary">
            No task
          </Text>
        </View>
      )}
      {props.onEdit ? (
        <ListActionRow icon="pencil" label={`Edit ${member.name}`} onPress={props.onEdit} />
      ) : null}
    </ListSection>
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

// Options belong to one model, so they are dropped whenever a member's route changes.
const withoutOptions = ({ options: _options, ...profile }: TeamProfile): TeamProfile => profile;

function TeamForm(props: {
  view: Exclude<DraftView, { kind: "toggle" }>;
  values: TeamConfigurationValues;
  recorded: TeamConfigurationValues | null;
  providers: ReadonlyArray<ProviderChoice>;
  onChange: (values: TeamConfigurationValues) => void;
}) {
  const { values, recorded, onChange } = props;
  const [choosing, setChoosing] = useState<{
    readonly role: string;
    readonly field: "provider" | "model" | "effort";
  } | null>(null);
  const toggle = (role: string, field: "provider" | "model" | "effort") =>
    setChoosing(choosing?.role === role && choosing.field === field ? null : { role, field });
  const { view } = props;
  return (
    <>
      {view.kind !== "setup" ? null : (
        <ListSection title="Team setup">
          <ListToggleRow
            label="Team enabled"
            value={values.enabled}
            onValueChange={(enabled) => onChange({ ...values, enabled })}
          />
        </ListSection>
      )}
      {props.providers.length === 0 && view.kind !== "settings" ? (
        <ListSection title="Providers">
          <WorkBlock>
            <WorkText muted>No providers are enabled on this environment.</WorkText>
          </WorkBlock>
        </ListSection>
      ) : null}
      {values.profiles.map((profile, index) => {
        if (view.kind === "settings" || (view.kind === "member" && profile.role !== view.role))
          return null;
        const set = (patch: Partial<typeof profile>) =>
          onChange({
            ...values,
            profiles: values.profiles.map((entry, at) =>
              at === index ? { ...entry, ...patch } : entry,
            ),
          });
        const update = (next: (entry: TeamProfile) => TeamProfile) =>
          onChange({
            ...values,
            profiles: values.profiles.map((entry, at) => (at === index ? next(entry) : entry)),
          });
        const providerId = teamProviderOf(values, profile);
        const provider = props.providers.find((entry) => entry.id === providerId);
        const model = provider?.models.find((entry) => entry.slug === profile.model);
        const effort = teamEffortControl(model?.descriptors);
        const effortValue = effort ? teamEffortValue(profile.options, effort.descriptor.id) : null;
        const isOpen = (field: "provider" | "model" | "effort") =>
          choosing?.role === profile.role && choosing.field === field;
        return (
          <ListSection key={profile.role} title={workStateLabel(profile.role)}>
            <ListActionRow
              label={`Provider: ${provider?.label ?? (providerId || "choose")}`}
              onPress={() => toggle(profile.role, "provider")}
            />
            {isOpen("provider")
              ? props.providers.map((entry) => (
                  <ListChoiceRow
                    key={entry.id}
                    label={entry.label}
                    selected={entry.id === providerId}
                    onPress={() => {
                      if (entry.id !== providerId)
                        // Models belong to one provider; switching asks for this member's model again.
                        update((current) => ({
                          ...withoutOptions(current),
                          providerInstanceId: entry.id as NonNullable<
                            TeamProfile["providerInstanceId"]
                          >,
                          model: "",
                        }));
                      setChoosing(null);
                    }}
                  />
                ))
              : null}
            <ListActionRow
              label={`Model: ${model?.name ?? (profile.model || "choose")}`}
              disabled={provider === undefined}
              onPress={() => toggle(profile.role, "model")}
            />
            {isOpen("model")
              ? (provider?.models ?? []).map((entry) => (
                  <ListChoiceRow
                    key={entry.slug}
                    label={entry.name}
                    selected={entry.slug === profile.model}
                    onPress={() => {
                      if (entry.slug !== profile.model)
                        update((current) => ({ ...withoutOptions(current), model: entry.slug }));
                      setChoosing(null);
                    }}
                  />
                ))
              : null}
            {effort ? (
              <>
                <ListActionRow
                  label={`${effort.descriptor.label}: ${
                    effort.choices.find((choice) => choice.id === effortValue)?.label ??
                    "Model default"
                  }`}
                  onPress={() => toggle(profile.role, "effort")}
                />
                {isOpen("effort")
                  ? [{ id: null, label: "Model default" }, ...effort.choices].map((choice) => (
                      <ListChoiceRow
                        key={choice.id ?? "default"}
                        label={choice.label}
                        selected={choice.id === effortValue}
                        onPress={() => {
                          update((current) => {
                            const options = withTeamEffort(
                              current.options,
                              effort.descriptor.id,
                              choice.id,
                            );
                            return options === undefined
                              ? withoutOptions(current)
                              : { ...withoutOptions(current), options };
                          });
                          setChoosing(null);
                        }}
                      />
                    ))
                  : null}
              </>
            ) : null}
            <WorkAvatarEditor
              role={profile.role}
              name={profile.name?.trim() || workStateLabel(profile.role)}
              avatar={profile.avatar}
              recorded={recorded?.profiles.find((p) => p.role === profile.role)?.avatar}
              others={values.profiles.flatMap((p, at) =>
                at !== index && p.avatar ? [p.avatar] : [],
              )}
              onChange={(avatar) => set({ avatar })}
            />
            <WorkBlock>
              <WorkInput
                label="Display name"
                value={profile.name ?? ""}
                onChange={(name) => set({ name })}
                maxLength={40}
              />
              <SegmentedControl
                size="compact"
                options={MEMORY_ACCESS.map((access) => ({
                  value: access,
                  label: `${MEMORY_LABELS[access]} memory`,
                }))}
                selected={profile.memoryAccess}
                onSelect={(memoryAccess) => set({ memoryAccess })}
              />
              <WorkInput
                label="Instructions"
                value={profile.instructions}
                onChange={(instructions) => set({ instructions })}
                multiline
                maxLength={32000}
              />
              <NumberField
                label="Delegation depth"
                min={0}
                max={8}
                value={profile.delegationDepth}
                onValueChange={(delegationDepth) => set({ delegationDepth })}
              />
            </WorkBlock>
          </ListSection>
        );
      })}
      {view.kind !== "member" && values.modelPolicies.length > 0 ? (
        <ListSection title="Limits per provider and model">
          {values.modelPolicies.map((policy, index) => {
            const set = (patch: Partial<typeof policy>) =>
              onChange({
                ...values,
                modelPolicies: values.modelPolicies.map((entry, at) =>
                  at === index ? { ...entry, ...patch } : entry,
                ),
              });
            return (
              <WorkBlock key={`${teamProviderOf(values, policy)}:${policy.model}`}>
                <WorkText>
                  {props.providers.find((entry) => entry.id === teamProviderOf(values, policy))
                    ?.label ?? teamProviderOf(values, policy)}{" "}
                  ·{" "}
                  {props.providers
                    .find((entry) => entry.id === teamProviderOf(values, policy))
                    ?.models.find((entry) => entry.slug === policy.model)?.name ?? policy.model}
                </WorkText>
                <View className="flex-row gap-2">
                  <View className="flex-1">
                    <WorkInput
                      label="Tokens"
                      numeric
                      value={String(policy.tokenLimit)}
                      onChange={(text) => set({ tokenLimit: Number.parseInt(text, 10) || 0 })}
                    />
                  </View>
                  <View className="flex-1">
                    <WorkInput
                      label="Minutes"
                      numeric
                      value={String(Math.round(policy.durationLimitMs / 60_000))}
                      onChange={(text) =>
                        set({ durationLimitMs: (Number.parseInt(text, 10) || 0) * 60_000 })
                      }
                    />
                  </View>
                </View>
                <NumberField
                  label="Model calls"
                  min={1}
                  max={128}
                  value={policy.modelCalls}
                  onValueChange={(modelCalls) => set({ modelCalls })}
                />
              </WorkBlock>
            );
          })}
        </ListSection>
      ) : null}
      {view.kind === "member" ? null : (
        <ListSection title="Limits">
          <WorkBlock>
            {LIMIT_FIELDS.map(([field, label, max]) => (
              <NumberField
                key={field}
                label={label}
                min={0}
                max={max}
                value={values[field] ?? 0}
                onValueChange={(value) => onChange({ ...values, [field]: value })}
              />
            ))}
            {values.taskPriorities.length > 0 ? (
              <WorkText muted>
                {values.taskPriorities.length} recorded task priorities are kept.
              </WorkText>
            ) : null}
          </WorkBlock>
        </ListSection>
      )}
    </>
  );
}
