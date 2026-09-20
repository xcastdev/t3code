import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  type DesktopWslState,
  type EnvironmentId,
  type ProjectIconOverride,
  CommandId,
} from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { DownloadIcon, FolderSyncIcon, ListTodoIcon, Trash2Icon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useAtomValue } from "@effect/atom-react";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../../connection/useDesktopLocalBootstraps";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import {
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { projectWorkEnvironment } from "../../state/projectWork";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { ProjectMcpSettings } from "./ProjectMcpSettings";
import {
  projectGroupTitleNeedsUpdate,
  resolveProjectPickerRouting,
  type ProjectPickerEnvironmentKind,
} from "./ProjectSettingsPanel.logic";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { useScopedSettings } from "./useScopedSettings";

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

function memberKey(member: { environmentId: string; id: string }): string {
  return `${member.environmentId}:${member.id}`;
}

function safeDownloadName(value: string): string {
  const normalized = value.trim().replace(/[^a-z0-9._-]+/gi, "-");
  return normalized.length > 0 ? normalized.slice(0, 80) : "project-work";
}

function downloadTextFile(filename: string, contents: string, type: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export type ProjectSettingsCategory = "general" | "integrations" | "source-control";

export function ProjectSettingsPanel({
  projectKey,
  environmentId = null,
  checkoutKey = null,
}: {
  projectKey: string;
  environmentId?: EnvironmentId | null;
  checkoutKey?: string | null;
}) {
  const groups = useSettingsProjectGroups();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });

  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;
  const members = useMemo(
    () =>
      selected?.memberProjects.filter(
        (member) =>
          (environmentId === null || member.environmentId === environmentId) &&
          (checkoutKey === null || member.physicalProjectKey === checkoutKey),
      ) ?? [],
    [selected, environmentId, checkoutKey],
  );

  // Remember the members of the last rendered group so a grouping-rule change
  // (which changes the group key) can follow the project to its new group.
  const lastSelectionRef = useRef<{
    key: string;
    environmentId: EnvironmentId | null;
    checkoutKey: string | null;
    memberKeys: string[];
  } | null>(null);
  useEffect(() => {
    if (!selected || members.length === 0) return;
    lastSelectionRef.current = {
      key: selected.projectKey,
      environmentId,
      checkoutKey,
      memberKeys: members.map((member) => member.physicalProjectKey),
    };
  }, [selected, members, environmentId, checkoutKey]);

  // A grouping-rule change replaces the group key mid-visit; follow the
  // project to its new key instead of parking on the not-found state.
  useEffect(() => {
    if (members.length > 0) return;
    const last = lastSelectionRef.current;
    if (
      last?.key !== projectKey ||
      last.environmentId !== environmentId ||
      last.checkoutKey !== checkoutKey
    )
      return;
    const successor = groups.find((group) =>
      group.memberProjects.some((member) => last.memberKeys.includes(member.physicalProjectKey)),
    );
    if (successor) {
      void navigate({
        to: pathname,
        search: () => ({
          project: successor.projectKey,
          machine: environmentId ?? undefined,
          checkout: checkoutKey ?? undefined,
        }),
        replace: true,
        hashScrollIntoView: false,
      });
    }
  }, [groups, navigate, pathname, projectKey, members.length, environmentId, checkoutKey]);

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {groups.length === 0
          ? "Add a project from the sidebar to configure it here."
          : "This project is no longer available."}
      </div>
    );
  }
  if (members.length === 0)
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This checkout is no longer available in the selected project and environment.
      </p>
    );
  const scopedGroup = {
    ...selected,
    memberProjects: members,
    environmentId: members[0]!.environmentId,
    id: members[0]!.id,
  };
  return (
    <ProjectDetail
      key={`${selected.projectKey}:${environmentId ?? "all"}:${checkoutKey ?? "all"}`}
      group={scopedGroup}
      hasOtherMembers={members.length < selected.memberProjects.length}
    />
  );
}

