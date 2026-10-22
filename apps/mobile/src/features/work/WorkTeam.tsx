import {
  asProjectTeamRecord,
  projectWorkSelectionIsCurrent,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import { CommandId, type ProjectTeamRecordRead } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { NumberField } from "../../components/ui/NumberField";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useEnvironmentServerConfig } from "../../state/entities";
import { WorkBlock, WorkFormActions, WorkInput, WorkRecordsNotice, WorkText } from "./WorkParts";
import { newCommandId, type WorkWriter } from "./useWork";
import { useWorkRecords, workRecordsBlockedReason } from "./useWorkRecords";
import {
  buildTeamConfigurationIntent,
  emptyTeamConfiguration,
  MEMORY_ACCESS,
  recordedTeamConfiguration,
  syncModelPolicies,
  type TeamConfigurationValues,
} from "./workLogic";
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
  readonly toggle: boolean;
}

/** Human team setup. Saving records profiles and limits only; workers stay off. */
export function WorkTeamSection({
  scope,
  writer,
}: {
  scope: ProjectWorkScope;
  writer: WorkWriter;
}) {
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
    if (await writer.submit(key, draft.selected, current, prepared.intent)) setDraft(null);
  };
  const update = (values: TeamConfigurationValues) =>
    draft && setDraft({ ...draft, values: syncModelPolicies(values) });
  const configured = recorded?.kind === "configured" ? recorded.values : null;
  const providerName = (id: string) => {
    const entry = providers.find((item) => item.instanceId === id);
    return entry ? (entry.displayName ?? entry.instanceId) : `${id} (unavailable)`;
  };

  return (
    <>
      <WorkRecordsNotice set={limits} subject="team limits" />
      <WorkRecordsNotice set={roles} subject="role profiles" />
      <WorkRecordsNotice set={members} subject="team members" />
      <ListSection
        title="Team"
        footer="Enabling a team doesn't start anything. Managed workers stay off until execution is available."
      >
        <WorkBlock>
          {recorded === null ? (
            <WorkText muted>Loading team…</WorkText>
          ) : recorded.kind === "none" ? (
            <WorkText>No team is configured for this project.</WorkText>
          ) : recorded.kind === "unreadable" ? (
            <WorkText muted>{recorded.reason}</WorkText>
          ) : (
            <>
              <WorkText>
                {recorded.values.enabled ? "Enabled" : "Disabled"} ·{" "}
                {providerName(recorded.values.providerInstanceId)} · generation{" "}
                {recorded.generation}
              </WorkText>
              {recorded.values.profiles.map((profile) => (
                <WorkText key={profile.role} muted>
                  {workStateLabel(profile.role)}: {profile.model} ·{" "}
                  {MEMORY_LABELS[profile.memoryAccess]} memory
                </WorkText>
              ))}
            </>
          )}
        </WorkBlock>
        {draft === null && recorded !== null && recorded.kind !== "unreadable" ? (
          <>
            {configured ? (
              <ListActionRow
                label={configured.enabled ? "Disable team…" : "Enable team…"}
                {...(blocked ? { description: blocked } : {})}
                disabled={blocked !== null}
                onPress={() => open(true)}
              />
            ) : null}
            <ListActionRow
              icon="pencil"
              label={configured ? "Edit team" : "Set up team"}
              {...(blocked ? { description: blocked } : {})}
              disabled={blocked !== null}
              onPress={() => open(false)}
            />
          </>
        ) : null}
      </ListSection>
      {draft !== null ? (
        <>
          {draft.toggle ? (
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
              values={draft.values}
              providers={providers.map((entry) => ({
                id: entry.instanceId,
                label: entry.displayName ?? entry.instanceId,
                models: entry.models.map((model) => ({ slug: model.slug, name: model.name })),
              }))}
              onChange={update}
            />
          )}
          <WorkFormActions
            submitLabel={
              draft.toggle ? (draft.values.enabled ? "Enable team" : "Disable team") : "Save team"
            }
            pending={writer.pendingKey === key}
            disabled={blocked !== null || buildReason !== null}
            failure={writer.failureFor(key) ?? (changed ? null : buildReason)}
            changed={changed}
            onReview={() => setDraft(null)}
            onSubmit={() => void save()}
            onCancel={() => setDraft(null)}
          />
        </>
      ) : null}
    </>
  );
}

interface ProviderChoice {
  readonly id: string;
  readonly label: string;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
}

function TeamForm(props: {
  values: TeamConfigurationValues;
  providers: ReadonlyArray<ProviderChoice>;
  onChange: (values: TeamConfigurationValues) => void;
}) {
  const { values, onChange } = props;
  const provider = props.providers.find((entry) => entry.id === values.providerInstanceId);
  const [choosingModel, setChoosingModel] = useState<string | null>(null);
  return (
    <>
      <ListSection title="Team setup">
        <ListToggleRow
          label="Team enabled"
          value={values.enabled}
          onValueChange={(enabled) => onChange({ ...values, enabled })}
        />
      </ListSection>
      <ListSection
        title="Provider"
        {...(props.providers.length === 0
          ? { footer: "No providers are enabled on this environment." }
          : {})}
      >
        {props.providers.map((entry) => (
          <ListChoiceRow
            key={entry.id}
            label={entry.label}
            selected={entry.id === values.providerInstanceId}
            onPress={() =>
              onChange({
                ...values,
                providerInstanceId: entry.id as TeamConfigurationValues["providerInstanceId"],
                // Models belong to one provider; switching asks for each role's model again.
                profiles: values.profiles.map((profile) => ({ ...profile, model: "" })),
              })
            }
          />
        ))}
      </ListSection>
      {values.profiles.map((profile, index) => {
        const set = (patch: Partial<typeof profile>) =>
          onChange({
            ...values,
            profiles: values.profiles.map((entry, at) =>
              at === index ? { ...entry, ...patch } : entry,
            ),
          });
        const modelName =
          provider?.models.find((model) => model.slug === profile.model)?.name ?? profile.model;
        return (
          <ListSection key={profile.role} title={workStateLabel(profile.role)}>
            <ListActionRow
              label={`Model: ${modelName || "choose"}`}
              disabled={provider === undefined}
              onPress={() => setChoosingModel(choosingModel === profile.role ? null : profile.role)}
            />
            {choosingModel === profile.role
              ? (provider?.models ?? []).map((model) => (
                  <ListChoiceRow
                    key={model.slug}
                    label={model.name}
                    selected={model.slug === profile.model}
                    onPress={() => {
                      set({ model: model.slug });
                      setChoosingModel(null);
                    }}
                  />
                ))
              : null}
            <WorkBlock>
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
      {values.modelPolicies.length > 0 ? (
        <ListSection title="Limits per model">
          {values.modelPolicies.map((policy, index) => {
            const set = (patch: Partial<typeof policy>) =>
              onChange({
                ...values,
                modelPolicies: values.modelPolicies.map((entry, at) =>
                  at === index ? { ...entry, ...patch } : entry,
                ),
              });
            return (
              <WorkBlock key={policy.model}>
                <WorkText>{policy.model}</WorkText>
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
    </>
  );
}
