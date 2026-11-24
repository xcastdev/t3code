import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  mcpApplicationSummary,
  mcpCatalogDestinationView,
  mcpSessionToggleOperation,
  type McpCatalogRow,
} from "@t3tools/client-runtime/mcp-catalog-forms";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { COMPACT_COMMAND_PATTERN } from "@t3tools/client-runtime/state/context-window";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  McpCatalogOverrideId,
  MessageId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProviderSlashCommandsForCwd } from "@t3tools/client-runtime/providerSkills";
import { markFailedAgentsSeen } from "@t3tools/client-runtime/state/thread-details";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { composerModelDisplay } from "../../components/ComposerModelControl";
import { buildModelOptions, serverConfigForCwd } from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useThreadReportedModelSelection } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { mcpCatalogEnvironment } from "../../state/resources";
import { useEnvironmentScope } from "../../state/session";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { enqueueThreadOutboxMessage, threadOutboxManager } from "../../state/thread-outbox";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import type { Preferences } from "../../persistence/mobile-preferences";
import type { ThreadDetailsCollapse } from "./ThreadLiveDetailsSection";
import {
  compactUnavailableReason,
  isThreadDetailsSectionCollapsed,
  toggleThreadDetailsSection,
  type ThreadLiveDetailsSection,
} from "./threadLiveDetails.logic";

export interface LiveDetailsTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const NO_ENTRIES: ReadonlyArray<string> = [];

function usePreferenceList(key: "threadDetailsCollapsedSections" | "seenFailedAgents") {
  return useAtomValue(mobilePreferencesAtom, (result) =>
    AsyncResult.isSuccess(result) ? (result.value[key] ?? NO_ENTRIES) : NO_ENTRIES,
  );
}

/** Folded sections persist across threads; the one the live bar opened starts open. */
export function useThreadDetailsCollapse(
  opened: ThreadLiveDetailsSection | undefined,
): ThreadDetailsCollapse {
  const collapsed = usePreferenceList("threadDetailsCollapsedSections");
  const update = useAtomCommand(saveMobilePreferences);
  const [openedSection, setOpenedSection] = useState(opened ?? null);
  return {
    isCollapsed: (id) => isThreadDetailsSectionCollapsed({ id, collapsed, opened: openedSection }),
    toggle: (id) => {
      const wasCollapsed = isThreadDetailsSectionCollapsed({
        id,
        collapsed,
        opened: openedSection,
      });
      if (id === openedSection) setOpenedSection(null);
      void update({
        transform: (current: Preferences) => ({
          threadDetailsCollapsedSections: toggleThreadDetailsSection(
            current.threadDetailsCollapsedSections ?? NO_ENTRIES,
            id,
            wasCollapsed,
          ),
        }),
      });
    },
  };
}

/** Failed agents seen on this device, by opening one or dismissing the failed badge. */
export function useSeenFailedAgents() {
  const seen = usePreferenceList("seenFailedAgents");
  const update = useAtomCommand(saveMobilePreferences);
  return {
    seen,
    markSeen: (keys: ReadonlyArray<string>) => {
      if (keys.length === 0) return;
      void update({
        transform: (current: Preferences) => ({
          seenFailedAgents: markFailedAgentsSeen(current.seenFailedAgents ?? NO_ENTRIES, keys),
        }),
      });
    },
  };
}

/** What the composer's model button shows for this thread: model, provider and effort. */
export function useThreadModelDisplay(target: LiveDetailsTarget) {
  const shell = useThreadShell(target);
  const serverConfig = useEnvironmentServerConfig(target.environmentId);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const reportedSelection = useThreadReportedModelSelection(
    scopeThreadRef(target.environmentId, target.threadId),
  );
  if (shell === null) return null;
  const selection = shell.modelSelection;
  const modelOption =
    buildModelOptions(
      serverConfigForCwd(serverConfig, selectedThreadCwd),
      selection,
      selection.instanceId,
      shell.projectId,
    ).find(
      (option) =>
        option.selection.instanceId === selection.instanceId &&
        option.selection.model === selection.model,
    ) ?? null;
  const provider = serverConfig?.providers.find(
    (entry) => entry.instanceId === selection.instanceId,
  );
  return {
    ...composerModelDisplay({
      modelOption,
      selection,
      provider: provider?.driver,
      reportedSelection,
      prompt: "",
    }),
    providerDriver: modelOption?.providerDriver ?? provider?.driver,
    providerIconUrl: modelOption?.providerIconUrl,
  };
}

export function useThreadShell(target: LiveDetailsTarget) {
  return useAtomValue(
    environmentThreadShells.threadShellAtom(scopeThreadRef(target.environmentId, target.threadId)),
  );
}

/** Stop for the thread's turn and its background work: the interrupt the thread screen sends. */
export function useInterruptThread(target: LiveDetailsTarget) {
  const canOperate = useEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope);
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    if (stopping || !canOperate) return;
    setStopping(true);
    const result = await interrupt({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    }).finally(() => setStopping(false));
    if (result._tag === "Failure") Dialog.alert("Could not stop", "Try again.");
  };
  return { canStop: canOperate, stopping, stop };
}

