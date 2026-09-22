import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useEffect, useMemo, useState } from "react";

import type { EnvironmentId, ProjectId, SkillCatalogSummary } from "@t3tools/contracts";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { skillsEnvironment } from "../../state/skills";
import { useProjects } from "../../state/entities";
import { SettingsSection } from "../settings/components/SettingsSection";
import { mobileSkillSubtitle } from "./skillCatalog";

function SkillChanges({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId;
}) {
  useAtomValue(
    skillsEnvironment.changes({
      environmentId,
      input: projectId ? { projectId } : {},
    }),
  );
  return null;
}

function SkillDetail({
  environmentId,
  projectId,
  entry,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly entry: SkillCatalogSummary;
}) {
  const managed = useEnvironmentQuery(
    entry.origin === "managed"
      ? skillsEnvironment.content({
          environmentId,
          input: { skillId: entry.id, ...(projectId ? { projectId } : {}) },
        })
      : null,
  );
  const native = useEnvironmentQuery(
    entry.origin === "native"
      ? skillsEnvironment.nativeContent({
          environmentId,
          input: { observationId: entry.id, maxBytes: 64 * 1024 },
        })
      : null,
  );
  const body = managed.data?.content.body ?? native.data?.content;
  return (
    <View className="gap-3 p-4">
      <Text className="text-lg font-t3-semibold text-foreground">{entry.name}</Text>
      <Text className="text-sm text-foreground-muted">{mobileSkillSubtitle(entry)}</Text>
      <Text className="text-sm text-foreground-muted">
        {entry.origin === "managed"
          ? "This definition is owned by T3. Editing and package authoring are available on web and desktop."
          : "This definition is owned by the provider and is read-only in T3."}
      </Text>
      {entry.application ? (
        <Text className="text-sm text-foreground">
          Delivery: {entry.application.status.replaceAll("_", " ")}
        </Text>
      ) : null}
      {entry.application?.failure ? (
        <Text className="text-sm text-destructive">{entry.application.failure.message}</Text>
      ) : null}
      {entry.conflict ? (
        <Text className="text-sm text-foreground-muted">{entry.conflict.message}</Text>
      ) : null}
      {entry.compatibility.map((compatibility) => (
        <Text key={compatibility.providerInstanceId} className="text-sm text-foreground-muted">
          {compatibility.providerInstanceId}: {compatibility.support.replaceAll("_", " ")}
          {compatibility.reasons.map((reason) => ` · ${reason.message}`).join("")}
        </Text>
      ))}
      {native.data ? (
        <Text className="text-xs text-foreground-muted">
          {native.data.provenance} · {native.data.observation.freshness}
          {native.data.truncated ? " · Preview truncated to 64 KiB" : ""}
        </Text>
      ) : null}
      {body ? <Text className="font-mono text-sm text-foreground">{body}</Text> : null}
      {(managed.error ?? native.error) ? (
        <Text className="text-sm text-destructive">Could not load skill details.</Text>
      ) : null}
    </View>
  );
}

export function SettingsSkillsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(
    environments[0]?.environmentId ?? null,
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  useEffect(() => {
    if (environment !== undefined) return;
    setEnvironmentId(environments[0]?.environmentId ?? null);
    setProjectId(null);
  }, [environment, environments]);
  useEffect(() => {
    if (projectId === null || environmentProjects.some((project) => project.id === projectId))
      return;
    setProjectId(null);
  }, [environmentProjects, projectId]);
  const catalog = useEnvironmentQuery(
    environment
      ? skillsEnvironment.catalog({
          environmentId: environment.environmentId,
          input: projectId ? { projectId } : {},
        })
      : null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = catalog.data?.entries.find((entry) => entry.id === selectedId) ?? null;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Skills" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      {environment ? (
        <SkillChanges
          environmentId={environment.environmentId}
          {...(projectId ? { projectId } : {})}
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
          <Text className="text-xl font-t3-semibold text-foreground">Portable skills</Text>
          <Text className="text-sm text-foreground-muted">
            Catalog and session delivery state from{" "}
            {environment?.label ?? "a connected environment"}.
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
                setSelectedId(null);
              }}
              className="border-b border-border-subtle p-4 last:border-b-0"
            >
              <Text className="text-base text-foreground">{candidate.label}</Text>
              {candidate.environmentId === environmentId ? (
                <Text className="text-sm text-accent">Selected</Text>
              ) : null}
            </Pressable>
          ))}
        </SettingsSection>
        {environmentProjects.length > 0 ? (
          <SettingsSection title="Scope" card>
            <Pressable
              accessibilityRole="button"
              onPress={() => setProjectId(null)}
              className="border-b border-border-subtle p-4"
            >
              <Text className="text-base text-foreground">Environment defaults</Text>
            </Pressable>
            {environmentProjects.map((project) => (
              <Pressable
                key={project.id}
                accessibilityRole="button"
                onPress={() => {
                  setProjectId(project.id);
                  setSelectedId(null);
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
        <SettingsSection title="Catalog" card>
          {catalog.isPending ? (
            <Text className="p-4 text-foreground-muted">Reading catalog…</Text>
          ) : null}
          {catalog.error ? <Text className="p-4 text-destructive">{catalog.error}</Text> : null}
          {catalog.data?.nativeDiscoveries
            ?.filter((discovery) => discovery.freshness !== "fresh" || discovery.discoveryError)
            .map((discovery) => (
              <Text
                key={discovery.providerInstanceId}
                className="border-b border-border-subtle p-4 text-xs text-foreground-muted"
              >
                {discovery.providerInstanceId} · Native discovery {discovery.freshness}
                {discovery.discoveryError ? `: ${discovery.discoveryError.message}` : ""}
              </Text>
            ))}
          {catalog.data?.diagnostics?.map((diagnostic) => (
            <View
              key={`${diagnostic.scope}:${diagnostic.scopeId}:${diagnostic.name}`}
              className="gap-1 border-b border-border-subtle p-4"
            >
              <Text className="text-sm font-t3-medium text-destructive">
                {diagnostic.name} · Unavailable
              </Text>
              <Text className="text-xs text-foreground-muted">
                {diagnostic.scope === "global" ? "Environment skill" : "Project skill"}
              </Text>
              {diagnostic.reasons.map((reason) => (
                <Text
                  key={`${reason.code}:${reason.message}`}
                  className="text-xs text-foreground-muted"
                >
                  {reason.message}
                </Text>
              ))}
            </View>
          ))}
          {catalog.data?.entries.map((entry) => (
            <Pressable
              key={entry.id}
              accessibilityRole="button"
              onPress={() => setSelectedId(entry.id === selectedId ? null : entry.id)}
              className="border-b border-border-subtle p-4 last:border-b-0"
            >
              <Text className="text-base font-t3-medium text-foreground">{entry.name}</Text>
              <Text className="mt-1 text-sm text-foreground-muted">
                {mobileSkillSubtitle(entry)}
              </Text>
            </Pressable>
          ))}
          {catalog.data?.entries.length === 0 ? (
            <Text className="p-4 text-foreground-muted">
              {catalog.data.diagnostics?.length
                ? "No valid skill definitions were found."
                : "No skills were found."}
            </Text>
          ) : null}
        </SettingsSection>
        {environment && selected ? (
          <SettingsSection title="Detail" card>
            <SkillDetail
              environmentId={environment.environmentId}
              {...(projectId ? { projectId } : {})}
              entry={selected}
            />
          </SettingsSection>
        ) : null}
      </ScrollView>
    </View>
  );
}
