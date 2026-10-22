import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { composeManagedResourceInventory } from "@t3tools/client-runtime/state/managedResources";
import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  ManagedSkillId,
  ProjectId,
  ThreadId,
  type ManagedTextResourceCatalogRevision,
  type ManagedTextResourceKind,
  type ManagedTextResourceSummary,
  type ProviderInstanceId,
  type SkillCatalogListResult,
  type SkillCatalogRevision,
  type SkillContentDetail,
  type SkillDeploymentTargetSummary,
  type SkillManagedCatalogSummary,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useContext, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useProject, useProjects, useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import {
  managedTextEnvironment,
  mcpCatalogEnvironment,
  skillsEnvironment,
  useResourceCatalogSubscriptions,
} from "../../state/resources";
import { WorkBlock, WorkFormActions, WorkInput, WorkText } from "../work/WorkParts";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  buildSkillSave,
  buildTextSave,
  describeResourceFailure,
  effectiveMcpCatalogDefinitions,
  resourceEditorConflict,
  skillDeploymentActions,
  managedTextResourceScopeLabel,
  skillActions,
  skillEntryId,
  skillKeyCollisions,
  skillMutationForAction,
  textMutationForAction,
  textResourceActions,
  isTextReloadCurrent,
  orphanedThreadTextOverlays,
  resourceEditorDestinationKey,
  threadTextOverlayReset,
  skillReloadBaseline,
  textReloadEntry,
  type MobileResourceTarget,
  type ResourceEditorDestination,
  type SkillMutation,
  type TextMutation,
} from "./managedResourceActions";

function useScrollInsets() {
  const insets = useSafeAreaInsets();
  return { paddingBottom: Math.max(insets.bottom, 18) + 18 };
}

function useOpenSettingsScreen() {
  const navigation = useNavigation();
  return (screen: string, params: Record<string, string>) =>
    // Settings screens share one nested stack; this mirrors the Work links.
    (navigation.navigate as (name: string, params: object) => void)("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen, params },
    });
}

const targetParams = (target: MobileResourceTarget): Record<string, string> => ({
  environmentId: target.environmentId,
  ...(target.projectId === null ? {} : { projectId: target.projectId }),
});

/** Environment-wide resources first, then each project checkout on that environment. */
export function SettingsResourcesRouteScreen() {
  const style = useScrollInsets();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const open = useOpenSettingsScreen();
  return (
    <SettingsScreen title="Skills and commands">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={style}
      >
        {environments.length === 0 ? (
          <EmptyState
            variant="plain"
            title="No environments"
            detail="Connect an environment to manage its skills, commands and snippets."
          />
        ) : null}
        {environments.map((environment) => (
          <ListSection key={environment.environmentId} title={environment.label}>
            <ListRow
              icon="server.rack"
              label="Environment-wide"
              description="Available in every project on this environment"
              onPress={() =>
                open("SettingsResourceScope", { environmentId: environment.environmentId })
              }
            />
            {projects
              .filter((project) => project.environmentId === environment.environmentId)
              .map((project) => (
                <ListRow
                  key={project.id}
                  icon="folder"
                  label={project.title}
                  description={project.workspaceRoot}
                  onPress={() =>
                    open("SettingsResourceScope", {
                      environmentId: project.environmentId,
                      projectId: project.id,
                    })
                  }
                />
              ))}
          </ListSection>
        ))}
      </ScrollView>
    </SettingsScreen>
  );
}

type ScopeProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId?: string;
}>;

function useTarget(params: { readonly environmentId: string; readonly projectId?: string }) {
  const target: MobileResourceTarget = {
    environmentId: EnvironmentId.make(params.environmentId),
    projectId: params.projectId ? ProjectId.make(params.projectId) : null,
  };
  const project = useProject(
    target.projectId === null ? null : scopeProjectRef(target.environmentId, target.projectId),
  );
  return { target, project };
}

type Section = "skills" | "commands" | "overview";

