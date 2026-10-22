import type { SkillAction, TextResourceAction } from "@t3tools/client-runtime/resource-actions";
import {
  ManagedSkillKey,
  ManagedTextResourceBody,
  ManagedTextResourceKey,
  ManagedTextResourceName,
  TrimmedNonEmptyString,
  type EnvironmentId,
  type ManagedSkillContentDraft,
  type ManagedTextResourceCatalogRevision,
  type ManagedTextResourceEnvironmentCreateInput,
  type ManagedTextResourceEnvironmentDeleteInput,
  type ManagedTextResourceEnvironmentSetEnabledInput,
  type ManagedTextResourceEnvironmentUpdateInput,
  type ManagedTextResourceKind,
  type ManagedTextResourceProjectDeleteStateInput,
  type ManagedTextResourceProjectSetDisabledInput,
  type ManagedTextResourceProjectSetOverrideInput,
  type ManagedTextResourceSummary,
  type ManagedTextResourceThreadResetInput,
  type ManagedTextResourceThreadSetEnabledInput,
  type ProjectId,
  type ProviderInstanceId,
  type SkillCatalogRevision,
  type SkillContentDetail,
  type SkillGlobalCreateInput,
  type SkillGlobalDeleteInput,
  type SkillGlobalUpdateInput,
  type SkillManagedCatalogSummary,
  type SkillProjectDeleteStateInput,
  type SkillProjectSetDisabledInput,
  type SkillProjectSetOverrideInput,
  type SkillSessionResetInput,
  type SkillSessionSetEnabledInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export {
  effectiveMcpCatalogDefinitions,
  isTextReloadCurrent,
  orphanedThreadTextOverlays,
  resourceEditorConflict,
  skillReloadBaseline,
  textReloadEntry,
  skillDeploymentActions,
  skillActions,
  skillEntryId,
  skillKeyCollisions,
  textResourceActions,
  managedTextResourceScopeLabel,
  describeResourceFailure,
} from "@t3tools/client-runtime/resource-actions";

/**
 * Environment-wide and project resources, or one thread's overlays. A thread
 * target only switches entries on or off for that thread.
 */
export interface MobileResourceTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly thread?: {
    readonly threadId: ThreadId;
    /** The thread's provider owns its skill overlay; null while it has none. */
    readonly providerInstanceId: ProviderInstanceId | null;
  };
}

export type SkillMutation =
  | { readonly command: "globalDelete"; readonly input: SkillGlobalDeleteInput }
  | { readonly command: "projectSetDisabled"; readonly input: SkillProjectSetDisabledInput }
  | { readonly command: "projectDeleteState"; readonly input: SkillProjectDeleteStateInput }
  | { readonly command: "globalCreate"; readonly input: SkillGlobalCreateInput }
  | { readonly command: "globalUpdate"; readonly input: SkillGlobalUpdateInput }
  | { readonly command: "projectSetOverride"; readonly input: SkillProjectSetOverrideInput }
  | { readonly command: "sessionSetEnabled"; readonly input: SkillSessionSetEnabledInput }
  | { readonly command: "sessionReset"; readonly input: SkillSessionResetInput };

/** One-tap skill actions; editors go through `buildSkillSave`. */
export function skillMutationForAction(
  action: SkillAction,
  entry: SkillManagedCatalogSummary,
  target: MobileResourceTarget,
  catalogRevision: SkillCatalogRevision,
): SkillMutation | null {
  switch (action) {
    case "session-enable":
    case "session-disable":
    case "session-reset": {
      const thread = target.thread;
      if (thread === undefined || thread.providerInstanceId === null) return null;
      const base = {
        threadId: thread.threadId,
        providerInstanceId: thread.providerInstanceId,
        expectedRevision: catalogRevision,
        key: entry.key,
      };
      return action === "session-reset"
        ? { command: "sessionReset", input: base }
        : {
            command: "sessionSetEnabled",
            input: { ...base, enabled: action === "session-enable" },
          };
    }
    case "delete":
      return entry.scope === "global" && target.projectId === null
        ? {
            command: "globalDelete",
            input: {
              environmentId: target.environmentId,
              skillId: entry.id,
              expectedHash: entry.revision.hash,
            },
          }
        : null;
    case "disable-project":
    case "reset-project":
      if (target.projectId === null) return null;
      return {
        command: action === "disable-project" ? "projectSetDisabled" : "projectDeleteState",
        input: { projectId: target.projectId, expectedRevision: catalogRevision, key: entry.key },
      };
    default:
      return null;
  }
}

const decodeSkillKey = Schema.decodeUnknownOption(ManagedSkillKey);
const decodeName = Schema.decodeUnknownOption(TrimmedNonEmptyString);

/**
 * Whom an editor's draft belongs to. A navigator can keep one screen and swap
 * its params, so this is captured with the loaded form and tokens, and a save
 * builds only from it, never from the params at save time.
 */