function ProjectDetail({
  group,
  hasOtherMembers,
}: {
  group: SidebarProjectSnapshot;
  hasOtherMembers: boolean;
}) {
  const navigate = useNavigate({ from: "/settings" });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const representative =
    group.memberProjects.find(
      (member) => environmentById.get(member.environmentId)?.serverConfig != null,
    ) ?? group.memberProjects[0]!;
  const representativeEnvironment = environmentById.get(representative.environmentId);
  const desktopLocalBootstraps = useDesktopLocalBootstraps();
  const representativeEnvironmentKind: ProjectPickerEnvironmentKind =
    representativeEnvironment?.environmentId === primaryEnvironmentId &&
    representativeEnvironment.entry.target._tag === "PrimaryConnectionTarget"
      ? "primary"
      : representativeEnvironment &&
          isDesktopLocalConnectionTarget(representativeEnvironment.entry.target)
        ? "desktop-local"
        : "remote";
  const canUseDesktopFolderPicker =
    typeof window !== "undefined" && window.desktopBridge !== undefined;
  const pickerRouting = useMemo(
    () =>
      resolveProjectPickerRouting({
        hasDesktopBridge: canUseDesktopFolderPicker,
        environmentId: representative.environmentId,
        primaryEnvironmentId,
        environmentKind: representativeEnvironmentKind,
        displayUrl: representativeEnvironment?.displayUrl ?? null,
        desktopLocalBootstraps,
        wslConfiguration: null,
      }),
    [
      canUseDesktopFolderPicker,
      desktopLocalBootstraps,
      primaryEnvironmentId,
      representative.environmentId,
      representativeEnvironment?.displayUrl,
      representativeEnvironmentKind,
    ],
  );
  const threads = useThreadShells();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const lifecycleArchive = useAtomCommand(projectEnvironment.lifecycleArchive, {
    reportFailure: false,
  });
  const lifecycleRestore = useAtomCommand(projectEnvironment.lifecycleRestore, {
    reportFailure: false,
  });
  const lifecycleRelocationCheck = useAtomCommand(projectEnvironment.lifecycleRelocationCheck, {
    reportFailure: false,
  });
  const lifecyclePermanentDelete = useAtomCommand(projectEnvironment.lifecyclePermanentDelete, {
    reportFailure: false,
  });
  const lifecycleTarget = {
    environmentId: representative.environmentId,
    input: { projectId: representative.id },
  };
  const lifecycleRecord = Option.getOrNull(
    AsyncResult.value(useAtomValue(projectEnvironment.lifecycle(lifecycleTarget))),
  );
  const refreshLifecycle = useAtomQueryRunner(projectEnvironment.lifecycle, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const workSettings = useScopedSettings((settings) => settings.projectWorkEnabled);
  const exportJson = useAtomQueryRunner(projectWorkEnvironment.exportJson, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const exportMarkdown = useAtomQueryRunner(projectWorkEnvironment.exportMarkdown, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const [relinkPath, setRelinkPath] = useState(representative.workspaceRoot);
  const [relinking, setRelinking] = useState(false);
  const [exporting, setExporting] = useState<"json" | "markdown" | null>(null);
  const [lifecycleState, setLifecycleState] = useState<"active" | "archived">("active");
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const projectNameEditedRef = useRef(false);

  useEffect(() => {
    if (lifecycleRecord?.state === "active" || lifecycleRecord?.state === "archived") {
      setLifecycleState(lifecycleRecord.state);
    }
  }, [lifecycleRecord?.state]);

  const faviconPath = representative.faviconPath ?? null;
  const projectIcon = representative.projectIcon ?? null;
  const pickProjectFavicon =
    typeof window !== "undefined" &&
    group.memberProjects.every(
      (member) =>
        member.environmentId === primaryEnvironmentId &&
        canPickExternalProjectFavicon(member.workspaceRoot, navigator.platform),
    )
      ? window.desktopBridge?.pickProjectFavicon
      : undefined;

  const reportFailure = useCallback(<A, E>(title: string, result: AtomCommandResult<A, E>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);

  // Group-shared fields live on each physical project record, so a
  // group-level edit fans out to every member.
  const updateAllMembers = useCallback(
    async (
      input: Partial<{
        title: string;
        faviconPath: string | null;
        projectIcon: ProjectIconOverride | null;
      }>,
      failureTitle: string,
    ): Promise<AtomCommandResult<void, unknown>> => {
      const unavailable = group.memberProjects.find((member) => {
        const environment = environmentById.get(member.environmentId);
        return environment?.connection.phase !== "connected" || !environment.serverConfig;
      });
      if (unavailable) {
        const error = new Error(
          `Connect ${unavailable.environmentLabel ?? "the selected environment"} and try again.`,
        );
        const result: AtomCommandResult<void, unknown> = AsyncResult.failure(Cause.fail(error));
        reportFailure(failureTitle, result);
        return result;
      }
      for (const member of group.memberProjects) {
        const result = mapAtomCommandResult(
          await updateProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, ...input },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          // A partial fan-out is possible: earlier members already took the
          // write. Name the environment so the user knows where it stopped.
          reportFailure(
            group.memberProjects.length > 1
              ? `${failureTitle} on ${member.environmentLabel ?? "the current environment"}`
              : failureTitle,
            result,
          );
          return result;
        }
      }
      return AsyncResult.success(undefined);
    },
    [environmentById, group.memberProjects, reportFailure, updateProject],
  );

  const renameGroup = useCallback(
    async (nextTitle: string, wasEdited: boolean) => {
      const title = nextTitle.trim();
      if (!title) {
        toastManager.add({ type: "warning", title: "Project title cannot be empty" });
        return;
      }
      if (
        !projectGroupTitleNeedsUpdate(
          group.memberProjects.map((member) => member.title),
          title,
          wasEdited,
        )
      ) {
        return;
      }
      await updateAllMembers({ title }, "Failed to rename project");
    },
    [group.memberProjects, updateAllMembers],
  );

  // ----- project icon -----
  const [faviconPickerOpen, setFaviconPickerOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setProjectIcon = useCallback(
    async (input: { faviconPath: string | null; projectIcon: ProjectIconOverride | null }) => {
      if (savingFaviconRef.current) return;
      savingFaviconRef.current = true;
      setIsSavingFavicon(true);
      try {
        await updateAllMembers(input, "Failed to update project icon");
      } finally {
        savingFaviconRef.current = false;
        setIsSavingFavicon(false);
      }
    },
    [updateAllMembers],
  );

  const hasMultipleCheckouts = group.memberProjects.length > 1;

  const relink = useCallback(async () => {
    const workspaceRoot = relinkPath.trim();
    if (!workspaceRoot || workspaceRoot === representative.workspaceRoot) return;
    if (representativeEnvironment?.connection.phase !== "connected") {
      toastManager.add({
        type: "warning",
        title: "Project not relinked",
        description: "Connect this environment before changing its workspace path.",
      });
      return;
    }
    setRelinking(true);
    try {
      const relocation = mapAtomCommandResult(
        await lifecycleRelocationCheck({
          environmentId: representative.environmentId,
          input: {
            projectId: representative.id,
            currentWorkspaceRoot: representative.workspaceRoot,
            candidateWorkspaceRoot: workspaceRoot,
          },
        }),
        (value) => value,
      );
      if (relocation._tag === "Failure") {
        reportFailure("Failed to check the new project path", relocation);
        return;
      }
      if (relocation.value === undefined || !relocation.value.allowed) {
        toastManager.add({
          type: "warning",
          title: "Project not relinked",
          description:
            relocation.value?.reason === "repository-mismatch"
              ? "The selected folder is a different repository."
              : "The selected folder must exist as a different directory.",
        });
        return;
      }
      const result = mapAtomCommandResult(
        await updateProject({
          environmentId: representative.environmentId,
          input: { projectId: representative.id, workspaceRoot },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportFailure("Failed to relink project", result);
        return;
      }
      setRelinkPath(workspaceRoot);
    } finally {
      setRelinking(false);
    }
  }, [
    lifecycleRelocationCheck,
    relinkPath,
    representative,
    representativeEnvironment,
    reportFailure,
    updateProject,
  ]);

  const pickRelinkFolder = useCallback(async () => {
    if (!pickerRouting.canBrowse) return;
    const api = readLocalApi();
    if (!api) return;
    let wslConfiguration: DesktopWslState | null = null;
    const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
    if (
      bridge &&
      representativeEnvironmentKind === "primary" &&
      representativeEnvironment?.serverConfig?.environment.platform.os === "linux"
    ) {
      try {
        wslConfiguration = await bridge.getWslState();
      } catch {
        // Keep the native primary picker fallback used by CommandPalette.
      }
    }
    const routing = resolveProjectPickerRouting({
      hasDesktopBridge: bridge !== undefined,
      environmentId: representative.environmentId,
      primaryEnvironmentId,
      environmentKind: representativeEnvironmentKind,
      displayUrl: representativeEnvironment?.displayUrl ?? null,
      desktopLocalBootstraps,
      wslConfiguration,
    });
    if (!routing.canBrowse) return;
    const picked = await api.dialogs.pickFolder({
      ...(relinkPath.trim().length > 0 ? { initialPath: relinkPath } : {}),
      ...(routing.targetEnvironmentId ? { targetEnvironmentId: routing.targetEnvironmentId } : {}),
    });
    if (picked) setRelinkPath(picked);
  }, [
    desktopLocalBootstraps,
    pickerRouting.canBrowse,
    primaryEnvironmentId,
    relinkPath,
    representative.environmentId,
    representativeEnvironment,
    representativeEnvironmentKind,
  ]);

  const runExport = useCallback(
    async (format: "json" | "markdown") => {
      if (representativeEnvironment?.connection.phase !== "connected") {
        toastManager.add({
          type: "warning",
          title: "Export unavailable",
          description: "Connect this environment before exporting project work.",
        });
        return;
      }
      setExporting(format);
      try {
        const target = {
          environmentId: representative.environmentId,
          projectId: representative.id,
        };
        const result = await (format === "json" ? exportJson(target) : exportMarkdown(target));
        if (result._tag === "Failure") {
          reportFailure(`Failed to export ${format}`, result);
          return;
        }
        const value = result.value;
        if (format === "markdown" && typeof value === "object" && value !== null) {
          const contents = (value as { contents?: unknown }).contents;
          if (typeof contents === "string") {
            downloadTextFile(
              `${safeDownloadName(group.displayName)}-work.md`,
              contents,
              "text/markdown;charset=utf-8",
            );
            return;
          }
        }
        downloadTextFile(
          `${safeDownloadName(group.displayName)}-work.json`,
          JSON.stringify(value, null, 2),
          "application/json;charset=utf-8",
        );
      } finally {
        setExporting(null);
      }
    },
    [
      exportJson,
      exportMarkdown,
      group.displayName,
      representative,
      representativeEnvironment,
      reportFailure,
    ],
  );

  const removeMembers = useCallback(
    async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
      const api = readLocalApi();
      if (!api) return;

      const memberKeys = new Set(members.map(memberKey));
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      );
      const isWholeGroup = members.length === group.memberProjects.length;
      const targetKind = hasOtherMembers || !isWholeGroup ? "checkout" : "project";
      const singleMember = members.length === 1 ? members[0]! : null;
      const targetLabel = singleMember?.title ?? group.displayName;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            projectThreads.length > 0
              ? `Permanently delete ${targetKind} "${targetLabel}" and delete its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}?`
              : `Permanently delete ${targetKind} "${targetLabel}"?`,
            ...(singleMember
              ? [
                  `Path: ${singleMember.workspaceRoot}`,
                  ...(singleMember.environmentLabel
                    ? [`Environment: ${singleMember.environmentLabel}`]
                    : []),
                ]
              : [`This removes ${members.length} grouped project entries.`]),
            ...(projectThreads.length > 0
              ? [
                  "This permanently clears conversation history for those threads and any archived threads.",
                ]
              : ["This permanently clears any archived conversation history."]),
            isWholeGroup && !hasOtherMembers
              ? "This removes only the project entries, not the files on disk."
              : "Other entries in this grouped project are unaffected.",
            "This action cannot be undone.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      const draftStore = useComposerDraftStore.getState();
      for (const member of members) {
        const memberThreads = projectThreads.filter(
          (thread) =>
            thread.environmentId === member.environmentId && thread.projectId === member.id,
        );
        const lifecycleResult = mapAtomCommandResult(
          await lifecyclePermanentDelete({
            environmentId: member.environmentId,
            input: {
              commandId: CommandId.make(`project-delete-${randomUUID()}`),
              projectId: member.id,
              workspaceRoot: member.workspaceRoot,
              confirmation: "permanent-local-delete",
            },
          }),
          () => undefined,
        );
        if (lifecycleResult._tag === "Failure") {
          reportFailure(`Failed to clear local work for "${member.title}"`, lifecycleResult);
          return;
        }
        // Keep the legacy project tombstone in sync after the lifecycle
        // tombstone is committed. The projection still exists at this point,
        // so old clients continue to receive their expected delete event.
        const result = mapAtomCommandResult(
          await deleteProject({
            environmentId: member.environmentId,
            input: {
              projectId: member.id,
              force: true,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          reportFailure(`Failed to remove "${member.title}"`, result);
          return;
        }
        const projectRef = scopeProjectRef(member.environmentId, member.id);
        releaseProjectDraftUploads(
          projectRef,
          memberThreads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
        );
        const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
        if (projectDraftThread) {
          draftStore.clearDraftThread(projectDraftThread.draftId);
        }
        draftStore.clearProjectDraftThreadId(projectRef);
      }

      if (isWholeGroup && !hasOtherMembers) {
        void navigate({ to: "/", replace: true });
      }
    },
    [
      deleteProject,
      lifecyclePermanentDelete,
      group.displayName,
      group.memberProjects.length,
      hasOtherMembers,
      navigate,
      reportFailure,
      threads,
    ],
  );

  const checkoutChoices = (
    <SettingsSection title="Checkouts">
      {group.memberProjects.map((member) => (
        <SettingsRow
          key={member.physicalProjectKey}
          title={member.environmentLabel ?? "Environment"}
          description={member.workspaceRoot}
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void removeMembers([member])}
              aria-label={`Remove checkout ${member.workspaceRoot}`}
            >
              Remove
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );

  const canExportWork = workSettings && representativeEnvironment?.connection.phase === "connected";

  const changeLifecycleState = useCallback(async () => {
    if (representativeEnvironment?.connection.phase !== "connected" || lifecycleBusy) return;
    setLifecycleBusy(true);
    try {
      const commandId = CommandId.make(`project-lifecycle-${randomUUID()}`);
      const result =
        lifecycleState === "active"
          ? await lifecycleArchive({
              environmentId: representative.environmentId,
              input: { commandId, projectId: representative.id },
            })
          : await lifecycleRestore({
              environmentId: representative.environmentId,
              input: { commandId, projectId: representative.id },
            });
      const mapped = mapAtomCommandResult(result, () => undefined);
      if (mapped._tag === "Failure") {
        reportFailure(
          lifecycleState === "active" ? "Failed to archive project" : "Failed to restore project",
          mapped,
        );
        return;
      }
      setLifecycleState(lifecycleState === "active" ? "archived" : "active");
      void refreshLifecycle(lifecycleTarget);
    } finally {
      setLifecycleBusy(false);
    }
  }, [
    lifecycleArchive,
    lifecycleBusy,
    lifecycleRestore,
    lifecycleState,
    lifecycleTarget,
    representative,
    representativeEnvironment,
    reportFailure,
    refreshLifecycle,
  ]);

  return (
    <>
      <SettingsPageContainer className="gap-6">
        <SettingsSection id="project-overview" title="Project" hideTitle>
          <SettingsRow
            title="Name"
            description="The shared name for this project group in the sidebar and thread lists."
            control={
              <Input
                key={`${group.projectKey}:${group.displayName}`}
                size="sm"
                className="w-full sm:w-64"
                aria-label="Project name"
                defaultValue={group.displayName}
                onChange={() => {
                  projectNameEditedRef.current = true;
                }}
                onBlur={(event) => {
                  const wasEdited = projectNameEditedRef.current;
                  projectNameEditedRef.current = false;
                  void renameGroup(event.currentTarget.value, wasEdited);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title="Project icon"
            description={
              projectIcon?.kind === "lucide"
                ? `${projectIcon.name} · ${projectIcon.color}`
                : projectIcon?.kind === "emoji"
                  ? projectIcon.emoji
                  : (faviconPath ?? "Automatic")
            }
            resetAction={
              group.memberProjects.some(
                (member) => member.faviconPath != null || member.projectIcon != null,
              ) ? (
                <SettingResetButton
                  label="project icon"
                  disabled={isSavingFavicon}
                  onClick={() => void setProjectIcon({ faviconPath: null, projectIcon: null })}
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <ProjectFavicon project={representative} className="size-6" />
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon"
                  disabled={isSavingFavicon}
                  onClick={() => setIconPickerOpen(true)}
                >
                  Choose icon
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon file"
                  disabled={isSavingFavicon}
                  onClick={() => setFaviconPickerOpen(true)}
                >
                  Choose file
                </Button>
              </div>
            }
          />
        </SettingsSection>
        <ProjectActionsSettings />
        <SettingsSection id="project-work" title="Work" icon={<ListTodoIcon className="size-4" />}>
          <SettingsRow
            title={lifecycleState === "active" ? "Archive project" : "Restore project"}
            description={
              lifecycleState === "active"
                ? "Hide this project from active work while retaining its history and identity."
                : "Return this archived project to active work."
            }
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() => void changeLifecycleState()}
                disabled={
                  lifecycleBusy || representativeEnvironment?.connection.phase !== "connected"
                }
              >
                {lifecycleState === "active" ? "Archive" : "Restore"}
              </Button>
            }
          />
          <SettingsRow
            title="Workspace path"
            description="Relink this project when its checkout moved. This updates the project entry, not files on disk."
            control={
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:max-w-[34rem] sm:flex-nowrap">
                <Input
                  size="sm"
                  className="min-w-48 flex-1 sm:w-64"
                  value={relinkPath}
                  onChange={(event) => setRelinkPath(event.currentTarget.value)}
                  aria-label="Project workspace path"
                />
                {pickerRouting.canBrowse ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void pickRelinkFolder()}
                    disabled={relinking}
                  >
                    <FolderSyncIcon />
                    Browse
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void relink()}
                  disabled={
                    relinking ||
                    relinkPath.trim().length === 0 ||
                    relinkPath.trim() === representative.workspaceRoot
                  }
                >
                  Relink
                </Button>
              </div>
            }
          />
          <SettingsRow
            title="Export project work"
            description={
              workSettings
                ? "Download a JSON backup or a non-authoritative Markdown brief of this project's durable work."
                : "Enable Project Work in General settings before exporting durable tasks and knowledge."
            }
            control={
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void runExport("json")}
                  disabled={!canExportWork || exporting !== null}
                >
                  <DownloadIcon />
                  JSON
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void runExport("markdown")}
                  disabled={!canExportWork || exporting !== null}
                >
                  <DownloadIcon />
                  Markdown
                </Button>
              </div>
            }
          />
        </SettingsSection>
        {hasMultipleCheckouts ? checkoutChoices : null}
        <ProjectMcpSettings
          environmentId={representative.environmentId}
          projectId={representative.id}
        />
        <SettingsSection title="Danger">
          <SettingsRow
            title={
              hasOtherMembers
                ? "Permanently delete checkout"
                : group.memberProjects.length > 1
                  ? "Permanently delete this project everywhere"
                  : "Permanently delete project"
            }
            description={
              hasOtherMembers
                ? "Deletes the selected machine's checkout entries and their threads. Other machines and files on disk are not touched."
                : group.memberProjects.length > 1
                  ? `Deletes all ${group.memberProjects.length} checkout entries and their threads on every machine. Files on disk are not touched.`
                  : "Deletes the project entry and its threads. Files on disk are not touched."
            }
            control={
              <Button
                size="sm"
                variant="destructive-outline"
                onClick={() => void removeMembers(group.memberProjects)}
              >
                <Trash2Icon />
                {hasOtherMembers
                  ? "Delete checkout permanently"
                  : group.memberProjects.length > 1
                    ? "Delete all entries permanently"
                    : "Delete project permanently"}
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>

      <ProjectFaviconPickerDialog
        key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
        cwd={representative.workspaceRoot}
        environmentId={representative.environmentId}
        onOpenChange={setFaviconPickerOpen}
        {...(pickProjectFavicon
          ? { onPickExternal: () => pickProjectFavicon(representative.workspaceRoot) }
          : {})}
        onSelect={(path) => void setProjectIcon({ faviconPath: path, projectIcon: null })}
        open={faviconPickerOpen}
        projectName={group.displayName}
      />
      {iconPickerOpen ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={projectIcon}
            open
            onOpenChange={setIconPickerOpen}
            onSelect={(icon) => void setProjectIcon({ faviconPath: null, projectIcon: icon })}
          />
        </Suspense>
      ) : null}
    </>
  );
}
