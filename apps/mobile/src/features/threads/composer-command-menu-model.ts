import type {
  IssueContextMetadata,
  ProviderInteractionMode,
  PullRequestContextMetadata,
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { USAGE_LIMITS_COMMAND } from "@t3tools/shared/usageLimits";
import {
  replaceTextRange,
  serializeComposerFileLink,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";
import {
  dedupeProviderSkillsByName,
  isProviderSkillUserInvocable,
  resolveProviderSkillsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import { managedTextResourceMenuItemId } from "@t3tools/client-runtime/managedTextResources";
import type { ManagedTextResourceSummary } from "@t3tools/contracts";

export type ComposerCommandItem =
  | {
      readonly id: string;
      readonly type: "issue";
      readonly issue: IssueContextMetadata;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "pull-request";
      readonly pullRequest: PullRequestContextMetadata;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "path";
      readonly path: string;
      readonly kind: "file" | "directory";
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "slash-command";
      readonly command: string;
      readonly label: string;
      readonly description: string;
      readonly sourceLabel?: string;
    }
  | {
      readonly id: string;
      readonly type: "provider-slash-command";
      readonly command: ServerProviderSlashCommand;
      readonly label: string;
      readonly description: string;
      readonly sourceLabel?: string;
    }
  | {
      readonly id: string;
      readonly type: "skill";
      readonly skill: ServerProviderSkill;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "managed-text-resource";
      readonly resource: ManagedTextResourceSummary;
      readonly label: string;
      readonly description: string;
      readonly sourceLabel: string;
    };

export function isManagedTextResourceAvailable(entry: ManagedTextResourceSummary): boolean {
  return Boolean(
    entry.id &&
    entry.effective &&
    entry.projectState !== "disabled" &&
    entry.projectState !== "invalid" &&
    entry.projectState !== "orphan",
  );
}

export function managedCommandInvocationNeedsChoice(input: {
  readonly key: string;
  readonly catalogResolved: boolean;
  readonly entries: ReadonlyArray<ManagedTextResourceSummary>;
  readonly nativeItems: ReadonlyArray<ComposerCommandItem>;
  readonly nativeChoiceKey: string | null;
}): boolean {
  if (!input.catalogResolved) return true;
  const normalizedKey = input.key.toLowerCase();
  const hasManaged = input.entries.some(
    (entry) =>
      entry.kind === "command" &&
      entry.key.toLowerCase() === normalizedKey &&
      isManagedTextResourceAvailable(entry),
  );
  const hasNative = input.nativeItems.some(
    (item) =>
      (item.type === "slash-command" && item.command.toLowerCase() === normalizedKey) ||
      (item.type === "provider-slash-command" && item.command.name.toLowerCase() === normalizedKey),
  );
  return hasManaged && hasNative && input.nativeChoiceKey?.toLowerCase() !== normalizedKey;
}

export function buildComposerSlashCommandItems(input: {
  readonly query: string;
  readonly atMessageStart: boolean;
  readonly hasThread: boolean;
  readonly hasCompactableConversation?: boolean;
  readonly offersUsageLimits?: boolean;
  readonly allowInteractionMode: boolean;
  readonly visibleSkillNames?: ReadonlySet<string>;
  readonly managedEntries?: ReadonlyArray<ManagedTextResourceSummary>;
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
      sourceLabel: "T3",
    },
    {
      id: "cmd:plan",
      type: "slash-command",
      command: "plan",
      label: "/plan",
      description: "Switch to plan mode",
      sourceLabel: "T3",
    },
    {
      id: "cmd:default",
      type: "slash-command",
      command: "default",
      label: "/default",
      description: "Switch to default mode",
      sourceLabel: "T3",
    },
  ] satisfies ComposerCommandItem[];
  const items: ComposerCommandItem[] = builtIn.filter(
    (item) => item.command.includes(query) && (item.command === "model" || allowInteractionMode),
  );

  if (!input.atMessageStart) return items;

  items.push(
    ...buildManagedTextResourceMenuItems({
      entries: input.managedEntries ?? [],
      kind: "command",
      query,
    }),
  );

  for (const command of input.selectedProviderStatus?.slashCommands ?? []) {
    if (input.visibleSkillNames?.has(command.name.trim().toLowerCase())) continue;
    if (!command.name.toLowerCase().includes(query)) continue;
    if (command.name === "compact" && !input.hasCompactableConversation) continue;
    if (command.name === USAGE_LIMITS_COMMAND.name && input.offersUsageLimits && !input.hasThread) {
      continue;
    }
    if (
      !input.hasThread &&
      input.selectedProviderStatus?.driver === ProviderDriverKind.make("codex") &&
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
      sourceLabel: "Provider native",
    });
  }
  return items;
}

export function buildManagedTextResourceMenuItems(input: {
  readonly entries: ReadonlyArray<ManagedTextResourceSummary>;
  readonly kind: "command" | "snippet";
  readonly query: string;
  readonly exactKey?: boolean;
}): ComposerCommandItem[] {
  const query = input.query.toLowerCase();
  return input.entries
    .filter(
      (entry) =>
        entry.kind === input.kind &&
        isManagedTextResourceAvailable(entry) &&
        (input.exactKey
          ? entry.key.toLowerCase() === query
          : entry.key.toLowerCase().includes(query)),
    )
    .map((resource) => ({
      id: managedTextResourceMenuItemId("managed", resource.key),
      type: "managed-text-resource" as const,
      resource,
      label: `${input.kind === "command" ? "/" : ":"}${resource.key}`,
      description: resource.name ?? "",
      sourceLabel: resource.scope === "project" ? "Managed · Project" : "Managed · Environment",
    }));
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
    replacement = `!${item.skill.name} `;
  } else if (item.type === "slash-command") {
    replacement = `/${item.command} `;
  } else if (item.type === "provider-slash-command") {
    replacement = `/${item.command.name} `;
  } else if (item.type === "managed-text-resource") {
    replacement = item.label;
  }
  return {
    ...replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, replacement),
    interactionMode: null,
  };
}

export { dedupeProviderSkillsByName, isProviderSkillUserInvocable, resolveProviderSkillsForCwd };