export interface ResourceEditorDestination<R extends "skill" | ManagedTextResourceKind> {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly resource: R;
  readonly mode: "create" | "edit" | "override";
  /** The skill id or text key being edited; null for a new one. */
  readonly identity: string | null;
}

export function resourceEditorDestinationKey(
  destination: ResourceEditorDestination<"skill" | ManagedTextResourceKind>,
): string {
  return JSON.stringify([
    destination.environmentId,
    destination.projectId,
    destination.resource,
    destination.mode,
    destination.identity,
  ]);
}

const DESTINATION_CHANGED =
  "This editor was opened for another place. Go back and open it again; your text was not saved.";

export interface SkillForm {
  readonly key: string;
  readonly name: string;
  readonly body: string;
}

/**
 * Saves against what the form was opened from: the catalog revision for new
 * and project entries, the loaded content hash for an edit. Bundled files and
 * frontmatter from the loaded revision are preserved.
 */
export function buildSkillSave(input: {
  readonly form: SkillForm;
  /** Where the form and tokens were loaded for. */
  readonly destination: ResourceEditorDestination<"skill">;
  /** Where the screen points now; a mismatch saves nothing. */
  readonly current: ResourceEditorDestination<"skill">;
  readonly catalogRevision: SkillCatalogRevision;
  readonly source: {
    readonly entry: SkillManagedCatalogSummary;
    readonly content: SkillContentDetail;
  } | null;
}):
  | { readonly ok: true; readonly mutation: SkillMutation }
  | { readonly ok: false; readonly error: string } {
  const { form, destination, source } = input;
  if (resourceEditorDestinationKey(destination) !== resourceEditorDestinationKey(input.current))
    return { ok: false, error: DESTINATION_CHANGED };
  if (source !== null && source.entry.id !== destination.identity)
    return { ok: false, error: DESTINATION_CHANGED };
  const target = destination;
  const key = decodeSkillKey(form.key.trim());
  const name = decodeName(form.name.trim());
  if (key._tag === "None")
    return { ok: false, error: "Use lowercase letters, numbers and single dashes for the key." };
  if (name._tag === "None") return { ok: false, error: "Give the skill a name." };
  if (source !== null && source.content.metadata.revision.hash !== source.entry.revision.hash)
    return {
      ok: false,
      error: "This skill changed after it was opened. Reopen it to edit the current version.",
    };
  const content: ManagedSkillContentDraft = {
    name: name.value,
    body: form.body,
    ...(source?.content.content.assetPaths
      ? { assetPaths: source.content.content.assetPaths }
      : {}),
    ...(source?.content.content.frontmatter
      ? { frontmatter: source.content.content.frontmatter }
      : {}),
  };
  if (destination.mode === "edit" && source !== null && source.entry.scope === "global") {
    if (target.projectId !== null)
      return {
        ok: false,
        error: "Override it for this project instead of editing the environment skill here.",
      };
    return {
      ok: true,
      mutation: {
        command: "globalUpdate",
        input: {
          environmentId: target.environmentId,
          skillId: source.entry.id,
          expectedHash: source.content.metadata.revision.hash,
          content,
        },
      },
    };
  }
  if (target.projectId !== null)
    return {
      ok: true,
      mutation: {
        command: "projectSetOverride",
        input: {
          projectId: target.projectId,
          expectedRevision: input.catalogRevision,
          key: key.value,
          content,
        },
      },
    };
  return {
    ok: true,
    mutation: {
      command: "globalCreate",
      input: {
        environmentId: target.environmentId,
        expectedRevision: input.catalogRevision,
        content: { ...content, key: key.value },
      },
    },
  };
}

export type TextMutation =
  | {
      readonly command: "environmentCreate";
      readonly input: ManagedTextResourceEnvironmentCreateInput;
    }
  | {
      readonly command: "environmentUpdate";
      readonly input: ManagedTextResourceEnvironmentUpdateInput;
    }
  | {
      readonly command: "environmentDelete";
      readonly input: ManagedTextResourceEnvironmentDeleteInput;
    }
  | {
      readonly command: "environmentSetEnabled";
      readonly input: ManagedTextResourceEnvironmentSetEnabledInput;
    }
  | {
      readonly command: "projectSetOverride";
      readonly input: ManagedTextResourceProjectSetOverrideInput;
    }
  | {
      readonly command: "projectSetDisabled";
      readonly input: ManagedTextResourceProjectSetDisabledInput;
    }
  | {
      readonly command: "projectDeleteState";
      readonly input: ManagedTextResourceProjectDeleteStateInput;
    }
  | {
      readonly command: "threadSetEnabled";
      readonly input: ManagedTextResourceThreadSetEnabledInput;
    }
  | { readonly command: "threadReset"; readonly input: ManagedTextResourceThreadResetInput };

