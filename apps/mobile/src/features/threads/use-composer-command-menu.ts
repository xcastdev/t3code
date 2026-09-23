import type {
  EnvironmentId,
  ManagedTextResourceCatalogListInput,
  ManagedTextResourceSummary,
  ProjectId,
  ProviderInteractionMode,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { COMPOSER_CONTEXT_MAX_RECORDS } from "@t3tools/contracts";
import { Alert } from "react-native";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { issueComposerContext, pullRequestComposerContext } from "../../lib/composerContext";
import { uuidv4 } from "../../lib/uuid";
import {
  getComposerDraftSnapshot,
  readComposerDraftSelection,
  setComposerDraftContext,
} from "../../state/use-composer-drafts";
import { USAGE_LIMITS_COMMAND } from "@t3tools/shared/usageLimits";
import {
  detectComposerTrigger,
  parseComposerHashQuery,
  replaceTextRange,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";
import { parseManagedCommandInvocation } from "@t3tools/client-runtime/managedTextResources";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import {
  dedupeProviderSkillsByName,
  isProviderSkillUserInvocable,
  resolveProviderSkillsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  useComposerPathSearch,
  useComposerPullRequestSearch,
  useDebouncedValue,
} from "../../state/queries";
import { composerPullRequests } from "../../state/pull-requests";
import { managedTextResourcesEnvironment } from "../../state/managedTextResources";
import { useEnvironmentQuery } from "../../state/query";
import { resolveManagedTextResourceInsertion } from "../managedTextResources/managedTextResourceInsertion";
import {
  buildComposerSlashCommandItems,
  buildManagedTextResourceMenuItems,
  managedCommandInvocationNeedsChoice,
  resolveComposerCommandSelection,
  type ComposerCommandItem,
} from "./composer-command-menu-model";

const WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS = 10_000;
const EMPTY_MANAGED_TEXT_RESOURCE_CHANGES = Atom.make(null).pipe(
  Atom.withLabel("mobile:managed-text-resources:changes:empty"),
);

type PendingManagedInsertion = {
  readonly requestId: number;
  readonly resource: ManagedTextResourceSummary;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly expectedDraft: string;
  readonly argument: string;
};

function composerSelectionAtEnd(draftMessage: string): ComposerEditorSelection {
  return { start: draftMessage.length, end: draftMessage.length };
}

/** Shared autocomplete for thread composers and unsent new-task drafts. */
export function useComposerCommandMenu({
  draftMessage,
  ownerKey,
  environmentId,
  projectId = null,
  threadId = null,
  projectCwd,
  pullRequestProjectId = null,
  pullRequestRepository = null,
  selectedProviderStatus,
  hasThread,
  hasCompactableConversation,
  offersUsageLimits = false,
  enabled = true,
  onChangeDraftMessage,
  onUpdateInteractionMode,
  onUsageLimits,
}: {
  readonly draftMessage: string;
  readonly ownerKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly projectId?: ProjectId | null;
  readonly threadId?: ThreadId | null;
  readonly projectCwd: string | null;
  readonly pullRequestProjectId?: ProjectId | null;
  readonly pullRequestRepository?: string | null;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly hasThread: boolean;
  readonly hasCompactableConversation: boolean;
  /** Whether T3 itself offers /usage-limits for the selected provider. */
  readonly offersUsageLimits?: boolean;
  readonly enabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onUpdateInteractionMode?: (mode: ProviderInteractionMode) => void;
  /** Picking /usage-limits is the action itself; the draft keeps nothing of it. */
  readonly onUsageLimits?: () => void;
}) {
  const [selection, setSelection] = useState(() => composerSelectionAtEnd(draftMessage));
  const [pendingManagedInsertion, setPendingManagedInsertion] =
    useState<PendingManagedInsertion | null>(null);
  const [nativeChoice, setNativeChoice] = useState<{
    readonly key: string;
    readonly scope: string;
  } | null>(null);
  const insertionRequestIdRef = useRef(0);
  const handledInsertionRequestRef = useRef(0);
  const previousOwnerKeyRef = useRef(ownerKey);
  const onSelectionChange = useCallback((nextSelection: ComposerEditorSelection) => {
    setSelection(nextSelection);
  }, []);
  useEffect(() => {
    // An insert (attachment, terminal capture, review comment) rewrites the draft and records
    // the caret that belongs after the new chip. Clamping alone would keep the old offset,
    // which sits before it.
    const inserted = ownerKey ? readComposerDraftSelection(ownerKey, draftMessage) : null;
    if (inserted) {
      setSelection((current) =>
        current.start === inserted.start && current.end === inserted.end ? current : inserted,
      );
      return;
    }
    const end = draftMessage.length;
    setSelection((current) => {
      const start = Math.min(current.start, end);
      const selectionEnd = Math.min(current.end, end);
      if (start === current.start && selectionEnd === current.end) {
        return current;
      }
      return { start, end: selectionEnd };
    });
  }, [draftMessage, ownerKey]);
  useEffect(() => {
    if (previousOwnerKeyRef.current === ownerKey) return;
    previousOwnerKeyRef.current = ownerKey;
    setSelection(composerSelectionAtEnd(draftMessage));
  }, [draftMessage, ownerKey]);

  const managedInvocationPrefix = useMemo(() => {
    if (selection.start !== selection.end || selection.end === 0) return null;
    return parseManagedCommandInvocation(draftMessage.slice(0, selection.end));
  }, [draftMessage, selection]);
  const hasManagedInvocationSeparator = useMemo(
    () => /^\/[a-z0-9]+(?:-[a-z0-9]+)*[ \t]/.test(draftMessage.slice(0, selection.end)),
    [draftMessage, selection.end],
  );
  const isArgumentInvocation = managedInvocationPrefix !== null && hasManagedInvocationSeparator;
  const sendInvocation = useMemo(() => parseManagedCommandInvocation(draftMessage), [draftMessage]);
  const detectedTriggerForCatalog =
    enabled && selection.start === selection.end
      ? detectComposerTrigger(draftMessage, selection.end)
      : null;
  const shouldLoadManagedCatalog =
    draftMessage.startsWith("/") ||
    sendInvocation !== null ||
    detectedTriggerForCatalog?.kind === "snippet";
  const managedCatalogScopeKey = `${environmentId ?? ""}:${projectId ?? ""}:${threadId ?? ""}`;
  const nativeChoiceKey = nativeChoice?.scope === managedCatalogScopeKey ? nativeChoice.key : null;

  const managedCatalogTarget = useMemo(
    () =>
      environmentId && shouldLoadManagedCatalog
        ? {
            environmentId,
            input: {
              ...(projectId ? { projectId } : {}),
              ...(threadId ? { threadId } : {}),
            } satisfies ManagedTextResourceCatalogListInput,
          }
        : null,
    [environmentId, projectId, shouldLoadManagedCatalog, threadId],
  );
  const managedCatalog = useEnvironmentQuery(
    useMemo(
      () =>
        managedCatalogTarget ? managedTextResourcesEnvironment.catalog(managedCatalogTarget) : null,
      [managedCatalogTarget],
    ),
  );
  const managedCatalogChangesAtom = useMemo(
    () =>
      managedCatalogTarget
        ? managedTextResourcesEnvironment.changes(managedCatalogTarget)
        : EMPTY_MANAGED_TEXT_RESOURCE_CHANGES,
    [managedCatalogTarget],
  );
  useAtomValue(managedCatalogChangesAtom);
  const managedEntries = managedCatalog.data?.entries ?? [];
  const exactNativeInvocationItems = useMemo(() => {
    if (!managedInvocationPrefix) return [];
    const query = managedInvocationPrefix.key.toLowerCase();
    return buildComposerSlashCommandItems({
      query,
      atMessageStart: true,
      hasThread,
      hasCompactableConversation,
      offersUsageLimits,
      allowInteractionMode: onUpdateInteractionMode !== undefined,
      selectedProviderStatus,
      managedEntries: [],
    }).filter((item) =>
      item.type === "slash-command"
        ? item.command.toLowerCase() === query
        : item.type === "provider-slash-command"
          ? item.command.name.toLowerCase() === query
          : false,
    );
  }, [
    hasThread,
    hasCompactableConversation,
    managedInvocationPrefix,
    onUpdateInteractionMode,
    offersUsageLimits,
    selectedProviderStatus,
  ]);
  const sendNativeInvocationItems = useMemo(() => {
    if (!sendInvocation) return [];
    const query = sendInvocation.key.toLowerCase();
    return buildComposerSlashCommandItems({
      query,
      atMessageStart: true,
      hasThread,
      hasCompactableConversation,
      offersUsageLimits,
      allowInteractionMode: onUpdateInteractionMode !== undefined,
      selectedProviderStatus,
      managedEntries: [],
    }).filter((item) =>
      item.type === "slash-command"
        ? item.command.toLowerCase() === query
        : item.type === "provider-slash-command"
          ? item.command.name.toLowerCase() === query
          : false,
    );
  }, [
    hasThread,
    hasCompactableConversation,
    onUpdateInteractionMode,
    offersUsageLimits,
    selectedProviderStatus,
    sendInvocation,
  ]);
  const unresolvedNativeManagedCollision = Boolean(
    sendInvocation &&
    managedCommandInvocationNeedsChoice({
      key: sendInvocation.key,
      catalogResolved: managedCatalog.data !== null,
      entries: managedEntries,
      nativeItems: sendNativeInvocationItems,
      nativeChoiceKey,
    }),
  );
  const mustResolveManagedCommandSelection = Boolean(
    sendInvocation && environmentId && (!managedCatalog.data || unresolvedNativeManagedCollision),
  );
  const managedCommandBlockReason = !mustResolveManagedCommandSelection
    ? null
    : !managedCatalog.data
      ? managedCatalog.error
        ? "Managed commands could not be checked. Retry before sending this slash command."
        : "Checking managed commands. Wait a moment, then send again."
      : "Choose Managed or Provider native from the command list before sending.";
  const managedContentTarget = useMemo(() => {
    if (!pendingManagedInsertion || !environmentId || !pendingManagedInsertion.resource.id) {
      return null;
    }
    return {
      environmentId,
      input: {
        kind: pendingManagedInsertion.resource.kind,
        id: pendingManagedInsertion.resource.id,
        expectedRevision: pendingManagedInsertion.resource.revision,
        ...(projectId ? { projectId } : {}),
        ...(threadId ? { threadId } : {}),
      },
    };
  }, [environmentId, pendingManagedInsertion, projectId, threadId]);
  const managedContent = useEnvironmentQuery(
    useMemo(
      () =>
        managedContentTarget ? managedTextResourcesEnvironment.content(managedContentTarget) : null,
      [managedContentTarget],
    ),
  );
  useEffect(() => {
    const pending = pendingManagedInsertion;
    if (!pending || handledInsertionRequestRef.current === pending.requestId) return;
    if (managedContent.error) {
      handledInsertionRequestRef.current = pending.requestId;
      setPendingManagedInsertion(null);
      Alert.alert(
        "Could not insert",
        "The selected command or snippet could not be loaded. Select it again.",
      );
      return;
    }
    if (managedCatalog.error && !managedCatalog.data) {
      handledInsertionRequestRef.current = pending.requestId;
      setPendingManagedInsertion(null);
      Alert.alert(
        "Could not verify selection",
        "The catalog changed while loading. Select it again.",
      );
      return;
    }
    if (!managedContent.data || !managedCatalog.data) return;

    handledInsertionRequestRef.current = pending.requestId;
    const result = resolveManagedTextResourceInsertion({
      selected: pending.resource,
      content: managedContent.data,
      currentEntries: managedCatalog.data.entries,
      draft: draftMessage,
      expectedDraft: pending.expectedDraft,
      rangeStart: pending.rangeStart,
      rangeEnd: pending.rangeEnd,
      argument: pending.argument,
    });
    setPendingManagedInsertion(null);
    if (result.status === "draft-changed") {
      Alert.alert("Draft changed", "The draft changed while loading. Select the command again.");
      return;
    }
    if (result.status === "stale-resource") {
      Alert.alert("Definition changed", "The selected definition changed. Select it again.");
      return;
    }
    setNativeChoice(null);
    onChangeDraftMessage(result.text);
    setSelection({ start: result.cursor, end: result.cursor });
  }, [
    draftMessage,
    managedCatalog.data,
    managedCatalog.error,
    managedContent.data,
    managedContent.error,
    onChangeDraftMessage,
    pendingManagedInsertion,
  ]);
  const skills = useMemo(
    () =>
      selectedProviderStatus ? resolveProviderSkillsForCwd(selectedProviderStatus, projectCwd) : [],
    [projectCwd, selectedProviderStatus],
  );
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const selectedProviderInstanceId = selectedProviderStatus?.instanceId;
  const hasWorkspaceSnapshot = Boolean(
    projectCwd &&
    selectedProviderStatus?.workspaceSnapshots?.some((snapshot) => snapshot.cwd === projectCwd),
  );
  const workspaceRefreshKeyRef = useRef<string | null>(null);
  const workspaceRefreshRetryRef = useRef<{ key: string; notBefore: number } | null>(null);
  const hadWorkspaceSnapshotRef = useRef(false);
  useEffect(() => {
    if (hadWorkspaceSnapshotRef.current && !hasWorkspaceSnapshot) {
      workspaceRefreshKeyRef.current = null;
      workspaceRefreshRetryRef.current = null;
    }
    hadWorkspaceSnapshotRef.current = hasWorkspaceSnapshot;
  }, [hasWorkspaceSnapshot]);
  useEffect(() => {
    if (!environmentId || !projectCwd || !selectedProviderInstanceId) return;
    const key = `${environmentId}:${selectedProviderInstanceId}:${projectCwd}`;
    if (workspaceRefreshKeyRef.current === key) return;
    if (hasWorkspaceSnapshot) {
      workspaceRefreshKeyRef.current = key;
      workspaceRefreshRetryRef.current = null;
      return;
    }
    const retry = workspaceRefreshRetryRef.current;
    if (retry?.key === key && Date.now() < retry.notBefore) return;
    workspaceRefreshKeyRef.current = key;
    const retryLater = () => {
      if (workspaceRefreshKeyRef.current !== key) return;
      workspaceRefreshKeyRef.current = null;
      workspaceRefreshRetryRef.current = {
        key,
        notBefore: Date.now() + WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS,
      };
    };
    void refreshProviders({
      environmentId,
      input: { instanceId: selectedProviderInstanceId, cwd: projectCwd },
    }).then((result) => {
      const refreshed =
        result._tag === "Success" &&
        result.value.providers
          .find((provider) => provider.instanceId === selectedProviderInstanceId)
          ?.workspaceSnapshots?.some((snapshot) => snapshot.cwd === projectCwd);
      if (!refreshed && workspaceRefreshKeyRef.current === key) {
        retryLater();
      }
    }, retryLater);
  }, [
    draftMessage,
    environmentId,
    hasWorkspaceSnapshot,
    projectCwd,
    refreshProviders,
    selectedProviderInstanceId,
  ]);

  const trigger = useMemo(() => {
    if (!enabled || selection.start !== selection.end) {
      return null;
    }
    if (isArgumentInvocation && managedInvocationPrefix) {
      return {
        kind: "slash-command",
        query: managedInvocationPrefix.key,
        rangeStart: 0,
        rangeEnd: selection.end,
      } satisfies ComposerTrigger;
    }
    return detectComposerTrigger(draftMessage, selection.end);
  }, [draftMessage, enabled, isArgumentInvocation, managedInvocationPrefix, selection]);
  const pathSearch = useComposerPathSearch({
    environmentId,
    cwd: trigger?.kind === "path" ? projectCwd : null,
    query: trigger?.kind === "path" ? trigger.query : null,
  });
  const hashQuery = parseComposerHashQuery(trigger?.kind === "pull-request" ? trigger.query : "");
  const debouncedIssueQuery = useDebouncedValue(hashQuery.search, 180);
  const issueSearch = useEnvironmentQuery(
    trigger?.kind === "pull-request" &&
      hashQuery.kind !== "pull-request" &&
      hashQuery.search === debouncedIssueQuery &&
      environmentId &&
      pullRequestProjectId
      ? composerPullRequests.issues({
          environmentId,
          input: { projectId: pullRequestProjectId, query: hashQuery.search },
        })
      : null,
  );
  const pullRequestSearch = useComposerPullRequestSearch({
    environmentId,
    projectId: pullRequestProjectId,
    repository: pullRequestRepository,
    query: trigger?.kind === "pull-request" && hashQuery.kind !== "issue" ? hashQuery.search : null,
  });

  const items = useMemo<ComposerCommandItem[]>(() => {
    if (!trigger) return [];

    if (trigger.kind === "pull-request") {
      const issues: ComposerCommandItem[] =
        hashQuery.kind === "pull-request"
          ? []
          : (issueSearch.data?.entries ?? []).map((issue) => ({
              id: `iss:${issue.number}`,
              type: "issue",
              issue,
              label: `iss:${issue.number}`,
              description: issue.title,
            }));
      const pullRequests: ComposerCommandItem[] =
        hashQuery.kind === "issue"
          ? []
          : pullRequestSearch.entries.map((entry) => ({
              id: `pr:${entry.projectId}:${entry.repository}:${entry.number}`,
              type: "pull-request",
              pullRequest: {
                number: entry.number,
                title: entry.title,
                url: entry.url,
                headBranch: entry.headBranch,
                baseBranch: entry.baseBranch,
                state: entry.state,
                isDraft: entry.isDraft,
              },
              label: `pr:${entry.number}`,
              description: `${entry.isDraft ? "Draft" : entry.state} · ${entry.title}`,
            }));
      return [...issues, ...pullRequests];
    }

    if (trigger.kind === "slash-command") {
      if (environmentId && !managedCatalog.data) return [];
      if (isArgumentInvocation && managedInvocationPrefix) {
        if (nativeChoiceKey?.toLowerCase() === managedInvocationPrefix.key.toLowerCase()) {
          return [];
        }
        return [
          ...buildManagedTextResourceMenuItems({
            entries: managedEntries,
            kind: "command",
            query: managedInvocationPrefix.key,
            exactKey: true,
          }),
          ...exactNativeInvocationItems,
        ];
      }
      const q = trigger.query.toLowerCase();
      const commandItems = buildComposerSlashCommandItems({
        visibleSkillNames: new Set(
          skills
            .filter(isProviderSkillUserInvocable)
            .map((skill) => skill.name.trim().toLowerCase()),
        ),
        query: q,
        atMessageStart: trigger.rangeStart === 0,
        hasThread,
        hasCompactableConversation,
        offersUsageLimits,
        allowInteractionMode: onUpdateInteractionMode !== undefined,
        selectedProviderStatus,
        managedEntries,
      });

      return commandItems;
    }

    if (trigger.kind === "snippet") {
      if (environmentId && !managedCatalog.data) return [];
      return buildManagedTextResourceMenuItems({
        entries: managedEntries,
        kind: "snippet",
        query: trigger.query,
      });
    }

    if (trigger.kind === "skill") {
      const enabledSkills = dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable));
      const normalizedQuery = normalizeSearchQuery(trigger.query, {
        trimLeadingPattern: /^!+/,
      });

      if (!normalizedQuery) {
        return enabledSkills.slice(0, 20).map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: `!${skill.name}`,
          description: skill.shortDescription ?? skill.description ?? "",
        }));
      }

      const ranked: Array<{
        item: (typeof enabledSkills)[number];
        score: number;
        tieBreaker: string;
      }> = [];
      for (const skill of enabledSkills) {
        const displayLabel = (skill.displayName ?? skill.name).toLowerCase();
        const scores = [
          scoreQueryMatch({
            value: skill.name.toLowerCase(),
            query: normalizedQuery,
            exactBase: 0,
            prefixBase: 2,
            boundaryBase: 4,
            includesBase: 6,
            fuzzyBase: 100,
            boundaryMarkers: ["-", "_", "/"],
          }),
          scoreQueryMatch({
            value: displayLabel,
            query: normalizedQuery,
            exactBase: 1,
            prefixBase: 3,
            boundaryBase: 5,
            includesBase: 7,
            fuzzyBase: 110,
          }),
          scoreQueryMatch({
            value: skill.shortDescription?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 20,
            prefixBase: 22,
            boundaryBase: 24,
            includesBase: 26,
          }),
          scoreQueryMatch({
            value: skill.description?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 30,
            prefixBase: 32,
            boundaryBase: 34,
            includesBase: 36,
          }),
        ].filter((score): score is number => score !== null);

        if (scores.length > 0) {
          insertRankedSearchResult(
            ranked,
            {
              item: skill,
              score: Math.min(...scores),
              tieBreaker: `${displayLabel}\u0000${skill.name}`,
            },
            20,
          );
        }
      }

      return ranked.map(({ item: skill }) => ({
        id: `skill:${skill.name}`,
        type: "skill" as const,
        skill,
        label: `!${skill.name}`,
        description: skill.shortDescription ?? skill.description ?? "",
      }));
    }

    if (trigger.kind === "path") {
      return pathSearch.entries.map((entry) => {
        const parts = entry.path.split("/");
        return {
          id: `path:${entry.path}`,
          type: "path" as const,
          path: entry.path,
          kind: entry.kind,
          label: parts[parts.length - 1] ?? entry.path,
          description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
        };
      });
    }

    return [];
  }, [
    hasThread,
    hasCompactableConversation,
    environmentId,
    exactNativeInvocationItems,
    hashQuery.kind,
    issueSearch.data?.entries,
    isArgumentInvocation,
    managedCatalog.data,
    managedEntries,
    managedInvocationPrefix,
    nativeChoiceKey,
    onUpdateInteractionMode,
    pathSearch.entries,
    pullRequestSearch.entries,
    selectedProviderStatus,
    skills,
    trigger,
    offersUsageLimits,
  ]);

  const onSelect = useCallback(
    (item: ComposerCommandItem) => {
      if (!trigger) return;
      if (item.type === "pull-request" || item.type === "issue") {
        if (
          !ownerKey ||
          trigger.kind !== "pull-request" ||
          !items.some((candidate) => candidate.id === item.id)
        )
          return;
        const record =
          item.type === "issue"
            ? issueComposerContext(item.issue, uuidv4())
            : pullRequestComposerContext(item.pullRequest, uuidv4());
        if (
          (getComposerDraftSnapshot(ownerKey).context?.records.length ?? 0) >=
          COMPOSER_CONTEXT_MAX_RECORDS
        ) {
          Alert.alert(
            "Too many context items",
            "Remove some context from the draft and try again.",
          );
          return;
        }
        const result = replaceTextRange(
          draftMessage,
          trigger.rangeStart,
          trigger.rangeEnd,
          `${formatComposerContextReference(record)} `,
        );
        onChangeDraftMessage(result.text);
        const draft = getComposerDraftSnapshot(ownerKey);
        setComposerDraftContext(ownerKey, {
          version: 1,
          records: [...(draft.context?.records ?? []), record],
        });
        setSelection({ start: result.cursor, end: result.cursor });
        return;
      }

      if (
        item.type === "provider-slash-command" &&
        item.command.name === USAGE_LIMITS_COMMAND.name &&
        onUsageLimits
      ) {
        const cleared = replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, "");
        setSelection({ start: cleared.cursor, end: cleared.cursor });
        onChangeDraftMessage(cleared.text);
        onUsageLimits();
        return;
      }

      if (item.type === "managed-text-resource") {
        if (
          !environmentId ||
          !item.resource.id ||
          !items.some((candidate) => candidate.id === item.id)
        ) {
          return;
        }
        const argument =
          item.resource.kind === "command" &&
          isArgumentInvocation &&
          managedInvocationPrefix?.key.toLowerCase() === item.resource.key.toLowerCase()
            ? managedInvocationPrefix.argument
            : "";
        setNativeChoice(null);
        setPendingManagedInsertion({
          requestId: ++insertionRequestIdRef.current,
          resource: item.resource,
          rangeStart: trigger.rangeStart,
          rangeEnd: trigger.rangeEnd,
          expectedDraft: draftMessage,
          argument,
        });
        return;
      }

      if (item.type === "slash-command" || item.type === "provider-slash-command") {
        const selectedKey = item.type === "slash-command" ? item.command : item.command.name;
        setNativeChoice({ key: selectedKey, scope: managedCatalogScopeKey });
        if (
          isArgumentInvocation &&
          managedInvocationPrefix?.key.toLowerCase() === selectedKey.toLowerCase() &&
          !(
            item.type === "slash-command" &&
            (item.command === "plan" || item.command === "default")
          )
        ) {
          return;
        }
      }

      const result = resolveComposerCommandSelection({
        draftMessage,
        trigger,
        item,
        allowInteractionMode:
          onUpdateInteractionMode !== undefined &&
          selectedProviderStatus?.showInteractionModeToggle !== false,
      });
      setSelection({ start: result.cursor, end: result.cursor });
      onChangeDraftMessage(result.text);
      if (result.interactionMode !== null) {
        onUpdateInteractionMode?.(result.interactionMode);
      }
    },
    [
      draftMessage,
      environmentId,
      ownerKey,
      items,
      managedCatalogScopeKey,
      isArgumentInvocation,
      managedInvocationPrefix,
      onChangeDraftMessage,
      onUpdateInteractionMode,
      onUsageLimits,
      selectedProviderStatus?.showInteractionModeToggle,
      trigger,
    ],
  );

  return {
    selection,
    onSelectionChange,
    trigger,
    items,
    skills,
    mustResolveManagedCommandSelection,
    managedCommandBlockReason,
    isManagedInsertionPending: pendingManagedInsertion !== null,
    isLoading:
      trigger?.kind === "pull-request"
        ? pullRequestSearch.isPending || issueSearch.isPending
        : trigger?.kind === "path"
          ? pathSearch.isPending
          : (trigger?.kind === "slash-command" || trigger?.kind === "snippet") &&
            environmentId !== null &&
            managedCatalog.isPending,
    error:
      trigger?.kind === "pull-request"
        ? pullRequestProjectId === null || pullRequestRepository === null
          ? "Issues and pull requests are unavailable for this project."
          : (pullRequestSearch.error ?? issueSearch.error ?? null)
        : trigger?.kind === "slash-command" || trigger?.kind === "snippet"
          ? managedCatalog.error
          : null,
    onSelect,
  };
}