/**
 * Sends `/compact` as the composer does: a queued thread message the server runs as the
 * provider's compaction.
 */
export function useCompactThread(target: LiveDetailsTarget) {
  const shell = useThreadShell(target);
  const canOperate = useEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope);
  const serverConfig = useEnvironmentServerConfig(target.environmentId);
  const threadKey = scopedThreadKey(target.environmentId, target.threadId);
  const compactQueued = useAtomValue(
    threadOutboxManager.queuedMessagesByThreadKeyAtom,
    (byThread) =>
      byThread[threadKey]?.some((message) => COMPACT_COMMAND_PATTERN.test(message.text.trim())) ??
      false,
  );
  const [sending, setSending] = useState(false);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const instanceId = shell?.modelSelection.instanceId;
  const provider = serverConfig?.providers.find((entry) => entry.instanceId === instanceId);
  // Catalog digests leave a per-workspace provider's base slash commands empty; read the cwd's.
  const providerSupportsCompact =
    provider !== undefined &&
    resolveProviderSlashCommandsForCwd(provider, selectedThreadCwd).some(
      (command) => command.name === "compact",
    );
  const unavailableReason = compactUnavailableReason({
    canOperate,
    providerSupportsCompact,
    busy:
      threadRuntimeIsActive(shell?.runtime ?? null) ||
      shell?.hasPendingApprovals === true ||
      shell?.hasPendingUserInput === true,
    compactQueued: compactQueued || sending,
  });
  const compact = async () => {
    if (unavailableReason !== null) return;
    setSending(true);
    const metadata = makeQueuedMessageMetadata();
    await enqueueThreadOutboxMessage({
      environmentId: target.environmentId,
      threadId: target.threadId,
      messageId: MessageId.make(metadata.messageId),
      commandId: CommandId.make(metadata.commandId),
      text: "/compact",
      attachments: [],
      createdAt: metadata.createdAt,
    })
      .catch((error: unknown) =>
        Dialog.alert(
          "Could not compact",
          error instanceof Error ? error.message : "Failed to queue /compact.",
        ),
      )
      .finally(() => setSending(false));
  };
  return { unavailableReason, compact };
}

/**
 * The thread's MCP servers and a switch for each. Switches write the thread's session overlay,
 * the same write Settings makes for "this thread", so they need the thread to have run.
 */
export function useThreadMcpServers(target: LiveDetailsTarget, projectId: ProjectId | null) {
  const { environmentId } = target;
  const global = useEnvironmentQuery(
    mcpCatalogEnvironment.read({
      environmentId,
      input: { scope: "global", scopeId: environmentId },
    }),
  );
  const project = useEnvironmentQuery(
    projectId === null
      ? null
      : mcpCatalogEnvironment.read({
          environmentId,
          input: { scope: "project", scopeId: projectId },
        }),
  );
  const threadSession = useEnvironmentQuery(
    mcpCatalogEnvironment.sessionForThread({
      environmentId,
      input: { threadId: target.threadId },
    }),
  );
  const snapshot = threadSession.data?.snapshot ?? null;
  const session = useEnvironmentQuery(
    snapshot === null
      ? null
      : mcpCatalogEnvironment.read({
          environmentId,
          input: { scope: "session", scopeId: snapshot.catalogSessionId },
        }),
  );
  const view = useMemo(
    () =>
      mcpCatalogDestinationView({
        environmentId,
        projectId,
        threadId: target.threadId,
        global: global.data,
        project: project.data,
        snapshot,
        session: session.data,
      }),
    [environmentId, projectId, target.threadId, global.data, project.data, snapshot, session.data],
  );
  const canWrite = useAtomValue(mcpCatalogEnvironment.write.permissionAtom(environmentId));
  const write = useAtomCommand(mcpCatalogEnvironment.write, { reportFailure: false });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const sessionScope = view?.scope?.scope === "session" ? view.scope : null;
  const revision = session.data?.revision ?? null;
  const writable = canWrite && sessionScope !== null && revision !== null;

  const toggle = async (row: McpCatalogRow) => {
    if (!writable || busyKey !== null || sessionScope === null || revision === null) return;
    const operation = mcpSessionToggleOperation({
      sessionId: sessionScope.scopeId,
      row,
      newOverrideId: McpCatalogOverrideId.make(uuidv4()),
    });
    if (!operation.ok) {
      Dialog.alert("Could not change server", operation.error);
      return;
    }
    setBusyKey(row.definition.definitionId);
    const result = await write({
      environmentId,
      input: { ...sessionScope, expectedRevision: revision, operation: operation.value },
    }).finally(() => setBusyKey(null));
    session.refresh();
    if (result._tag === "Failure") Dialog.alert("Could not change server", "Try again.");
  };

  return {
    rows: view?.rows ?? null,
    writable,
    hasSession: sessionScope !== null,
    delivery: snapshot === null ? null : mcpApplicationSummary(snapshot),
    busy: busyKey !== null,
    failed: global.error ?? project.error ?? null,
    toggle,
  };
}