/** Removes one thread overlay by kind and key; no listed source is needed. */
export function threadTextOverlayReset(
  overlay: Pick<ManagedTextResourceThreadResetInput, "kind" | "key">,
  target: MobileResourceTarget,
  catalogRevision: ManagedTextResourceCatalogRevision,
): TextMutation | null {
  if (target.thread === undefined) return null;
  return {
    command: "threadReset",
    input: {
      threadId: target.thread.threadId,
      kind: overlay.kind,
      expectedCatalogRevision: catalogRevision,
      key: overlay.key,
    },
  };
}

export function textMutationForAction(
  action: TextResourceAction,
  entry: ManagedTextResourceSummary,
  target: MobileResourceTarget,
  catalogRevision: ManagedTextResourceCatalogRevision,
): TextMutation | null {
  const environmentId = target.environmentId;
  switch (action) {
    case "thread-enable":
    case "thread-disable":
    case "thread-reset": {
      if (target.thread === undefined) return null;
      const base = {
        threadId: target.thread.threadId,
        kind: entry.kind,
        expectedCatalogRevision: catalogRevision,
        key: entry.key,
      };
      return action === "thread-reset"
        ? { command: "threadReset", input: base }
        : {
            command: "threadSetEnabled",
            input: { ...base, enabled: action === "thread-enable" },
          };
    }
    case "delete":
    case "enable":
    case "disable":
      if (entry.id === undefined || target.projectId !== null) return null;
      if (action === "delete")
        return {
          command: "environmentDelete",
          input: {
            environmentId,
            kind: entry.kind,
            id: entry.id,
            expectedRevision: entry.revision,
          },
        };
      return {
        command: "environmentSetEnabled",
        input: {
          environmentId,
          kind: entry.kind,
          id: entry.id,
          expectedRevision: entry.revision,
          enabled: action === "enable",
        },
      };
    case "disable-project":
    case "reset-project":
      if (target.projectId === null) return null;
      return {
        command: action === "disable-project" ? "projectSetDisabled" : "projectDeleteState",
        input: {
          projectId: target.projectId,
          kind: entry.kind,
          expectedCatalogRevision: catalogRevision,
          key: entry.key,
        },
      };
    default:
      return null;
  }
}

const decodeTextKey = Schema.decodeUnknownOption(ManagedTextResourceKey);
const decodeTextName = Schema.decodeUnknownOption(ManagedTextResourceName);
const decodeBody = Schema.decodeUnknownOption(ManagedTextResourceBody);

export interface TextForm {
  readonly key: string;
  readonly name: string;
  readonly body: string;
}

export function buildTextSave(input: {
  readonly form: TextForm;
  /** Where the form and tokens were loaded for. */
  readonly destination: ResourceEditorDestination<ManagedTextResourceKind>;
  /** Where the screen points now; a mismatch saves nothing. */
  readonly current: ResourceEditorDestination<ManagedTextResourceKind>;
  readonly catalogRevision: ManagedTextResourceCatalogRevision;
  /** The environment entry being edited, at the revision its content was loaded from. */
  readonly editing: ManagedTextResourceSummary | null;
}):
  | { readonly ok: true; readonly mutation: TextMutation }
  | { readonly ok: false; readonly error: string } {
  const { form, destination } = input;
  if (resourceEditorDestinationKey(destination) !== resourceEditorDestinationKey(input.current))
    return { ok: false, error: DESTINATION_CHANGED };
  const target = destination;
  const kind = destination.resource;
  if (
    input.editing !== null &&
    (input.editing.kind !== kind || input.editing.key !== destination.identity)
  )
    return { ok: false, error: DESTINATION_CHANGED };
  const key = decodeTextKey(form.key.trim());
  const body = decodeBody(form.body);
  const nameText = form.name.trim();
  const name = decodeTextName(nameText);
  if (key._tag === "None")
    return { ok: false, error: "Use lowercase letters, numbers and single dashes for the key." };
  if (body._tag === "None") return { ok: false, error: "Text is limited to 64 KB." };
  if (nameText.length > 0 && name._tag === "None")
    return { ok: false, error: "The name is too long." };
  const named = name._tag === "Some" ? { name: name.value } : {};
  const editing = input.editing;
  if (
    editing !== null &&
    editing.scope === "environment" &&
    editing.id !== undefined &&
    target.projectId === null
  )
    return {
      ok: true,
      mutation: {
        command: "environmentUpdate",
        input: {
          environmentId: target.environmentId,
          kind: editing.kind,
          id: editing.id,
          expectedRevision: editing.revision,
          ...named,
          body: body.value,
        },
      },
    };
  if (target.projectId !== null)
    return {
      ok: true,
      mutation: {
        command: "projectSetOverride",
        input: {
          projectId: target.projectId,
          kind,
          expectedCatalogRevision: input.catalogRevision,
          key: key.value,
          ...named,
          body: body.value,
        },
      },
    };
  return {
    ok: true,
    mutation: {
      command: "environmentCreate",
      input: {
        environmentId: target.environmentId,
        kind,
        expectedCatalogRevision: input.catalogRevision,
        key: key.value,
        ...named,
        body: body.value,
      },
    },
  };
}