export function SettingsResourceScopeRouteScreen({ route }: ScopeProps) {
  const { target, project } = useTarget(route.params);
  const style = useScrollInsets();
  const [section, setSection] = useState<Section>("skills");
  useResourceCatalogSubscriptions({
    environmentId: target.environmentId,
    ...(target.projectId === null ? {} : { projectId: target.projectId }),
  });
  return (
    <SettingsScreen title={project?.title ?? "Environment-wide"}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={style}
      >
        {target.projectId !== null && project === null ? (
          <WorkText muted>
            This project isn't on the selected environment, or it was removed.
          </WorkText>
        ) : (
          <>
            <SegmentedControl
              options={[
                { value: "skills", label: "Skills" },
                { value: "commands", label: "Commands" },
                { value: "overview", label: "Overview" },
              ]}
              selected={section}
              onSelect={setSection}
            />
            {section === "skills" ? (
              <SkillsSection target={target} />
            ) : section === "commands" ? (
              <TextResourcesSection target={target} />
            ) : (
              <InventorySection target={target} />
            )}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function useMutationRunner() {
  const registry = useContext(RegistryContext);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const settle = async (key: string, run: Promise<AtomCommandResult<unknown, unknown>>) => {
    setPending(key);
    setFailure(null);
    const result = await run;
    setPending(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setFailure(describeResourceFailure(squashAtomCommandFailure(result)));
    return result._tag === "Success";
  };
  const runSkill = (key: string, environmentId: EnvironmentId, mutation: SkillMutation) => {
    switch (mutation.command) {
      case "globalDelete":
        return settle(
          key,
          skillsEnvironment.globalDelete.run(registry, { environmentId, input: mutation.input }),
        );
      case "projectSetDisabled":
        return settle(
          key,
          skillsEnvironment.projectSetDisabled.run(registry, {
            environmentId,
            input: mutation.input,
          }),
        );
      case "projectDeleteState":
        return settle(
          key,
          skillsEnvironment.projectDeleteState.run(registry, {
            environmentId,
            input: mutation.input,
          }),
        );
      case "globalCreate":
        return settle(
          key,
          skillsEnvironment.globalCreate.run(registry, { environmentId, input: mutation.input }),
        );
      case "globalUpdate":
        return settle(
          key,
          skillsEnvironment.globalUpdate.run(registry, { environmentId, input: mutation.input }),
        );
      case "projectSetOverride":
        return settle(
          key,
          skillsEnvironment.projectSetOverride.run(registry, {
            environmentId,
            input: mutation.input,
          }),
        );
      case "sessionSetEnabled":
        return settle(
          key,
          skillsEnvironment.sessionSetEnabled.run(registry, {
            environmentId,
            input: mutation.input,
          }),
        );
      case "sessionReset":
        return settle(
          key,
          skillsEnvironment.sessionReset.run(registry, { environmentId, input: mutation.input }),
        );
    }
  };
  const runText = (key: string, environmentId: EnvironmentId, mutation: TextMutation) => {
    const target = { environmentId };
    switch (mutation.command) {
      case "environmentCreate":
        return settle(
          key,
          managedTextEnvironment.environmentCreate.run(registry, {
            ...target,
            input: mutation.input,
          }),
        );
      case "environmentUpdate":
        return settle(
          key,
          managedTextEnvironment.environmentUpdate.run(registry, {
            ...target,
            input: mutation.input,
          }),
        );
      case "environmentDelete":
        return settle(
          key,
          managedTextEnvironment.environmentDelete.run(registry, {
            ...target,
            input: mutation.input,
          }),
        );
      case "environmentSetEnabled":
        return settle(
          key,
          managedTextEnvironment.environmentSetEnabled.run(registry, {
            ...target,
            input: mutation.input,
          }),
        );
      case "projectSetOverride":
        return settle(
          key,
          managedTextEnvironment.projectSetOverride.run(registry, {
            ...target,
            input: mutation.input,
          }),
        );
      case "projectSetDisabled":
        return settle(
          key,
          managedTextEnvironment.projectSetDisabled.run(registry, {
            ...target,
            input: mutation.input,
          }),
        );
      case "projectDeleteState":
        return settle(
          key,
          managedTextEnvironment.projectDeleteState.run(registry, {
            ...target,
            input: mutation.input,
          }),
        );
      case "threadSetEnabled":
        return settle(
          key,
          managedTextEnvironment.threadSetEnabled.run(registry, {
            ...target,
            input: mutation.input,
          }),
        );
      case "threadReset":
        return settle(
          key,
          managedTextEnvironment.threadReset.run(registry, { ...target, input: mutation.input }),
        );
    }
  };
  const runDeployment = (key: string, environmentId: EnvironmentId, input: DeploymentInput) =>
    settle(key, skillsEnvironment.deploymentChange.run(registry, { environmentId, input }));
  return {
    pending,
    failure,
    runSkill,
    runText,
    runDeployment,
    clear: () => setFailure(null),
  };
}

type DeploymentInput = Parameters<typeof skillsEnvironment.deploymentChange.run>[1]["input"];

const SKILL_ACTION_TITLES: Partial<Record<ReturnType<typeof skillActions>[number], string>> = {
  edit: "Edit",
  "edit-override": "Edit project override",
  override: "Override for this project",
  install: "Install to provider…",
  "disable-project": "Turn off for this project",
  "reset-project": "Use environment version",
  "session-enable": "Turn on for this thread",
  "session-disable": "Turn off for this thread",
  "session-reset": "Follow project and environment",
  delete: "Delete",
};
const DESTRUCTIVE_SKILL_ACTIONS = new Set(["delete", "disable-project", "session-disable"]);

function RowMenu(props: {
  readonly label: string;
  readonly actions: ReadonlyArray<{ id: string; title: string; destructive?: boolean }>;
  readonly onSelect: (id: string) => void;
}) {
  if (props.actions.length === 0) return null;
  const actions: MenuAction[] = props.actions.map((action) => ({
    id: action.id,
    title: action.title,
    ...(action.destructive ? { attributes: { destructive: true } } : {}),
  }));
  return (
    <Menu actions={actions} onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Actions for ${props.label}`}
        hitSlop={8}
        className="px-1 py-1 active:opacity-60"
      >
        <SymbolView
          name="ellipsis.circle"
          size={20}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      </Pressable>
    </Menu>
  );
}

/** A failed read says what failed and offers a retry instead of loading forever. */
function QueryFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View className="gap-2">
      <Notice tone="danger" icon="exclamationmark.triangle" message={message} />
      <View className="flex-row">
        <Button label="Retry" tone="secondary" onPress={onRetry} />
      </View>
    </View>
  );
}

const catalogInputFor = (target: MobileResourceTarget) => ({
  ...(target.projectId === null ? {} : { projectId: target.projectId }),
  ...(target.thread === undefined ? {} : { threadId: target.thread.threadId }),
});

function SkillsSection({ target }: { target: MobileResourceTarget }) {
  const thread = target.thread;
  const catalog = useEnvironmentQuery(
    skillsEnvironment.catalog({
      environmentId: target.environmentId,
      input: {
        ...catalogInputFor(target),
        ...(thread?.providerInstanceId ? { providerInstanceId: thread.providerInstanceId } : {}),
      },
    }),
  );
  const canWrite = useAtomValue(
    (thread !== undefined
      ? skillsEnvironment.sessionSetEnabled
      : target.projectId === null
        ? skillsEnvironment.globalUpdate
        : skillsEnvironment.projectSetOverride
    ).permissionAtom(target.environmentId),
  );
  const runner = useMutationRunner();
  const open = useOpenSettingsScreen();
  const data = catalog.data;
  const collisions = skillKeyCollisions(data?.entries ?? []);
  const context = { projectId: target.projectId, threadId: thread?.threadId ?? null };
  const managed = (data?.entries ?? []).filter(
    (entry): entry is SkillManagedCatalogSummary => entry.origin === "managed",
  );
  const native = (data?.entries ?? []).filter((entry) => entry.origin === "native");
  const act = (entry: SkillManagedCatalogSummary, action: string) => {
    if (data === null) return;
    if (action === "edit" || action === "edit-override" || action === "override") {
      open("SettingsSkillEditor", {
        ...targetParams(target),
        skillId: entry.id,
        mode: action === "override" ? "override" : "edit",
      });
      return;
    }
    if (action === "install") {
      open("SettingsSkillInstall", { ...targetParams(target), skillId: entry.id });
      return;
    }
    const mutation = skillMutationForAction(
      action as ReturnType<typeof skillActions>[number],
      entry,
      target,
      data.catalogRevision,
    );
    if (mutation)
      void runner
        .runSkill(skillEntryId(entry), target.environmentId, mutation)
        .then(catalog.refresh);
  };
  return (
    <View className="gap-5">
      {catalog.error !== null ? (
        <QueryFailure message={catalog.error} onRetry={catalog.refresh} />
      ) : null}
      {runner.failure !== null ? (
        <Notice tone="danger" message={runner.failure} onDismiss={runner.clear} />
      ) : null}
      {thread !== undefined && thread.providerInstanceId === null ? (
        <WorkText muted>This thread has no provider yet, so its skills can't change.</WorkText>
      ) : null}
      <ListSection
        title="Managed skills"
        trailing={
          canWrite && data !== null && thread === undefined ? (
            <Button
              label="New"
              tone="text"
              icon="plus"
              onPress={() =>
                open("SettingsSkillEditor", { ...targetParams(target), mode: "create" })
              }
            />
          ) : undefined
        }
      >
        {data === null && catalog.error === null ? (
          <WorkBlock>
            <WorkText muted>Loading skills…</WorkText>
          </WorkBlock>
        ) : null}
        {data !== null && managed.length === 0 ? (
          <WorkBlock>
            <WorkText muted>
              No managed skills yet. Skills you add are delivered to supported providers.
            </WorkText>
          </WorkBlock>
        ) : null}
        {managed.map((entry) => {
          const actions =
            canWrite && data !== null
              ? skillActions(entry, context, data.entries).flatMap((action) => {
                  const title = SKILL_ACTION_TITLES[action];
                  return title
                    ? [{ id: action, title, destructive: DESTRUCTIVE_SKILL_ACTIONS.has(action) }]
                    : [];
                })
              : [];
          const notes = [
            entry.scope === "project" ? "Project" : "Environment",
            entry.effective ? null : "Off",
            entry.validity === "invalid" ? "Invalid" : null,
            entry.conflict?.kind === "shadowed" ? "Replaced by another skill with this key" : null,
            collisions.has(entry.key) ? "Same name as a provider skill" : null,
            runner.pending === skillEntryId(entry) ? "Saving…" : null,
          ].filter((note): note is string => note !== null);
          return (
            <ListRowLayout
              key={skillEntryId(entry)}
              icon="sparkles"
              label={`${entry.name}  $${entry.key}`}
              description={notes.join(" · ")}
              accessory={
                <RowMenu
                  label={entry.name}
                  actions={actions}
                  onSelect={(action) => act(entry, action)}
                />
              }
            />
          );
        })}
      </ListSection>
      {thread !== undefined && canWrite && data !== null && thread.providerInstanceId !== null ? (
        <Button
          label="Reset all thread skill changes"
          tone="secondary"
          onPress={() => {
            const providerInstanceId = thread.providerInstanceId;
            if (providerInstanceId === null) return;
            void runner
              .runSkill("session-reset", target.environmentId, {
                command: "sessionReset",
                input: {
                  threadId: thread.threadId,
                  providerInstanceId,
                  expectedRevision: data.catalogRevision,
                },
              })
              .then(catalog.refresh);
          }}
        />
      ) : null}
      {native.length > 0 ? (
        <ListSection
          title="Provider skills"
          footer="Discovered by each provider. Import or edit them from T3 Code on web or desktop."
        >
          {native.map((entry) => (
            <ListRowLayout
              key={skillEntryId(entry)}
              icon="cube"
              label={`${entry.name}  $${entry.key}`}
              description={[
                entry.origin === "native" ? entry.providerInstanceId : null,
                collisions.has(entry.key) ? "Same name as a managed skill" : null,
              ]
                .filter((note): note is string => note !== null)
                .join(" · ")}
            />
          ))}
        </ListSection>
      ) : null}
      {thread === undefined && data !== null ? (
        <InstalledCopiesSection target={target} catalog={data} />
      ) : null}
    </View>
  );
}

/**
 * Copies T3 Code wrote into provider skill folders, by folder, so a copy whose
 * skill was renamed or deleted can still be removed. Edited copies are left alone.
 */
function InstalledCopiesSection({
  target,
  catalog,
}: {
  target: MobileResourceTarget;
  catalog: SkillCatalogListResult;
}) {
  const providers = catalog.installProviderInstances ?? [];
  const [selected, setSelected] = useState<ProviderInstanceId | null>(null);
  const providerInstanceId = selected ?? providers[0] ?? null;
  const input =
    providerInstanceId === null
      ? null
      : {
          providerInstanceId,
          ...(target.projectId === null ? {} : { projectId: target.projectId }),
        };
  const deployments = useEnvironmentQuery(
    input === null
      ? null
      : skillsEnvironment.deployment({ environmentId: target.environmentId, input }),
  );
  const canChange = useAtomValue(
    skillsEnvironment.deploymentChange.permissionAtom(target.environmentId),
  );
  const runner = useMutationRunner();
  if (providerInstanceId === null || input === null) return null;
  const managedKeys = new Set(
    catalog.entries.flatMap((entry) => (entry.origin === "managed" ? [entry.key] : [])),
  );
  const copies = (deployments.data?.targets ?? []).filter((item) => item.status !== "absent");
  return (
    <ListSection
      title="Installed copies"
      footer="Skill folders T3 Code wrote for providers that read skills from disk."
    >
      {providers.length > 1 ? (
        <WorkBlock>
          <SegmentedControl
            options={providers.map((id) => ({ value: id, label: id }))}
            selected={providerInstanceId}
            onSelect={setSelected}
          />
        </WorkBlock>
      ) : null}
      {deployments.error !== null ? (
        <WorkBlock>
          <QueryFailure message={deployments.error} onRetry={deployments.refresh} />
        </WorkBlock>
      ) : null}
      {runner.failure !== null ? (
        <WorkBlock>
          <Notice tone="danger" message={runner.failure} onDismiss={runner.clear} />
        </WorkBlock>
      ) : null}
      {deployments.data !== null && copies.length === 0 ? (
        <WorkBlock>
          <WorkText muted>No installed copies for this provider.</WorkText>
        </WorkBlock>
      ) : null}
      {copies.map((item) => {
        const key = `${item.id}:${item.key ?? ""}`;
        const orphaned = item.key !== undefined && !managedKeys.has(item.key);
        const actions = canChange ? skillDeploymentActions(item, null) : [];
        return (
          <ListRowLayout
            key={`${item.id}:${item.path}`}
            icon="folder"
            label={item.key === undefined ? item.path : `$${item.key}`}
            description={[
              item.path,
              DEPLOYMENT_LABELS[item.status],
              orphaned ? "Its managed skill was renamed or deleted" : null,
              runner.pending === key ? "Removing…" : null,
            ]
              .filter((note): note is string => note !== null)
              .join(" · ")}
            accessory={
              <RowMenu
                label={item.key ?? item.path}
                actions={actions.map((action) => ({
                  id: action,
                  title: "Uninstall",
                  destructive: true,
                }))}
                onSelect={() => {
                  if (item.key === undefined) return;
                  void runner
                    .runDeployment(key, target.environmentId, {
                      ...input,
                      key: item.key,
                      target: item.id,
                      operation: "uninstall",
                    })
                    .then(deployments.refresh);
                }}
              />
            }
          />
        );
      })}
    </ListSection>
  );
}

const DEPLOYMENT_LABELS: Record<SkillDeploymentTargetSummary["status"], string> = {
  absent: "Not installed",
  owned: "Installed by T3 Code",
  drifted: "Edited outside T3 Code, left in place",
  blocked: "Blocked",
};

const TEXT_ACTION_TITLES: Partial<Record<ReturnType<typeof textResourceActions>[number], string>> =
  {
    edit: "Edit",
    "edit-override": "Edit project override",
    override: "Override for this project",
    enable: "Turn on",
    disable: "Turn off",
    "disable-project": "Turn off for this project",
    "reset-project": "Use environment version",
    "thread-enable": "Turn on for this thread",
    "thread-disable": "Turn off for this thread",
    "thread-reset": "Follow project and environment",
    delete: "Delete",
  };
const DESTRUCTIVE_TEXT_ACTIONS = new Set([
  "delete",
  "disable",
  "disable-project",
  "thread-disable",
]);

function TextResourcesSection({ target }: { target: MobileResourceTarget }) {
  const thread = target.thread;
  const catalog = useEnvironmentQuery(
    managedTextEnvironment.catalog({
      environmentId: target.environmentId,
      input: catalogInputFor(target),
    }),
  );
  const canWrite = useAtomValue(
    (thread !== undefined
      ? managedTextEnvironment.threadSetEnabled
      : target.projectId === null
        ? managedTextEnvironment.environmentUpdate
        : managedTextEnvironment.projectSetOverride
    ).permissionAtom(target.environmentId),
  );
  const runner = useMutationRunner();
  const open = useOpenSettingsScreen();
  const data = catalog.data;
  const context = { projectId: target.projectId, threadId: thread?.threadId ?? null };
  const overlays = new Set(
    (data?.threadOverlays ?? []).map((overlay) => `${overlay.kind}:${overlay.key}`),
  );
  const entryKey = (entry: ManagedTextResourceSummary) =>
    JSON.stringify([entry.kind, entry.scope, entry.scopeId, entry.key]);
  const orphaned =
    thread === undefined || data === null
      ? []
      : orphanedThreadTextOverlays(data.entries, data.threadOverlays ?? []);
  const overlayKey = (overlay: { kind: string; key: string }) =>
    JSON.stringify(["thread-overlay", overlay.kind, overlay.key]);
  const act = (entry: ManagedTextResourceSummary, action: string) => {
    if (data === null) return;
    if (action === "edit" || action === "edit-override" || action === "override") {
      open("SettingsTextResourceEditor", {
        ...targetParams(target),
        kind: entry.kind,
        key: entry.key,
        mode: action === "override" ? "override" : "edit",
      });
      return;
    }
    const mutation = textMutationForAction(
      action as ReturnType<typeof textResourceActions>[number],
      entry,
      target,
      data.catalogRevision,
    );
    if (mutation)
      void runner.runText(entryKey(entry), target.environmentId, mutation).then(catalog.refresh);
  };
  const create = (kind: ManagedTextResourceKind) =>
    open("SettingsTextResourceEditor", { ...targetParams(target), kind, mode: "create" });
  return (
    <View className="gap-5">
      {catalog.error !== null ? (
        <QueryFailure message={catalog.error} onRetry={catalog.refresh} />
      ) : null}
      {runner.failure !== null ? (
        <Notice tone="danger" message={runner.failure} onDismiss={runner.clear} />
      ) : null}
      {canWrite && data !== null && thread === undefined ? (
        <View className="flex-row gap-2">
          <Button
            label="New command"
            tone="secondary"
            icon="plus"
            onPress={() => create("command")}
          />
          <Button
            label="New snippet"
            tone="secondary"
            icon="plus"
            onPress={() => create("snippet")}
          />
        </View>
      ) : null}
      <ListSection
        title="Commands and snippets"
        footer="Choosing one in the composer turns it into ordinary draft text you can edit before sending."
      >
        {data === null && catalog.error === null ? (
          <WorkBlock>
            <WorkText muted>Loading…</WorkText>
          </WorkBlock>
        ) : null}
        {data !== null && data.entries.length === 0 && orphaned.length === 0 ? (
          <WorkBlock>
            <WorkText muted>Nothing here yet.</WorkText>
          </WorkBlock>
        ) : null}
        {data?.entries.map((entry) => {
          const overlay = overlays.has(`${entry.kind}:${entry.key}`);
          const actions = canWrite
            ? textResourceActions(entry, context, overlay).flatMap((action) => {
                const title = TEXT_ACTION_TITLES[action];
                return title
                  ? [{ id: action, title, destructive: DESTRUCTIVE_TEXT_ACTIONS.has(action) }]
                  : [];
              })
            : [];
          return (
            <ListRowLayout
              key={entryKey(entry)}
              icon={entry.kind === "command" ? "terminal" : "text.alignleft"}
              label={`/${entry.key}${entry.name ? `  ${entry.name}` : ""}`}
              description={[
                entry.kind === "command" ? "Command" : "Snippet",
                managedTextResourceScopeLabel(entry),
                entry.effective ? null : "Off",
                overlay ? "Set for this thread" : null,
                runner.pending === entryKey(entry) ? "Saving…" : null,
              ]
                .filter((note): note is string => note !== null)
                .join(" · ")}
              accessory={
                <RowMenu
                  label={entry.key}
                  actions={actions}
                  onSelect={(action) => act(entry, action)}
                />
              }
            />
          );
        })}
        {orphaned.map((overlay) => (
          <ListRowLayout
            key={overlayKey(overlay)}
            icon={overlay.kind === "command" ? "terminal" : "text.alignleft"}
            label={`/${overlay.key}`}
            description={[
              overlay.kind === "command" ? "Command" : "Snippet",
              "No longer available",
              overlay.enabled ? "Turned on for this thread" : "Turned off for this thread",
              runner.pending === overlayKey(overlay) ? "Saving…" : null,
            ]
              .filter((note): note is string => note !== null)
              .join(" · ")}
            accessory={
              <RowMenu
                label={overlay.key}
                actions={
                  canWrite
                    ? [{ id: "thread-reset", title: TEXT_ACTION_TITLES["thread-reset"] ?? "Reset" }]
                    : []
                }
                onSelect={() => {
                  if (data === null) return;
                  // The setting outlives its source; resetting keeps a recreated key from inheriting it.
                  const mutation = threadTextOverlayReset(overlay, target, data.catalogRevision);
                  if (mutation)
                    void runner
                      .runText(overlayKey(overlay), target.environmentId, mutation)
                      .then(catalog.refresh);
                }}
              />
            }
          />
        ))}
      </ListSection>
    </View>
  );
}

/** Read-only composition of the real catalogs; MCP authoring stays on web and desktop. */
function InventorySection({ target }: { target: MobileResourceTarget }) {
  const input = target.projectId === null ? {} : { projectId: target.projectId };
  const skills = useEnvironmentQuery(
    skillsEnvironment.catalog({ environmentId: target.environmentId, input }),
  );
  const text = useEnvironmentQuery(
    managedTextEnvironment.catalog({ environmentId: target.environmentId, input }),
  );
  const globalMcp = useEnvironmentQuery(
    mcpCatalogEnvironment.read({
      environmentId: target.environmentId,
      input: { scope: "global", scopeId: target.environmentId },
    }),
  );
  const projectMcp = useEnvironmentQuery(
    target.projectId === null
      ? null
      : mcpCatalogEnvironment.read({
          environmentId: target.environmentId,
          input: { scope: "project", scopeId: target.projectId },
        }),
  );
  const failed = [skills, text, globalMcp, projectMcp].find((query) => query.error !== null);
  if (
    skills.data === null ||
    text.data === null ||
    globalMcp.data === null ||
    (target.projectId !== null && projectMcp.data === null)
  ) {
    return failed !== undefined && failed.error !== null ? (
      <QueryFailure message={failed.error} onRetry={failed.refresh} />
    ) : (
      <WorkText muted>Loading resources…</WorkText>
    );
  }
  const inventory = composeManagedResourceInventory({
    skills: skills.data,
    text: text.data,
    // What this project effectively gets: inherited servers with its overrides applied.
    mcp: {
      revision: projectMcp.data?.revision ?? globalMcp.data.revision,
      definitions: effectiveMcpCatalogDefinitions({
        inherited: target.projectId === null ? [] : globalMcp.data.definitions,
        own:
          target.projectId === null
            ? globalMcp.data.definitions
            : (projectMcp.data?.definitions ?? []),
        overrides: projectMcp.data?.overrides ?? [],
      }),
      overrides: [],
    },
    limit: 200,
  });
  return (
    <ListSection
      title="Overview"
      footer={
        inventory.truncated
          ? "Showing the first 200. MCP servers are edited on web or desktop."
          : "MCP servers are edited on web or desktop."
      }
    >
      {inventory.rows.length === 0 ? (
        <WorkBlock>
          <WorkText muted>Nothing configured here yet.</WorkText>
        </WorkBlock>
      ) : null}
      {inventory.rows.map((row) => (
        <ListRowLayout
          key={row.id}
          icon={
            row.kind === "mcp"
              ? "server.rack"
              : row.kind === "skill"
                ? "sparkles"
                : "text.alignleft"
          }
          label={row.name}
          description={[
            row.kind === "mcp"
              ? "MCP server"
              : row.kind === "skill"
                ? "Skill"
                : row.kind === "command"
                  ? "Command"
                  : "Snippet",
            row.source === "native" ? "Provider" : null,
            row.enabled ? null : "Off",
          ]
            .filter((note): note is string => note !== null)
            .join(" · ")}
        />
      ))}
    </ListSection>
  );
}

type ThreadResourcesProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/** One thread's skill and command overlays: on, off, or back to what its project uses. */
export function SettingsThreadResourcesRouteScreen({ route }: ThreadResourcesProps) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const thread = useThreadShell(
    scopeThreadRef(environmentId, ThreadId.make(route.params.threadId)),
  );
  const style = useScrollInsets();
  const [section, setSection] = useState<"skills" | "commands">("skills");
  const target: MobileResourceTarget | null =
    thread === null
      ? null
      : {
          environmentId,
          projectId: thread.projectId,
          thread: { threadId: thread.id, providerInstanceId: thread.providerInstanceId },
        };
  useResourceCatalogSubscriptions(
    target === null ? null : { environmentId, projectId: thread!.projectId, threadId: thread!.id },
  );
  return (
    <SettingsScreen title={thread?.title ?? "Thread"}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={style}
      >
        {target === null ? (
          <WorkText muted>
            This thread isn't on the selected environment, or it was removed.
          </WorkText>
        ) : (
          <>
            <WorkText muted>
              Changes here apply only to this thread. Edit shared skills and commands from the
              project or environment.
            </WorkText>
            <SegmentedControl
              options={[
                { value: "skills", label: "Skills" },
                { value: "commands", label: "Commands" },
              ]}
              selected={section}
              onSelect={setSection}
            />
            {section === "skills" ? (
              <SkillsSection target={target} />
            ) : (
              <TextResourcesSection target={target} />
            )}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

type SkillInstallProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId?: string;
  readonly skillId: string;
}>;

/** Install, update or remove one skill's copy in a provider's own skill folders. */
export function SettingsSkillInstallRouteScreen({ route }: SkillInstallProps) {
  const { target } = useTarget(route.params);
  const style = useScrollInsets();
  const catalog = useEnvironmentQuery(
    skillsEnvironment.catalog({
      environmentId: target.environmentId,
      input: target.projectId === null ? {} : { projectId: target.projectId },
    }),
  );
  const entry =
    catalog.data?.entries.find(
      (candidate): candidate is SkillManagedCatalogSummary =>
        candidate.origin === "managed" && candidate.id === route.params.skillId,
    ) ?? null;
  const providers = catalog.data?.installProviderInstances ?? [];
  const [selected, setSelected] = useState<ProviderInstanceId | null>(null);
  const providerInstanceId = selected ?? providers[0] ?? null;
  const input =
    entry === null || providerInstanceId === null
      ? null
      : {
          skillId: entry.id,
          providerInstanceId,
          ...(target.projectId === null ? {} : { projectId: target.projectId }),
        };
  const deployments = useEnvironmentQuery(
    input === null
      ? null
      : skillsEnvironment.deployment({ environmentId: target.environmentId, input }),
  );
  const canChange = useAtomValue(
    skillsEnvironment.deploymentChange.permissionAtom(target.environmentId),
  );
  const runner = useMutationRunner();
  return (
    <SettingsScreen title={entry === null ? "Install skill" : `Install ${entry.name}`}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={style}
      >
        {catalog.error !== null ? (
          <QueryFailure message={catalog.error} onRetry={catalog.refresh} />
        ) : catalog.data === null ? (
          <WorkText muted>Loading…</WorkText>
        ) : entry === null ? (
          <WorkText muted>This skill was removed.</WorkText>
        ) : providers.length === 0 ? (
          <WorkText muted>No provider on this environment accepts installed skills.</WorkText>
        ) : (
          <>
            <WorkText muted>
              Copies this revision into a provider's own skills folder. T3 Code never overwrites a
              copy someone edited.
            </WorkText>
            {providers.length > 1 ? (
              <SegmentedControl
                options={providers.map((id) => ({ value: id, label: id }))}
                selected={providerInstanceId ?? providers[0]!}
                onSelect={setSelected}
              />
            ) : null}
            {deployments.error !== null ? (
              <QueryFailure message={deployments.error} onRetry={deployments.refresh} />
            ) : null}
            {runner.failure !== null ? (
              <Notice tone="danger" message={runner.failure} onDismiss={runner.clear} />
            ) : null}
            <ListSection title="Install folders">
              {deployments.data === null && deployments.error === null ? (
                <WorkBlock>
                  <WorkText muted>Loading…</WorkText>
                </WorkBlock>
              ) : null}
              {(deployments.data?.targets ?? []).map((item) => {
                const actions = canChange ? skillDeploymentActions(item, entry.key) : [];
                const key = `${item.id}`;
                return (
                  <ListRowLayout
                    key={item.id}
                    icon="folder"
                    label={item.path}
                    description={[
                      DEPLOYMENT_LABELS[item.status],
                      item.status === "owned" && item.key !== undefined && item.key !== entry.key
                        ? `Holds the copy of "${item.key}"`
                        : null,
                      item.detail ?? null,
                      runner.pending === key ? "Saving…" : null,
                    ]
                      .filter((note): note is string => note !== null)
                      .join(" · ")}
                    accessory={
                      <RowMenu
                        label={item.path}
                        actions={actions.map((action) => ({
                          id: action,
                          title:
                            action === "install"
                              ? "Install"
                              : action === "update"
                                ? "Update"
                                : "Uninstall",
                          destructive: action === "uninstall",
                        }))}
                        onSelect={(action) => {
                          if (input === null) return;
                          void runner
                            .runDeployment(key, target.environmentId, {
                              ...input,
                              key: entry.key,
                              target: item.id,
                              operation: action === "uninstall" ? "uninstall" : "install",
                              ...(action === "uninstall"
                                ? {}
                                : { expectedHash: entry.revision.hash }),
                            })
                            .then(deployments.refresh);
                        }}
                      />
                    }
                  />
                );
              })}
            </ListSection>
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

type SkillEditorProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId?: string;
  readonly skillId?: string;
  readonly mode: string;
}>;

export function SettingsSkillEditorRouteScreen({ route }: SkillEditorProps) {
  const destination: ResourceEditorDestination<"skill"> = {
    environmentId: EnvironmentId.make(route.params.environmentId),
    projectId: route.params.projectId ? ProjectId.make(route.params.projectId) : null,
    resource: "skill",
    mode:
      route.params.mode === "edit" || route.params.mode === "override"
        ? route.params.mode
        : "create",
    identity: route.params.skillId ?? null,
  };
  // The navigator may keep this screen and swap its params. A different
  // destination is a different editor; revisions are never part of the key.
  return (
    <SkillEditorScreen key={resourceEditorDestinationKey(destination)} destination={destination} />
  );
}

/** Mounted state for async work that must not land after the editor is gone. */
function useMountedRef() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

type ReloadState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string };

/** A failed reload keeps the draft; an interrupted one says nothing. */
function reloadFailed(result: AtomCommandResult<unknown, unknown>): ReloadState {
  return result._tag !== "Failure" || isAtomCommandInterrupted(result)
    ? { status: "idle" }
    : {
        status: "failed",
        message: `${describeResourceFailure(squashAtomCommandFailure(result))} Your text is unchanged.`,
      };
}

function SkillEditorScreen({
  destination,
}: {
  readonly destination: ResourceEditorDestination<"skill">;
}) {
  const target: MobileResourceTarget = {
    environmentId: destination.environmentId,
    projectId: destination.projectId,
  };
  const navigation = useNavigation();
  const style = useScrollInsets();
  const registry = useContext(RegistryContext);
  const mounted = useMountedRef();
  const { mode, identity: skillId } = destination;
  const catalogInput = target.projectId === null ? {} : { projectId: target.projectId };
  const catalog = useEnvironmentQuery(
    skillsEnvironment.catalog({ environmentId: target.environmentId, input: catalogInput }),
  );
  const liveEntry =
    skillId === null
      ? undefined
      : catalog.data?.entries.find(
          (candidate): candidate is SkillManagedCatalogSummary =>
            candidate.origin === "managed" && candidate.id === skillId,
        );
  const contentAtom =
    skillId === null
      ? null
      : skillsEnvironment.content({
          environmentId: target.environmentId,
          input: { skillId: ManagedSkillId.make(skillId), ...catalogInput },
        });
  const content = useEnvironmentQuery(contentAtom);
  const runner = useMutationRunner();
  // Form text, the tokens a save is checked against, and the destination they
  // belong to are taken together once and change only on an explicit reload;
  // a background refresh never swaps them.
  const [editor, setEditor] = useState<{
    readonly destination: ResourceEditorDestination<"skill">;
    readonly form: { key: string; name: string; body: string };
    readonly catalogRevision: SkillCatalogRevision;
    readonly source: {
      readonly entry: SkillManagedCatalogSummary;
      readonly content: SkillContentDetail;
    } | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState<ReloadState>({ status: "idle" });
  const reloadRequest = useRef(0);
  const openFromLive = () => {
    if (catalog.data === null) return;
    if (mode === "create") {
      setEditor((current) => ({
        destination,
        form: current?.form ?? { key: "", name: "", body: "" },
        catalogRevision: catalog.data!.catalogRevision,
        source: null,
      }));
      return;
    }
    if (
      content.data === null ||
      liveEntry === undefined ||
      content.data.metadata.revision.hash !== liveEntry.revision.hash
    )
      return;
    setEditor({
      destination,
      form: {
        key: content.data.content.key,
        name: content.data.content.name,
        body: content.data.content.body,
      },
      catalogRevision: catalog.data.catalogRevision,
      source: { entry: liveEntry, content: content.data },
    });
  };
  if (editor === null && catalog.data !== null && (mode === "create" || content.data !== null))
    openFromLive();
  /**
   * Loads the current content and then the catalog, and adopts both only when
   * the catalog names that content's revision. The draft stays until then.
   */
  const reloadCurrent = async () => {
    if (mode === "create" || contentAtom === null || editor?.source == null) {
      openFromLive();
      return;
    }
    const scope = editor.source.entry.scope;
    const request = ++reloadRequest.current;
    setReload({ status: "loading" });
    const detail = await executeAtomQuery(registry, contentAtom, {
      refresh: true,
      reportFailure: false,
    });
    const current =
      detail._tag === "Success"
        ? await executeAtomQuery(
            registry,
            skillsEnvironment.catalog({ environmentId: target.environmentId, input: catalogInput }),
            { refresh: true, reportFailure: false },
          )
        : detail;
    if (!mounted.current || request !== reloadRequest.current) return;
    if (detail._tag !== "Success") return setReload(reloadFailed(detail));
    if (current._tag !== "Success") return setReload(reloadFailed(current));
    const catalogRevision = skillReloadBaseline(
      { id: skillId ?? "", scope },
      detail.value,
      current.value,
    );
    const entry = current.value.entries.find(
      (candidate): candidate is SkillManagedCatalogSummary =>
        candidate.origin === "managed" && candidate.id === skillId,
    );
    if (catalogRevision === null || entry === undefined)
      return setReload({
        status: "failed",
        message: "It changed again while loading, or was removed. Your text is unchanged.",
      });
    setReload({ status: "idle" });
    setEditor({
      destination,
      form: {
        key: detail.value.content.key,
        name: detail.value.content.name,
        body: detail.value.content.body,
      },
      catalogRevision,
      source: { entry, content: detail.value },
    });
  };
  const conflict =
    editor === null || catalog.data === null
      ? null
      : resourceEditorConflict(
          {
            catalogRevision:
              mode === "edit" && editor.source?.entry.scope === "global"
                ? null
                : editor.catalogRevision,
            entryRevision: editor.source?.content.metadata.revision.hash ?? null,
          },
          {
            catalogRevision: catalog.data.catalogRevision,
            entryRevision: editor.source === null ? undefined : liveEntry?.revision.hash,
          },
        );
  const setForm = (patch: Partial<{ key: string; name: string; body: string }>) =>
    setEditor((current) =>
      current === null ? current : { ...current, form: { ...current.form, ...patch } },
    );
  const save = async () => {
    if (editor === null || conflict !== null) return;
    const built = buildSkillSave({
      form: editor.form,
      destination: editor.destination,
      current: destination,
      catalogRevision: editor.catalogRevision,
      source: editor.source,
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    const saved = await runner.runSkill("save", editor.destination.environmentId, built.mutation);
    if (saved && mounted.current) navigation.goBack();
  };
  const loadFailure = catalog.error ?? content.error;
  return (
    <SettingsScreen
      title={
        mode === "create" ? "New skill" : mode === "override" ? "Project override" : "Edit skill"
      }
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={style}
        keyboardShouldPersistTaps="handled"
      >
        {editor === null ? (
          loadFailure !== null ? (
            <QueryFailure
              message={loadFailure}
              onRetry={() => {
                catalog.refresh();
                content.refresh();
              }}
            />
          ) : catalog.data !== null && mode !== "create" && liveEntry === undefined ? (
            <WorkText muted>This skill was removed.</WorkText>
          ) : (
            <WorkText muted>Loading the current revision…</WorkText>
          )
        ) : (
          <>
            {mode === "override" ? (
              <WorkText muted>
                Only this project uses the override. The environment skill stays unchanged.
              </WorkText>
            ) : null}
            <WorkInput
              label="Name"
              value={editor.form.name}
              onChange={(name) => setForm({ name })}
            />
            {mode === "create" ? (
              <WorkInput
                label="Key (used as $key)"
                value={editor.form.key}
                onChange={(key) => setForm({ key })}
              />
            ) : (
              <WorkText muted>{`Invoked as $${editor.form.key}`}</WorkText>
            )}
            <WorkInput
              label="Instructions"
              multiline
              maxLength={200_000}
              value={editor.form.body}
              onChange={(body) => setForm({ body })}
            />
            <EditorConflict
              conflict={conflict}
              removedMessage="This skill was deleted elsewhere. Your text is kept here; go back to discard it."
              reloadLabel={mode === "create" ? "Use current catalog" : "Reload current version"}
              reload={reload}
              onReload={() => void reloadCurrent()}
            />
            <WorkFormActions
              submitLabel="Save"
              pending={runner.pending === "save"}
              disabled={conflict !== null}
              onSubmit={() => void save()}
              onCancel={() => navigation.goBack()}
              failure={error ?? runner.failure}
            />
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

/** A changed or removed baseline, with the explicit reload and its own failure. */
function EditorConflict(props: {
  readonly conflict: "changed" | "removed" | null;
  readonly removedMessage: string;
  readonly reloadLabel: string;
  readonly reload: ReloadState;
  readonly onReload: () => void;
}) {
  if (props.conflict === null) return null;
  return (
    <View className="gap-2">
      <Notice
        icon="info.circle"
        message={
          props.conflict === "removed"
            ? props.removedMessage
            : "This changed elsewhere since you opened it. Your text is kept; reload to continue from the current version."
        }
      />
      {props.conflict === "changed" ? (
        <View className="flex-row">
          <Button
            label={props.reloadLabel}
            tone="secondary"
            loading={props.reload.status === "loading"}
            onPress={props.onReload}
          />
        </View>
      ) : null}
      {props.reload.status === "failed" ? (
        <Notice tone="danger" icon="exclamationmark.triangle" message={props.reload.message} />
      ) : null}
    </View>
  );
}

type TextEditorProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId?: string;
  readonly kind: string;
  readonly key?: string;
  readonly mode: string;
}>;

export function SettingsTextResourceEditorRouteScreen({ route }: TextEditorProps) {
  const destination: ResourceEditorDestination<ManagedTextResourceKind> = {
    environmentId: EnvironmentId.make(route.params.environmentId),
    projectId: route.params.projectId ? ProjectId.make(route.params.projectId) : null,
    resource: route.params.kind === "snippet" ? "snippet" : "command",
    mode:
      route.params.mode === "edit" || route.params.mode === "override"
        ? route.params.mode
        : "create",
    identity: route.params.key ?? null,
  };
  return (
    <TextEditorScreen key={resourceEditorDestinationKey(destination)} destination={destination} />
  );
}

function TextEditorScreen({
  destination,
}: {
  readonly destination: ResourceEditorDestination<ManagedTextResourceKind>;
}) {
  const target: MobileResourceTarget = {
    environmentId: destination.environmentId,
    projectId: destination.projectId,
  };
  const navigation = useNavigation();
  const style = useScrollInsets();
  const registry = useContext(RegistryContext);
  const mounted = useMountedRef();
  const { mode, resource: kind, identity: entryKey } = destination;
  const scopeInput = target.projectId === null ? {} : { projectId: target.projectId };
  const catalog = useEnvironmentQuery(
    managedTextEnvironment.catalog({ environmentId: target.environmentId, input: scopeInput }),
  );
  const liveEntry =
    entryKey === null
      ? undefined
      : catalog.data?.entries.find(
          (candidate) => candidate.kind === kind && candidate.key === entryKey,
        );
  // Saves use what the text was loaded from; a deleted or newer entry is a conflict, never resurrected.
  const [editor, setEditor] = useState<{
    readonly destination: ResourceEditorDestination<ManagedTextResourceKind>;
    readonly form: { key: string; name: string; body: string };
    readonly catalogRevision: ManagedTextResourceCatalogRevision;
    readonly entry: ManagedTextResourceSummary | null;
  } | null>(null);
  // Only the first load reads through this query; a reload asks for the current revision itself.
  const contentFor = editor === null ? (liveEntry ?? null) : null;
  const content = useEnvironmentQuery(
    mode === "create" || contentFor === null || contentFor.id === undefined
      ? null
      : managedTextEnvironment.content({
          environmentId: target.environmentId,
          input: {
            kind,
            id: contentFor.id,
            expectedRevision: contentFor.revision,
            ...scopeInput,
          },
        }),
  );
  const runner = useMutationRunner();
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState<ReloadState>({ status: "idle" });
  const reloadRequest = useRef(0);
  const openFromLive = () => {
    if (catalog.data === null) return;
    if (mode === "create") {
      setEditor((current) => ({
        destination,
        form: current?.form ?? { key: "", name: "", body: "" },
        catalogRevision: catalog.data!.catalogRevision,
        entry: null,
      }));
      return;
    }
    if (
      liveEntry === undefined ||
      content.data === null ||
      content.data.revision !== liveEntry.revision
    )
      return;
    setEditor({
      destination,
      form: { key: content.data.key, name: content.data.name ?? "", body: content.data.body },
      catalogRevision: catalog.data.catalogRevision,
      entry: liveEntry,
    });
  };
  if (editor === null && catalog.data !== null && (mode === "create" || content.data !== null))
    openFromLive();
  /**
   * Reads the current catalog, then the content of the entry's current
   * revision, and adopts text and tokens together. The draft stays until then.
   */
  const reloadCurrent = async () => {
    if (mode === "create" || entryKey === null) {
      openFromLive();
      return;
    }
    const request = ++reloadRequest.current;
    setReload({ status: "loading" });
    const current = await executeAtomQuery(
      registry,
      managedTextEnvironment.catalog({ environmentId: target.environmentId, input: scopeInput }),
      { refresh: true, reportFailure: false },
    );
    if (!mounted.current || request !== reloadRequest.current) return;
    if (current._tag !== "Success") return setReload(reloadFailed(current));
    const entry = textReloadEntry({ kind, key: entryKey }, current.value.entries);
    if (entry === null || entry.id === undefined)
      return setReload({
        status: "failed",
        message: "This was deleted or reset elsewhere. Your text is unchanged.",
      });
    const detail = await executeAtomQuery(
      registry,
      managedTextEnvironment.content({
        environmentId: target.environmentId,
        input: { kind, id: entry.id, expectedRevision: entry.revision, ...scopeInput },
      }),
      { refresh: true, reportFailure: false },
    );
    if (!mounted.current || request !== reloadRequest.current) return;
    if (detail._tag !== "Success") return setReload(reloadFailed(detail));
    if (!isTextReloadCurrent(entry, detail.value))
      return setReload({
        status: "failed",
        message: "It changed again while loading. Your text is unchanged; reload again.",
      });
    setReload({ status: "idle" });
    setEditor({
      destination,
      form: { key: detail.value.key, name: detail.value.name ?? "", body: detail.value.body },
      catalogRevision: current.value.catalogRevision,
      entry,
    });
  };
  const conflict =
    editor === null || catalog.data === null
      ? null
      : resourceEditorConflict(
          {
            catalogRevision:
              mode === "edit" && editor.entry?.scope === "environment"
                ? null
                : editor.catalogRevision,
            entryRevision: editor.entry?.revision ?? null,
          },
          {
            catalogRevision: catalog.data.catalogRevision,
            entryRevision: editor.entry === null ? undefined : liveEntry?.revision,
          },
        );
  const setForm = (patch: Partial<{ key: string; name: string; body: string }>) =>
    setEditor((current) =>
      current === null ? current : { ...current, form: { ...current.form, ...patch } },
    );
  const save = async () => {
    if (editor === null || conflict !== null) return;
    const built = buildTextSave({
      form: editor.form,
      destination: editor.destination,
      current: destination,
      catalogRevision: editor.catalogRevision,
      editing: editor.destination.mode === "edit" ? editor.entry : null,
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    const saved = await runner.runText("save", editor.destination.environmentId, built.mutation);
    if (saved && mounted.current) navigation.goBack();
  };
  const noun = kind === "command" ? "command" : "snippet";
  const loadFailure = catalog.error ?? content.error;
  return (
    <SettingsScreen
      title={
        mode === "create"
          ? `New ${noun}`
          : mode === "override"
            ? "Project override"
            : `Edit ${noun}`
      }
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={style}
        keyboardShouldPersistTaps="handled"
      >
        {editor === null ? (
          loadFailure !== null ? (
            <QueryFailure
              message={loadFailure}
              onRetry={() => {
                catalog.refresh();
                content.refresh();
              }}
            />
          ) : catalog.data !== null && mode !== "create" && liveEntry === undefined ? (
            <WorkText muted>This item was removed.</WorkText>
          ) : (
            <WorkText muted>Loading…</WorkText>
          )
        ) : (
          <>
            <WorkText muted>
              {kind === "command"
                ? "Choosing the command replaces it with this text. $ARGUMENTS becomes whatever follows the command on that line."
                : "Choosing the snippet inserts this text where you typed it."}
            </WorkText>
            {mode === "create" ? (
              <WorkInput
                label="Key (used as /key)"
                value={editor.form.key}
                onChange={(key) => setForm({ key })}
              />
            ) : (
              <WorkText muted>{`/${editor.form.key}`}</WorkText>
            )}
            <WorkInput
              label="Name (optional)"
              value={editor.form.name}
              onChange={(name) => setForm({ name })}
            />
            <WorkInput
              label="Text"
              multiline
              maxLength={65_536}
              value={editor.form.body}
              onChange={(body) => setForm({ body })}
            />
            <EditorConflict
              conflict={conflict}
              removedMessage="This was deleted or reset elsewhere. Your text is kept here; go back to discard it."
              reloadLabel={mode === "create" ? "Use current catalog" : "Reload current version"}
              reload={reload}
              onReload={() => void reloadCurrent()}
            />
            <WorkFormActions
              submitLabel="Save"
              pending={runner.pending === "save"}
              disabled={conflict !== null}
              onSubmit={() => void save()}
              onCancel={() => navigation.goBack()}
              failure={error ?? runner.failure}
            />
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
