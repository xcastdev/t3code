import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import {
  ManagedTextResourceBody,
  ManagedTextResourceKey,
  ManagedTextResourceName,
  type EnvironmentId,
  type ManagedTextResourceKind,
  type ManagedTextResourceSummary,
  type ProjectId,
} from "@t3tools/contracts";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ManagedTextResourceCatalogChanges } from "./ManagedTextResourceCatalogChanges";
import { managedTextResourcesEnvironment } from "../../state/managedTextResources";
import {
  buildManagedTextResourceProjectOverrideInput,
  createManagedTextResourceForm,
  getManagedTextResourceManagementActions,
  type ManagedTextResourceForm,
} from "./managedTextResourcesModel";

function resourceScopeLabel(entry: ManagedTextResourceSummary): string {
  const source = entry.scope === "project" ? "Project" : "Environment default";
  if (entry.scope === "environment" && entry.environmentState === "disabled") {
    return `${source} · Disabled`;
  }
  switch (entry.projectState) {
    case "inherit":
      return entry.scope === "environment"
        ? `${source} · ${entry.effective ? "Enabled" : "Unavailable"}`
        : `${source} · Inherited · ${entry.effective ? "Enabled" : "Unavailable"}`;
    case "override":
      return `${source} · Project override · ${entry.effective ? "Enabled" : "Unavailable"}`;
    case "disabled":
      return "Project · Disabled";
    case "invalid":
      return "Project · Unavailable · Invalid state";
    case "orphan":
      return "Project · Unavailable · Missing source";
  }
}

function KindChoice(props: {
  readonly kind: ManagedTextResourceKind;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      className={`rounded-lg px-3 py-2 ${props.selected ? "bg-accent" : "bg-card"}`}
      onPress={props.onPress}
    >
      <Text className="text-sm text-foreground">
        {props.kind === "command" ? "Command" : "Snippet"}
      </Text>
    </Pressable>
  );
}

function FormField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly multiline?: boolean;
  readonly editable?: boolean;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-xs font-t3-medium text-foreground-muted">{props.label}</Text>
      <TextInput
        className={`rounded-xl border border-border bg-sheet px-3 py-2.5 text-sm text-foreground ${props.multiline ? "min-h-40" : "min-h-11"}`}
        editable={props.editable}
        multiline={props.multiline}
        onChangeText={props.onChangeText}
        textAlignVertical={props.multiline ? "top" : "center"}
        value={props.value}
      />
    </View>
  );
}

export function SettingsManagedTextResourcesRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(
    environments[0]?.environmentId ?? null,
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [form, setForm] = useState<ManagedTextResourceForm | null>(null);

  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  useEffect(() => {
    if (environment) return;
    setEnvironmentId(environments[0]?.environmentId ?? null);
    setProjectId(null);
    setSelectedKey(null);
    setForm(null);
  }, [environment, environments]);
  useEffect(() => {
    if (projectId === null || environmentProjects.some((project) => project.id === projectId))
      return;
    setProjectId(null);
    setSelectedKey(null);
    setForm(null);
  }, [environmentProjects, projectId]);

  const catalogTarget = useMemo(
    () =>
      environment
        ? {
            environmentId: environment.environmentId,
            input: projectId ? { projectId } : {},
          }
        : null,
    [environment, projectId],
  );
  const catalog = useEnvironmentQuery(
    useMemo(
      () => (catalogTarget ? managedTextResourcesEnvironment.catalog(catalogTarget) : null),
      [catalogTarget],
    ),
  );
  const entries = catalog.data?.entries ?? [];
  const selected = entries.find((entry) => `${entry.kind}:${entry.key}` === selectedKey) ?? null;
  const selectedManagementActions = selected
    ? getManagedTextResourceManagementActions(selected, projectId !== null)
    : [];
  const content = useEnvironmentQuery(
    useMemo(
      () =>
        environment && selected?.id
          ? managedTextResourcesEnvironment.content({
              environmentId: environment.environmentId,
              input: {
                kind: selected.kind,
                id: selected.id,
                expectedRevision: selected.revision,
                ...(projectId ? { projectId } : {}),
              },
            })
          : null,
      [environment, projectId, selected],
    ),
  );

  const createEnvironment = useAtomCommand(managedTextResourcesEnvironment.environmentCreate, {
    reportFailure: true,
  });
  const updateEnvironment = useAtomCommand(managedTextResourcesEnvironment.environmentUpdate, {
    reportFailure: true,
  });
  const deleteEnvironment = useAtomCommand(managedTextResourcesEnvironment.environmentDelete, {
    reportFailure: true,
  });
  const setProjectOverride = useAtomCommand(managedTextResourcesEnvironment.projectSetOverride, {
    reportFailure: true,
  });
  const setProjectDisabled = useAtomCommand(managedTextResourcesEnvironment.projectSetDisabled, {
    reportFailure: true,
  });
  const setEnvironmentEnabled = useAtomCommand(
    managedTextResourcesEnvironment.environmentSetEnabled,
    { reportFailure: true },
  );
  const deleteProjectState = useAtomCommand(managedTextResourcesEnvironment.projectDeleteState, {
    reportFailure: true,
  });

  function startCreate(kind: ManagedTextResourceKind = "command") {
    if (!catalog.data) return;
    setSelectedKey(null);
    setForm(
      createManagedTextResourceForm(
        { operation: "create", kind, key: "", name: "", body: "", entry: null },
        catalog.data.catalogRevision,
      ),
    );
  }

  function startEdit(operation: "edit" | "override", entry: ManagedTextResourceSummary) {
    if (
      !catalog.data ||
      !content.data ||
      content.data.kind !== entry.kind ||
      content.data.id !== entry.id ||
      content.data.key !== entry.key ||
      content.data.revision !== entry.revision
    ) {
      return;
    }
    setForm(
      createManagedTextResourceForm(
        {
          operation,
          kind: entry.kind,
          key: entry.key,
          name: entry.name ?? "",
          body: content.data.body,
          entry,
        },
        catalog.data.catalogRevision,
      ),
    );
  }

  const submitForm = () => {
    if (!environment || !form) return;

    if (projectId) {
      void setProjectOverride({
        environmentId: environment.environmentId,
        input: buildManagedTextResourceProjectOverrideInput(form, projectId),
      }).then((result) => {
        if (result._tag !== "Success") return;
        catalog.refresh();
        setForm(null);
      });
      return;
    }

    if (form.operation === "edit" && form.entry?.id) {
      void updateEnvironment({
        environmentId: environment.environmentId,
        input: {
          environmentId: environment.environmentId,
          kind: form.kind,
          id: form.entry.id,
          expectedRevision: form.entry.revision,
          ...(form.name.trim() ? { name: ManagedTextResourceName.make(form.name.trim()) } : {}),
          body: ManagedTextResourceBody.make(form.body),
        },
      }).then((result) => {
        if (result._tag !== "Success") return;
        catalog.refresh();
        setForm(null);
      });
      return;
    }

    void createEnvironment({
      environmentId: environment.environmentId,
      input: {
        environmentId: environment.environmentId,
        kind: form.kind,
        expectedCatalogRevision: form.expectedCatalogRevision,
        key: ManagedTextResourceKey.make(form.key.trim()),
        ...(form.name.trim() ? { name: ManagedTextResourceName.make(form.name.trim()) } : {}),
        body: ManagedTextResourceBody.make(form.body),
      },
    }).then((result) => {
      if (result._tag !== "Success") return;
      catalog.refresh();
      setForm(null);
    });
  };

  const runProjectStateMutation = (
    entry: ManagedTextResourceSummary,
    action: "disable" | "reset",
  ) => {
    if (!environment || !projectId || !catalog.data) return;
    const input = {
      projectId,
      kind: entry.kind,
      expectedCatalogRevision: catalog.data.catalogRevision,
      key: entry.key,
    };
    const mutation = action === "disable" ? setProjectDisabled : deleteProjectState;
    void mutation({ environmentId: environment.environmentId, input }).then(catalog.refresh);
  };

  const runEnvironmentSetEnabled = (entry: ManagedTextResourceSummary, enabled: boolean) => {
    if (!environment || !entry.id) return;
    void setEnvironmentEnabled({
      environmentId: environment.environmentId,
      input: {
        environmentId: environment.environmentId,
        kind: entry.kind,
        id: entry.id,
        expectedRevision: entry.revision,
        enabled,
      },
    }).then(catalog.refresh);
  };

  const runEnvironmentDelete = (entry: ManagedTextResourceSummary) => {
    if (!environment || !entry.id) return;
    Alert.alert(
      `Delete ${entry.kind === "command" ? "/" : ":"}${entry.key}?`,
      "This removes the environment definition for every project that inherits it.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            void deleteEnvironment({
              environmentId: environment.environmentId,
              input: {
                environmentId: environment.environmentId,
                kind: entry.kind,
                id: entry.id!,
                expectedRevision: entry.revision,
              },
            }).then(catalog.refresh),
        },
      ],
    );
  };

  const canSubmit = Boolean(
    environment &&
    catalog.data &&
    form &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.key.trim()) &&
    form.key.trim().length <= 64 &&
    form.name.trim().length <= 128 &&
    form.body.length <= 65_536,
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Commands & snippets" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      {catalogTarget ? (
        <ManagedTextResourceCatalogChanges
          environmentId={catalogTarget.environmentId}
          input={catalogTarget.input}
        />
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="gap-1 px-2">
          <Text className="text-xl font-t3-semibold text-foreground">Commands & snippets</Text>
          <Text className="text-sm text-foreground-muted">
            Manage editable slash commands and single-colon text snippets for a connected
            environment or project.
          </Text>
        </View>
        <SettingsSection title="Environment" card>
          {environments.map((candidate) => (
            <Pressable
              key={candidate.environmentId}
              accessibilityRole="button"
              onPress={() => {
                setEnvironmentId(candidate.environmentId);
                setProjectId(null);
                setSelectedKey(null);
                setForm(null);
              }}
              className="border-b border-border-subtle p-4 last:border-b-0"
            >
              <Text className="text-base text-foreground">{candidate.label}</Text>
              {candidate.environmentId === environmentId ? (
                <Text className="text-sm text-accent">Selected</Text>
              ) : null}
            </Pressable>
          ))}
          {environments.length === 0 ? (
            <Text className="p-4 text-sm text-foreground-muted">
              Connect an environment to manage its commands and snippets.
            </Text>
          ) : null}
        </SettingsSection>

        {environmentProjects.length > 0 ? (
          <SettingsSection title="Scope" card>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setProjectId(null);
                setSelectedKey(null);
                setForm(null);
              }}
              className="border-b border-border-subtle p-4"
            >
              <Text className="text-base text-foreground">Environment defaults</Text>
              {projectId === null ? <Text className="text-sm text-accent">Selected</Text> : null}
            </Pressable>
            {environmentProjects.map((project) => (
              <Pressable
                key={project.id}
                accessibilityRole="button"
                onPress={() => {
                  setProjectId(project.id);
                  setSelectedKey(null);
                  setForm(null);
                }}
                className="border-b border-border-subtle p-4 last:border-b-0"
              >
                <Text className="text-base text-foreground">{project.title}</Text>
                {project.id === projectId ? (
                  <Text className="text-sm text-accent">Selected</Text>
                ) : null}
              </Pressable>
            ))}
          </SettingsSection>
        ) : null}

        <SettingsSection
          title={projectId ? "Project commands & snippets" : "Environment catalog"}
          card
        >
          {environment && catalog.data ? (
            <View className="flex-row gap-2 p-3">
              <KindChoice kind="command" selected={false} onPress={() => startCreate("command")} />
              <KindChoice kind="snippet" selected={false} onPress={() => startCreate("snippet")} />
            </View>
          ) : null}
          {catalog.isPending ? (
            <Text className="p-4 text-sm text-foreground-muted">Reading catalog…</Text>
          ) : null}
          {catalog.error ? (
            <Text className="p-4 text-sm text-destructive">{catalog.error}</Text>
          ) : null}
          {entries.map((entry) => (
            <Pressable
              key={`${entry.kind}:${entry.key}`}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedKey === `${entry.kind}:${entry.key}` }}
              onPress={() => {
                setForm(null);
                setSelectedKey(
                  selectedKey === `${entry.kind}:${entry.key}`
                    ? null
                    : `${entry.kind}:${entry.key}`,
                );
              }}
              className="border-b border-border-subtle p-4 last:border-b-0"
            >
              <Text className="text-base font-t3-medium text-foreground">
                {entry.kind === "command" ? "/" : ":"}
                {entry.key}
                {entry.name ? ` · ${entry.name}` : ""}
              </Text>
              <Text className="mt-1 text-xs text-foreground-muted">
                {resourceScopeLabel(entry)}
              </Text>
            </Pressable>
          ))}
          {catalog.data && entries.length === 0 ? (
            <Text className="p-4 text-sm text-foreground-muted">
              No commands or snippets in this scope.
            </Text>
          ) : null}
        </SettingsSection>

        {selected ? (
          <SettingsSection title="Selected resource" card>
            <View className="gap-3 p-4">
              <Text className="text-lg font-t3-semibold text-foreground">
                {selected.kind === "command" ? "/" : ":"}
                {selected.key}
              </Text>
              <Text className="text-sm text-foreground-muted">{resourceScopeLabel(selected)}</Text>
              {selected.projectState === "invalid" || selected.projectState === "orphan" ? (
                <Text className="text-sm text-destructive">
                  This project entry is unavailable. Reset it to restore inherited behavior.
                </Text>
              ) : selected.projectState === "disabled" ? (
                <Text className="text-sm text-foreground-muted">Disabled for this project.</Text>
              ) : content.isPending ? (
                <Text className="text-sm text-foreground-muted">Loading definition…</Text>
              ) : content.error ? (
                <Text className="text-sm text-destructive">{content.error}</Text>
              ) : content.data ? (
                <Text className="font-mono text-sm text-foreground">{content.data.body}</Text>
              ) : null}

              {selectedManagementActions.length > 0 ? (
                <View className="flex-row flex-wrap gap-4 pt-1">
                  {selectedManagementActions.map((action) => {
                    const needsContent =
                      action === "create-project-override" ||
                      action === "edit-project-override" ||
                      action === "edit-environment";
                    const label =
                      action === "create-project-override"
                        ? "Override for project"
                        : action === "disable-project"
                          ? "Disable for project"
                          : action === "disable-environment"
                            ? "Disable for environment"
                            : action === "restore-environment"
                              ? "Enable for environment"
                              : action === "reset-project"
                                ? selected.projectState === "invalid" ||
                                  selected.projectState === "orphan"
                                  ? "Reset project state"
                                  : "Use inherited version"
                                : action === "edit-project-override"
                                  ? "Edit project override"
                                  : action === "edit-environment"
                                    ? "Edit"
                                    : "Delete";
                    return (
                      <Pressable
                        key={action}
                        accessibilityRole="button"
                        disabled={
                          (needsContent && !content.data) ||
                          ((action === "disable-environment" || action === "restore-environment") &&
                            !selected.id)
                        }
                        onPress={() => {
                          if (action === "create-project-override") {
                            startEdit("override", selected);
                          } else if (action === "disable-project") {
                            runProjectStateMutation(selected, "disable");
                          } else if (action === "disable-environment") {
                            runEnvironmentSetEnabled(selected, false);
                          } else if (action === "restore-environment") {
                            runEnvironmentSetEnabled(selected, true);
                          } else if (action === "reset-project") {
                            runProjectStateMutation(selected, "reset");
                          } else if (
                            action === "edit-project-override" ||
                            action === "edit-environment"
                          ) {
                            startEdit("edit", selected);
                          } else {
                            runEnvironmentDelete(selected);
                          }
                        }}
                      >
                        <Text
                          className={`text-sm ${action === "delete-environment" ? "text-destructive" : "text-accent"}`}
                        >
                          {label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>
          </SettingsSection>
        ) : null}

        {form ? (
          <SettingsSection
            title={form.operation === "create" ? "New resource" : "Edit resource"}
            card
          >
            <View className="gap-4 p-4">
              {form.operation === "create" ? (
                <View className="flex-row gap-2">
                  <KindChoice
                    kind="command"
                    selected={form.kind === "command"}
                    onPress={() => setForm({ ...form, kind: "command" })}
                  />
                  <KindChoice
                    kind="snippet"
                    selected={form.kind === "snippet"}
                    onPress={() => setForm({ ...form, kind: "snippet" })}
                  />
                </View>
              ) : (
                <Text className="text-sm text-foreground-muted">
                  {form.kind === "command" ? "Command" : "Snippet"}
                </Text>
              )}
              <FormField
                label="Key"
                value={form.key}
                editable={form.operation === "create"}
                onChangeText={(key) => setForm({ ...form, key })}
              />
              <Text className="-mt-2 text-xs text-foreground-tertiary">
                Use lowercase letters, numbers, and hyphens. Commands are typed as /key; snippets as
                :key.
              </Text>
              <FormField
                label="Name (optional)"
                value={form.name}
                onChangeText={(name) => setForm({ ...form, name })}
              />
              <FormField
                label="Text"
                value={form.body}
                multiline
                onChangeText={(body) => setForm({ ...form, body })}
              />
              {form.kind === "command" ? (
                <Text className="text-xs text-foreground-muted">
                  Use $ARGUMENTS where the command's typed argument should go. Without it, the
                  argument follows the template.
                </Text>
              ) : null}
              <View className="flex-row gap-5 pt-1">
                <Pressable accessibilityRole="button" disabled={!canSubmit} onPress={submitForm}>
                  <Text
                    className={`text-sm ${canSubmit ? "text-accent" : "text-foreground-tertiary"}`}
                  >
                    Save
                  </Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => setForm(null)}>
                  <Text className="text-sm text-foreground-muted">Cancel</Text>
                </Pressable>
              </View>
            </View>
          </SettingsSection>
        ) : null}
      </ScrollView>
    </View>
  );
}
