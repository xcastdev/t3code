import type {
  PluginAttachRequest,
  PluginHostContext,
} from "@t3tools/client-runtime/plugins/bridge";
import {
  PluginReferenceContextRecord,
  type EnvironmentId,
  type PluginId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useComposerDraftStore, type ComposerThreadTarget } from "../composerDraftStore";
import { pluginReferenceContextRecord } from "../lib/composerContextRecords";

/** The panel sees only `key` and `title`; the rest says where an attach lands. */
export type PluginChatTarget =
  | (NonNullable<PluginHostContext["chatTarget"]> & {
      readonly composerTarget: ComposerThreadTarget;
      readonly environmentId: EnvironmentId | null;
    })
  | null;

/** The plugin asking to attach. Client-only plugins have no environment. */
export type PluginAttachSource =
  | { readonly kind: "client"; readonly pluginId: PluginId; readonly pluginName: string }
  | {
      readonly kind: "environment";
      readonly environmentId: EnvironmentId;
      readonly environmentLabel: string;
      readonly pluginId: PluginId;
      readonly pluginName: string;
    };

export interface PluginAttachConfirmation {
  readonly pluginName: string;
  readonly kind: PluginAttachRequest["kind"];
  readonly destinationTitle: string;
}

const isPluginReferenceContextRecord = Schema.is(PluginReferenceContextRecord);

/**
 * The bridge's `attach`. Nothing lands in a chat the user has not seen named: a destination that
 * changed since the panel asked, and every reference, wait for `confirm`.
 */
export async function attachPluginRequestToChat(
  request: PluginAttachRequest,
  options: {
    readonly chatTarget: PluginChatTarget;
    readonly source: PluginAttachSource;
    readonly confirm: (confirmation: PluginAttachConfirmation) => Promise<boolean>;
  },
): Promise<"inserted" | "cancelled"> {
  const { chatTarget, source } = options;
  if (chatTarget === null) throw new Error("Open a chat to attach this.");
  const record =
    request.kind === "reference"
      ? referenceRecord(request, source, chatTarget.environmentId)
      : null;
  if (request.kind === "reference" || request.expectedChatTargetKey !== chatTarget.key) {
    const confirmed = await options.confirm({
      pluginName: source.pluginName,
      kind: request.kind,
      destinationTitle: chatTarget.title,
    });
    if (!confirmed) return "cancelled";
  }
  const target = chatTarget.composerTarget;
  const store = useComposerDraftStore.getState();
  if (record !== null) {
    store.addPluginReferences(target, [record]);
  } else if (request.kind === "text") {
    const prompt = store.getComposerDraft(target)?.prompt ?? "";
    store.setPrompt(target, prompt.length === 0 ? request.text : `${prompt}\n${request.text}`);
  }
  return "inserted";
}

function referenceRecord(
  request: Extract<PluginAttachRequest, { kind: "reference" }>,
  source: PluginAttachSource,
  chatEnvironmentId: EnvironmentId | null,
): PluginReferenceContextRecord {
  if (source.kind === "client") {
    throw new Error("Only plugins installed in an environment can attach references.");
  }
  if (chatEnvironmentId !== source.environmentId) {
    throw new Error(
      `This capture belongs to ${source.environmentLabel}; attach it from a chat in that environment.`,
    );
  }
  const record = pluginReferenceContextRecord({
    environmentId: source.environmentId,
    pluginId: source.pluginId,
    pluginName: source.pluginName,
    label: request.label,
    locator: request.locator,
    snapshot: request.snapshot,
  });
  if (!isPluginReferenceContextRecord(record)) {
    throw new Error("This reference has an invalid locator.");
  }
  return record;
}
