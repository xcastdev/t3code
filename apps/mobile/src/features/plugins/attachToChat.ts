import type {
  PluginAttachRequest,
  PluginHostContext,
} from "@t3tools/client-runtime/plugins/bridge";
import {
  COMPOSER_CONTEXT_LABEL_MAX_CHARS,
  COMPOSER_CONTEXT_PLUGIN_SNAPSHOT_MAX_CHARS,
  PluginReferenceContextRecord,
  type PluginManifest,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import {
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  setComposerDraftText,
} from "../../state/use-composer-drafts";
import type { PluginChatThread } from "./recentChat";

const decodeReference = Schema.decodeUnknownOption(PluginReferenceContextRecord);

const PREVIEW_CHARS = 400;

const confirmAttach = (title: string, message: string) =>
  new Promise<boolean>((resolve) => {
    Dialog.alert(
      title,
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Attach", onPress: () => resolve(true) },
      ],
      // Android dismisses earlier alerts when showing another; a dismissed request is declined.
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

const preview = (text: string) =>
  text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;

/**
 * The bridge's `attach` on mobile. The panel screen is never beside its chat, so every attach
 * names the destination thread and waits for the user to confirm it.
 */
export async function attachPluginRequestToChat(input: {
  readonly request: PluginAttachRequest;
  readonly chat: PluginChatThread | null;
  readonly manifest: PluginManifest;
  readonly destination: PluginHostContext["destination"];
}): Promise<"inserted" | "cancelled"> {
  const { request, chat, manifest, destination } = input;
  if (chat === null) throw new Error("Open a chat to attach this.");
  if (request.kind === "text") {
    if (!(await confirmAttach(`Attach to “${chat.title}”?`, preview(request.text)))) {
      return "cancelled";
    }
    const prompt = getComposerDraftSnapshot(chat.key).text;
    setComposerDraftText(
      chat.key,
      prompt.length === 0 ? request.text : `${prompt}\n${request.text}`,
    );
    return "inserted";
  }
  if (destination.kind !== "environment" || destination.environmentId !== chat.environmentId) {
    const owner = destination.kind === "environment" ? destination.label : "this device";
    throw new Error(`This capture belongs to ${owner}; attach it from a chat in that environment.`);
  }
  const snapshotTruncated = request.snapshot.length > COMPOSER_CONTEXT_PLUGIN_SNAPSHOT_MAX_CHARS;
  const record = decodeReference({
    version: 1,
    kind: "plugin-reference",
    referenceVersion: 1,
    contextId: uuidv4(),
    label: request.label.slice(0, COMPOSER_CONTEXT_LABEL_MAX_CHARS),
    environmentId: destination.environmentId,
    pluginId: manifest.id,
    pluginName: manifest.name.slice(0, 64),
    locator: request.locator,
    snapshot: request.snapshot.slice(0, COMPOSER_CONTEXT_PLUGIN_SNAPSHOT_MAX_CHARS),
    snapshotTruncated,
  });
  if (Option.isNone(record)) throw new Error("This reference cannot be attached.");
  if (
    !(await confirmAttach(
      `Attach to “${chat.title}”?`,
      `${manifest.name}: ${request.label}\n\n${preview(request.snapshot)}`,
    ))
  ) {
    return "cancelled";
  }
  const draft = getComposerDraftSnapshot(chat.key);
  const inserted = insertComposerDraftContext(
    chat.key,
    {
      text: `${formatComposerContextReference(record.value)} `,
      context: { version: 1, records: [record.value] },
    },
    { text: draft.text, start: draft.text.length, end: draft.text.length },
  );
  if (!inserted) throw new Error("Remove some context from this thread's draft, then try again.");
  return "inserted";
}
