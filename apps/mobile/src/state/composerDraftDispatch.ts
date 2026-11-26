import type { ComposerDraft } from "./use-composer-drafts";

export function resolveComposerDraftDispatchSnapshot(
  current: ComposerDraft,
  expected: ComposerDraft,
): ComposerDraft | null {
  if (
    current.text !== expected.text ||
    JSON.stringify(current.context) !== JSON.stringify(expected.context) ||
    JSON.stringify(current.modelSelection) !== JSON.stringify(expected.modelSelection) ||
    current.runtimeMode !== expected.runtimeMode ||
    current.interactionMode !== expected.interactionMode ||
    current.attachments.length !== expected.attachments.length ||
    current.attachments.some(
      (attachment, index) => attachment.id !== expected.attachments[index]?.id,
    )
  )
    return null;
  return current;
}
