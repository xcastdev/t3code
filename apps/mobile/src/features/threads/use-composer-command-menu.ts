import * as Dialog from "../../components/ui/Dialog";
import type {
  EnvironmentId,
  ProjectId,
  ProviderInteractionMode,
  ServerProvider,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { matchComposerThreadItems } from "@t3tools/client-runtime/composerThreadItems";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

const EMPTY_THREAD_SHELLS: ReadonlyArray<EnvironmentThreadShell> = [];
import {
  COMPOSER_CONTEXT_MAX_RECORDS,
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { pullRequestComposerContext, threadComposerContext } from "../../lib/composerContext";
import { uuidv4 } from "../../lib/uuid";
import {
  getComposerDraftSnapshot,
  readComposerDraftSelection,
  setComposerDraftContext,
} from "../../state/use-composer-drafts";
import { USAGE_LIMITS_COMMAND } from "@t3tools/shared/usageLimits";
import {
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import {
  dedupeProviderSkillsByName,
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
  isProviderSkillUserInvocable,
  hasCompleteProviderWorkspaceSnapshot,
  hasCurrentProviderWorkspaceSnapshot,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import { RegistryContext } from "@effect/atom-react";
import { composerIssueItems } from "@t3tools/client-runtime/composerIssueItems";
import {
  composerTriggerTokenEnd,
  createComposerInsertionGuard,
  managedCommandArgumentRange,
  managedSkillMenuItems,
  managedTextMenuItems,
  resolveManagedSkillInsertion,
} from "@t3tools/client-runtime/composer-managed-resources";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  useComposerPathSearch,
  useComposerPullRequestSearch,
  useDebouncedValue,
} from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import {
  issueSearchEnvironment,
  managedTextEnvironment,
  resourceCatalogInput,
  skillsEnvironment,
  useComposerResourceSubscriptions,
} from "../../state/resources";
import { resolveManagedTextResourceInsertion } from "../managedTextResources/managedTextResourceInsertion";
import type { ComposerCommandItem } from "./ComposerCommandPopover";
import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";

const WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS = 10_000;

function composerSelectionAtEnd(draftMessage: string): ComposerEditorSelection {
  return { start: draftMessage.length, end: draftMessage.length };
}

/**
 * Whether the composer shows its menu. A failed catalog or issue lookup is
 * shown even with no rows, so the failure and its retry are never swallowed.
 */
export function isComposerMenuVisible(menu: {
  readonly trigger: { readonly kind: string } | null;
  readonly items: ReadonlyArray<unknown>;
  readonly error: string | null;
}): boolean {
  if (menu.trigger === null) return false;
  return menu.items.length > 0 || menu.trigger.kind === "pull-request" || menu.error !== null;
}

export function buildComposerSlashCommandItems(input: {
  readonly query: string;
  readonly atMessageStart: boolean;
  readonly hasThread: boolean;
  readonly hasCompactableConversation?: boolean;
  readonly offersUsageLimits?: boolean;
  readonly allowInteractionMode: boolean;
  readonly selectedProviderStatus: Pick<
    ServerProvider,
    "driver" | "slashCommands" | "showInteractionModeToggle"
  > | null;
}): ComposerCommandItem[] {
  const query = input.query.toLowerCase();
  const allowInteractionMode =
    input.allowInteractionMode && input.selectedProviderStatus?.showInteractionModeToggle !== false;
  const builtIn = [
    {
      id: "cmd:model",
      type: "slash-command",
      command: "model",
      label: "/model",
      description: "Switch model",
    },
    {
      id: "cmd:plan",
      type: "slash-command",
      command: "plan",
      label: "/plan",
      description: "Switch to plan mode",
    },
    {
      id: "cmd:default",
      type: "slash-command",
      command: "default",
      label: "/default",
      description: "Switch to default mode",
    },
  ] satisfies ComposerCommandItem[];
  const items: ComposerCommandItem[] = builtIn.filter(
    (item) => item.command.includes(query) && (item.command === "model" || allowInteractionMode),
  );

  // Providers expand commands only at the start of a message. T3 commands
  // change local state and do not have this restriction.
  if (!input.atMessageStart) return items;
  for (const command of input.selectedProviderStatus?.slashCommands ?? []) {
    if (!command.name.toLowerCase().includes(query)) continue;
    if (command.name === "compact" && !input.hasCompactableConversation) continue;
    if (command.name === USAGE_LIMITS_COMMAND.name && input.offersUsageLimits && !input.hasThread) {
      continue;
    }
    if (
      !input.hasThread &&
      input.selectedProviderStatus?.driver === "codex" &&
      command.name === "feedback"
    ) {
      continue;
    }
    items.push({
      id: `pcmd:${command.name}`,
      type: "provider-slash-command",
      command,
      label: `/${command.name}`,
      description: command.description ?? "",
    });
  }
  return items;
}

export function resolveComposerCommandSelection(input: {
  readonly draftMessage: string;
  readonly trigger: Pick<ComposerTrigger, "rangeStart" | "rangeEnd">;
  readonly item: ComposerCommandItem;
  readonly allowInteractionMode: boolean;
}): {
  readonly text: string;
  readonly cursor: number;
  readonly interactionMode: ProviderInteractionMode | null;
} {
  const { draftMessage, trigger, item } = input;
  if (
    input.allowInteractionMode &&
    item.type === "slash-command" &&
    (item.command === "plan" || item.command === "default")
  ) {
    return {
      ...replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, ""),
      interactionMode: item.command,
    };
  }

  let replacement = "";
  if (item.type === "path") {
    replacement = `${serializeComposerFileLink(item.path)} `;
  } else if (item.type === "skill") {
    replacement = `$${item.skill.name} `;
  } else if (item.type === "slash-command") {
    replacement = `/${item.command} `;
  } else if (item.type === "provider-slash-command") {
    replacement = `/${item.command.name} `;
  }
  return {
    ...replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, replacement),
    interactionMode: null,
  };
}

export function useComposerCommandMenu({
  draftMessage,
  ownerKey,
  environmentId,
  threadShells = EMPTY_THREAD_SHELLS,
  currentThreadId = null,
  projectCwd,
  pullRequestProjectId = null,
  resourceProjectId = null,
  pullRequestRepository = null,
  threadPullRequests,
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
  readonly threadShells?: ReadonlyArray<EnvironmentThreadShell>;
  readonly currentThreadId?: ThreadId | null;
  readonly projectCwd: string | null;
  readonly pullRequestProjectId?: ProjectId | null;
  /** The draft's project, which scopes managed commands, snippets and skills. */
  readonly resourceProjectId?: ProjectId | null;
  readonly pullRequestRepository?: string | null;
  readonly threadPullRequests?: ReadonlyArray<ThreadPullRequestLink>;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly hasThread: boolean;
  readonly hasCompactableConversation: boolean;
  readonly offersUsageLimits?: boolean;
  readonly enabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onUpdateInteractionMode?: (mode: ProviderInteractionMode) => void;
  readonly onUsageLimits?: () => void;
}) {
  const [selection, setSelection] = useState(() => composerSelectionAtEnd(draftMessage));
  const previousOwnerKeyRef = useRef(ownerKey);
  const onSelectionChange = (nextSelection: ComposerEditorSelection) => {
    setSelection(nextSelection);
  };
  useEffect(() => {
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

  const skills = selectedProviderStatus
    ? resolveProviderSkillsForCwd(selectedProviderStatus, projectCwd)
    : [];
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const selectedProviderInstanceId = selectedProviderStatus?.instanceId;
  const hasWorkspaceSnapshot = hasCompleteProviderWorkspaceSnapshot(
    selectedProviderStatus,
    projectCwd,
  );
  // The last scan this composer asked for. A request inside the TTL is not
  // repeated, so a client clock ahead of the server's cannot loop rescans.
  const workspaceRefreshKeyRef = useRef<{ key: string; requestedAt: number } | null>(null);
  const [workspaceRefreshRetry, setWorkspaceRefreshRetry] = useState<{
    key: string;
    notBefore: number;
  } | null>(null);
  const workspaceRefreshScopeKey =
    environmentId && projectCwd && selectedProviderInstanceId
      ? `${environmentId}:${selectedProviderInstanceId}:${projectCwd}`
      : null;
  const workspaceSlashCommandsPending =
    selectedProviderStatus?.workspaceSnapshots?.some(
      (snapshot) => snapshot.cwd === projectCwd && snapshot.slashCommandsPending === true,
    ) ?? false;
  useEffect(() => {
    if (
      !workspaceSlashCommandsPending ||
      !workspaceRefreshRetry ||
      workspaceRefreshRetry.key !== workspaceRefreshScopeKey
    )
      return;
    const timeout = setTimeout(
      () => {
        setWorkspaceRefreshRetry((current) => (current === workspaceRefreshRetry ? null : current));
      },
      Math.max(0, workspaceRefreshRetry.notBefore - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [workspaceRefreshRetry, workspaceRefreshScopeKey, workspaceSlashCommandsPending]);
  const hadWorkspaceSnapshotRef = useRef(false);
  useEffect(() => {
    if (hadWorkspaceSnapshotRef.current && !hasWorkspaceSnapshot) {
      workspaceRefreshKeyRef.current = null;
      setWorkspaceRefreshRetry(null);
    }
    hadWorkspaceSnapshotRef.current = hasWorkspaceSnapshot;
  }, [hasWorkspaceSnapshot]);
  useEffect(() => {
    if (!environmentId || !projectCwd || !selectedProviderInstanceId) return;
    const key = `${environmentId}:${selectedProviderInstanceId}:${projectCwd}`;
    const now = Date.now();
    const lastRequest = workspaceRefreshKeyRef.current;
    if (
      lastRequest?.key === key &&
      now - lastRequest.requestedAt < PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS
    )
      return;
    if (hasCurrentProviderWorkspaceSnapshot(selectedProviderStatus, projectCwd, now)) {
      setWorkspaceRefreshRetry(null);
      return;
    }
    const retry = workspaceRefreshRetry;
    if (retry?.key === key && now < retry.notBefore) return;
    const request = { key, requestedAt: now };
    workspaceRefreshKeyRef.current = request;
    const retryLater = () => {
      if (workspaceRefreshKeyRef.current !== request) return;
      workspaceRefreshKeyRef.current = null;
      setWorkspaceRefreshRetry({
        key,
        notBefore: Date.now() + WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS,
      });
    };
    void refreshProviders({
      environmentId,
      input: { instanceId: selectedProviderInstanceId, cwd: projectCwd },
    }).then((result) => {
      const refreshed =
        result._tag === "Success" &&
        hasCompleteProviderWorkspaceSnapshot(
          result.value.providers.find(
            (provider) => provider.instanceId === selectedProviderInstanceId,
          ),
          projectCwd,
        );
      if (!refreshed) retryLater();
    }, retryLater);
  }, [
    draftMessage,
    environmentId,
    projectCwd,
    refreshProviders,
    selectedProviderInstanceId,
    selectedProviderStatus,
    workspaceRefreshRetry,
  ]);

  const trigger = (() => {
    if (!enabled || selection.start !== selection.end) {
      return null;
    }
    return detectComposerTrigger(draftMessage, selection.end);
  })();
  const pathSearch = useComposerPathSearch({
    environmentId,
    cwd: trigger?.kind === "path" ? projectCwd : null,
    query: trigger?.kind === "path" ? trigger.query : null,
  });
  const pullRequestSearch = useComposerPullRequestSearch({
    environmentId,
    projectId: pullRequestProjectId,
    repository: pullRequestRepository,
    threadPullRequests,
    query: trigger?.kind === "pull-request" ? trigger.query : null,
  });

  const registry = useContext(RegistryContext);
  const resourceTarget =
    environmentId === null
      ? null
      : {
          environmentId,
          ...(resourceProjectId === null ? {} : { projectId: resourceProjectId }),
          ...(currentThreadId === null ? {} : { threadId: currentThreadId }),
        };
  const resourceInput = resourceTarget === null ? {} : resourceCatalogInput(resourceTarget);
  // A managed insertion resumes after a fetch; it compares against these, not its own render.
  const insertionProviderId: string | null = selectedProviderInstanceId ?? null;
  const latestRef = useRef({
    draftMessage,
    resourceTarget,
    ownerKey,
    selection,
    providerInstanceId: insertionProviderId,
  });
  useLayoutEffect(() => {
    latestRef.current = {
      draftMessage,
      resourceTarget,
      ownerKey,
      selection,
      providerInstanceId: insertionProviderId,
    };
  });
  // Bumped when a pending managed insertion must not land: another selection,
  // a caret move, a closed menu, another provider, another draft owner, or unmount.
  const [insertionGuard] = useState(createComposerInsertionGuard);
  const readInsertion = () => {
    const latest = latestRef.current;
    if (latest.resourceTarget === null || latest.selection.start !== latest.selection.end)
      return null;
    return {
      ownerKey: latest.ownerKey ?? "",
      target: latest.resourceTarget,
      providerInstanceId: latest.providerInstanceId,
      draft: latest.draftMessage,
      cursor: latest.selection.end,
      selection: { start: latest.selection.start, end: latest.selection.end },
    };
  };
  const insertionContextRef = useRef("");
  const insertionContext = JSON.stringify([
    ownerKey,
    selection.start,
    selection.end,
    trigger !== null,
    insertionProviderId,
  ]);
  useLayoutEffect(() => {
    if (insertionContextRef.current === insertionContext) return;
    insertionContextRef.current = insertionContext;
    insertionGuard.cancel();
  }, [insertionContext, insertionGuard]);
  useEffect(
    () => () => {
      insertionGuard.cancel();
    },
    [insertionGuard],
  );
  // Open menus follow catalog edits made elsewhere instead of offering a stale list.
  useComposerResourceSubscriptions(
    resourceTarget !== null && (trigger?.kind === "slash-command" || trigger?.kind === "skill")
      ? {
          target: resourceTarget,
          kind: trigger.kind === "skill" ? "skills" : "text",
          ...(trigger.kind === "skill" && selectedProviderStatus
            ? { providerInstanceId: selectedProviderStatus.instanceId }
            : {}),
        }
      : null,
  );
  const managedTextCatalog = useEnvironmentQuery(
    environmentId !== null && trigger?.kind === "slash-command"
      ? managedTextEnvironment.catalog({ environmentId, input: resourceInput })
      : null,
  );
  const managedSkillCatalog = useEnvironmentQuery(
    environmentId !== null && trigger?.kind === "skill"
      ? skillsEnvironment.catalog({
          environmentId,
          input: {
            ...resourceInput,
            ...(selectedProviderStatus
              ? { providerInstanceId: selectedProviderStatus.instanceId }
              : {}),
          },
        })
      : null,
  );
  const issueQuery = trigger?.kind === "issue" ? trigger.query : null;
  const debouncedIssueQuery = useDebouncedValue(issueQuery, 180);
  const issueSearch = useEnvironmentQuery(
    environmentId !== null &&
      pullRequestProjectId !== null &&
      debouncedIssueQuery !== null &&
      debouncedIssueQuery === issueQuery
      ? issueSearchEnvironment.search({
          environmentId,
          input: { projectId: pullRequestProjectId, query: debouncedIssueQuery },
        })
      : null,
  );
  const managedSkillItems = managedSkillMenuItems({
    entries: managedSkillCatalog.data?.entries ?? [],
    query: trigger?.kind === "skill" ? trigger.query.replace(/^\p{Sc}+/u, "") : "",
    nativeSkillNames: skills.map((skill) => skill.name),
  }).map((item): ComposerCommandItem => ({
    id: item.id,
    type: "managed-skill",
    entry: item.entry,
    collidesWithNative: item.collidesWithNative,
    label: item.entry.name,
    description: `Adds its ${item.entry.scope} instructions to the message`,
  }));

  const items = ((): ComposerCommandItem[] => {
    if (!trigger) return [];

    if (trigger.kind === "issue") {
      return issueSearch.data === null || debouncedIssueQuery !== issueQuery
        ? []
        : composerIssueItems(issueSearch.data).map((item) => ({
            id: item.id,
            type: "issue",
            issue: item.issue,
            label: `#${item.issue.number}`,
            description: item.issue.title,
          }));
    }

    if (trigger.kind === "pull-request") {
      return pullRequestSearch.entries.map((entry) => ({
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
        label: `#${entry.number}`,
        description: `${entry.isDraft ? "Draft" : entry.state} · ${
          entry.repository.toLowerCase() === pullRequestRepository?.toLowerCase()
            ? ""
            : `${entry.repository} · `
        }${entry.title}`,
      }));
    }

    if (trigger.kind === "slash-command") {
      const q = trigger.query.toLowerCase();
      const visibleSkills = getProviderSkillsForSlashMenu(skills, true);
      const commandItems = buildComposerSlashCommandItems({
        query: q,
        atMessageStart: trigger.rangeStart === 0,
        hasThread,
        hasCompactableConversation,
        offersUsageLimits,
        allowInteractionMode: onUpdateInteractionMode !== undefined,
        selectedProviderStatus: selectedProviderStatus
          ? {
              ...selectedProviderStatus,
              slashCommands: getProviderSlashCommandsForSlashMenu(
                resolveProviderSlashCommandsForCwd(selectedProviderStatus, projectCwd),
                visibleSkills,
              ),
            }
          : null,
      });

      const skillItems = visibleSkills
        .filter((skill) => matchesSlashSkillQuery(skill, q))
        .map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: `skill:${skill.name}`,
          description: skill.shortDescription ?? skill.description ?? "",
        }));

      const managedItems = managedTextMenuItems({
        entries: managedTextCatalog.data?.entries ?? [],
        query: trigger.query,
        nativeCommandNames: (selectedProviderStatus
          ? resolveProviderSlashCommandsForCwd(selectedProviderStatus, projectCwd)
          : []
        ).map((command) => command.name),
      }).map((item): ComposerCommandItem => ({
        id: item.id,
        type: "managed-text",
        entry: item.entry,
        collidesWithNative: item.collidesWithNative,
        label: `/${item.entry.key}`,
        description: item.entry.name ?? (item.entry.kind === "command" ? "Command" : "Snippet"),
      }));

      return [...commandItems, ...skillItems, ...managedItems];
    }

    if (trigger.kind === "skill") {
      const enabledSkills = dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable));
      const normalizedQuery = normalizeSearchQuery(trigger.query, {
        trimLeadingPattern: /^\p{Sc}+/u,
      });

      if (!normalizedQuery) {
        return [
          ...enabledSkills.slice(0, 20).map((skill) => ({
            id: `skill:${skill.name}`,
            type: "skill" as const,
            skill,
            label: skill.displayName ?? skill.name,
            description: skill.shortDescription ?? skill.description ?? "",
          })),
          ...managedSkillItems,
        ];
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

      return [
        ...ranked.map(({ item: skill }) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: skill.displayName ?? skill.name,
          description: skill.shortDescription ?? skill.description ?? "",
        })),
        ...managedSkillItems,
      ];
    }

    if (trigger.kind === "path") {
      const threadItems = environmentId
        ? matchComposerThreadItems({
            shells: threadShells,
            environmentId,
            excludeThreadId: currentThreadId,
            query: trigger.query,
          })
        : [];
      return [
        ...threadItems,
        ...pathSearch.entries.map((entry) => {
          const parts = entry.path.split("/");
          return {
            id: `path:${entry.path}`,
            type: "path" as const,
            path: entry.path,
            kind: entry.kind,
            label: parts[parts.length - 1] ?? entry.path,
            description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
          };
        }),
      ];
    }

    return [];
  })();

  const onSelectRef = useRef<(item: ComposerCommandItem) => void>(() => undefined);
  const reportInsertionFailure = (
    label: string,
    item: ComposerCommandItem,
    result: Parameters<typeof isAtomCommandInterrupted>[0] & { readonly _tag: "Failure" },
  ) => {
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    Dialog.confirm({
      title: `Couldn't insert ${label}`,
      message: `${
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "It couldn't be read from this environment."
      } Your draft is unchanged.`,
      confirmText: "Try again",
      onConfirm: () => onSelectRef.current(item),
    });
  };

  /**
   * Expands a managed command or snippet at selection time. After the content
   * fetch the catalog is reread and everything is compared again, so nothing
   * lands in another draft or after the user moved on.
   */
  const insertManagedText = async (
    item: Extract<ComposerCommandItem, { type: "managed-text" }>,
    selectedTrigger: ComposerTrigger,
  ) => {
    const pending = insertionGuard.begin(readInsertion);
    if (pending === null) return;
    const { selected } = pending;
    const expectedDraft = selected.draft;
    const range =
      item.entry.kind === "command"
        ? managedCommandArgumentRange(expectedDraft, selected.cursor)
        : { argument: "", rangeEnd: composerTriggerTokenEnd(expectedDraft, selected.cursor) };
    const scope = resourceCatalogInput(selected.target);
    const content = await executeAtomQuery(
      registry,
      managedTextEnvironment.content({
        environmentId: selected.target.environmentId,
        input: {
          kind: item.entry.kind,
          id: item.entry.id,
          expectedRevision: item.entry.revision,
          ...scope,
        },
      }),
      { reportFailure: false },
    );
    const catalog =
      content._tag === "Success"
        ? await executeAtomQuery(
            registry,
            managedTextEnvironment.catalog({
              environmentId: selected.target.environmentId,
              input: scope,
            }),
            { refresh: true, reportFailure: false },
          )
        : content;
    if (!pending.isCurrent()) return;
    if (content._tag !== "Success")
      return reportInsertionFailure(`/${item.entry.key}`, item, content);
    if (catalog._tag !== "Success")
      return reportInsertionFailure(`/${item.entry.key}`, item, catalog);
    const result = resolveManagedTextResourceInsertion({
      selectedTarget: selected.target,
      currentTarget: selected.target,
      selected: item.entry,
      content: content.value,
      currentEntries: catalog.value.entries,
      draft: selected.draft,
      expectedDraft,
      rangeStart: selectedTrigger.rangeStart,
      rangeEnd: range.rangeEnd,
      argument: range.argument,
    });
    if (result.status === "inserted") {
      onChangeDraftMessage(result.text);
      setSelection({ start: result.cursor, end: result.cursor });
    } else if (result.status === "stale-resource") {
      Dialog.alert(`/${item.entry.key} changed`, "Choose it again to use the current version.");
    }
  };

  /**
   * Inserts the verified body of a managed skill as ordinary draft text. A
   * provider skill with the same key keeps its own `$key` row.
   */
  const insertManagedSkill = async (
    item: Extract<ComposerCommandItem, { type: "managed-skill" }>,
    selectedTrigger: ComposerTrigger,
  ) => {
    const pending = insertionGuard.begin(readInsertion);
    if (pending === null) return;
    const { selected } = pending;
    const scope = resourceCatalogInput(selected.target);
    const providerInstanceId = selectedProviderStatus?.instanceId;
    const content = await executeAtomQuery(
      registry,
      skillsEnvironment.content({
        environmentId: selected.target.environmentId,
        input: { skillId: item.entry.id, ...scope },
      }),
      { refresh: true, reportFailure: false },
    );
    const catalog =
      content._tag === "Success"
        ? await executeAtomQuery(
            registry,
            skillsEnvironment.catalog({
              environmentId: selected.target.environmentId,
              input: {
                ...scope,
                ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
              },
            }),
            { refresh: true, reportFailure: false },
          )
        : content;
    if (!pending.isCurrent()) return;
    if (content._tag !== "Success") return reportInsertionFailure(item.entry.name, item, content);
    if (catalog._tag !== "Success") return reportInsertionFailure(item.entry.name, item, catalog);
    const result = resolveManagedSkillInsertion({
      selected: item.entry,
      content: content.value,
      currentEntries: catalog.value.entries,
      draft: selected.draft,
      rangeStart: selectedTrigger.rangeStart,
      rangeEnd: composerTriggerTokenEnd(selected.draft, selected.cursor),
    });
    if (result.status === "inserted") {
      onChangeDraftMessage(result.text);
      setSelection({ start: result.cursor, end: result.cursor });
    } else if (result.status === "stale-resource") {
      Dialog.alert(
        `${item.entry.name} changed`,
        "It was edited, turned off or replaced while loading. Choose it again to use the current version.",
      );
    }
  };

  const onSelect = (item: ComposerCommandItem) => {
    if (!trigger) return;
    if (item.type === "issue") {
      if (trigger.kind !== "issue" || !items.some((candidate) => candidate.id === item.id)) return;
      const result = replaceTextRange(
        draftMessage,
        trigger.rangeStart,
        trigger.rangeEnd,
        `${item.issue.url} `,
      );
      onChangeDraftMessage(result.text);
      setSelection({ start: result.cursor, end: result.cursor });
      return;
    }
    if (item.type === "managed-skill") {
      if (trigger.kind === "skill") void insertManagedSkill(item, trigger);
      return;
    }
    if (item.type === "managed-text") {
      if (trigger.kind === "slash-command") void insertManagedText(item, trigger);
      return;
    }
    if (item.type === "thread") {
      if (!ownerKey || trigger.kind !== "path") return;
      const shell = threadShells.find(
        (candidate) =>
          candidate.environmentId === item.thread.environmentId &&
          candidate.id === item.thread.threadId,
      );
      if (!shell) return;
      const record = threadComposerContext(item.thread, shell.title);
      const existing = getComposerDraftSnapshot(ownerKey).context?.records ?? [];
      const alreadyAttached = existing.some((entry) => entry.contextId === record.contextId);
      if (!alreadyAttached && existing.length >= COMPOSER_CONTEXT_MAX_RECORDS) {
        Dialog.alert("Too many context items", "Remove some context from the draft and try again.");
        return;
      }
      const result = replaceTextRange(
        draftMessage,
        trigger.rangeStart,
        trigger.rangeEnd,
        `${formatComposerContextReference(record)} `,
      );
      onChangeDraftMessage(result.text);
      if (!alreadyAttached) {
        const draft = getComposerDraftSnapshot(ownerKey);
        setComposerDraftContext(ownerKey, {
          version: 1,
          records: [...(draft.context?.records ?? []), record],
        });
      }
      setSelection({ start: result.cursor, end: result.cursor });
      return;
    }
    if (item.type === "pull-request") {
      if (
        !ownerKey ||
        trigger.kind !== "pull-request" ||
        !items.some((candidate) => candidate.id === item.id)
      )
        return;
      const record = pullRequestComposerContext(item.pullRequest, uuidv4());
      if (
        (getComposerDraftSnapshot(ownerKey).context?.records.length ?? 0) >=
        COMPOSER_CONTEXT_MAX_RECORDS
      ) {
        Dialog.alert("Too many context items", "Remove some context from the draft and try again.");
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
  };

  useLayoutEffect(() => {
    onSelectRef.current = onSelect;
  });

  return {
    selection,
    onSelectionChange,
    trigger,
    items,
    skills,
    isLoading:
      trigger?.kind === "pull-request"
        ? pullRequestSearch.isPending
        : trigger?.kind === "issue"
          ? issueSearch.isPending || debouncedIssueQuery !== issueQuery
          : pathSearch.isPending,
    error:
      trigger?.kind === "issue"
        ? pullRequestProjectId === null
          ? "Issues are unavailable for this project."
          : issueSearch.error
        : trigger?.kind === "pull-request"
          ? pullRequestProjectId === null || pullRequestRepository === null
            ? "Pull requests are unavailable for this project."
            : pullRequestSearch.error
          : trigger?.kind === "slash-command" && managedTextCatalog.error !== null
            ? `Managed commands and snippets couldn't be loaded. ${managedTextCatalog.error}`
            : trigger?.kind === "skill" && managedSkillCatalog.error !== null
              ? `Managed skills couldn't be loaded. ${managedSkillCatalog.error}`
              : null,
    onRetry:
      trigger?.kind === "issue" && issueSearch.error !== null
        ? issueSearch.refresh
        : trigger?.kind === "slash-command" && managedTextCatalog.error !== null
          ? managedTextCatalog.refresh
          : trigger?.kind === "skill" && managedSkillCatalog.error !== null
            ? managedSkillCatalog.refresh
            : null,
    onSelect,
  };
}
