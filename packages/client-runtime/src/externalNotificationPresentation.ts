import type {
  ExternalNotificationDestination,
  ExternalNotificationTestResult,
} from "@t3tools/contracts";

/**
 * A saved webhook URL is a secret the server only returns redacted. The form
 * never holds or shows it: it is kept as stored, replaced, or cleared.
 */
export type WebhookUrlDraft =
  | { readonly kind: "stored" }
  | { readonly kind: "none" }
  | { readonly kind: "replace"; readonly value: string }
  | { readonly kind: "clear" };

export interface DestinationDraft {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly url: WebhookUrlDraft;
}

export const MAX_DESTINATIONS = 16;

export function destinationDrafts(
  saved: ReadonlyArray<ExternalNotificationDestination>,
): ReadonlyArray<DestinationDraft> {
  return saved.map((destination) => ({
    id: destination.id,
    name: destination.name,
    enabled: destination.enabled,
    url: destination.webhookUrl.length > 0 ? { kind: "stored" } : { kind: "none" },
  }));
}

/** New destinations start off, so adding one never sends anything. */
export function newDestinationDraft(id: string): DestinationDraft {
  return { id, name: "Home Assistant", enabled: false, url: { kind: "none" } };
}

/**
 * The full replacement array. A kept URL is sent back exactly as the server
 * redacted it, which the server reads as "unchanged"; an empty one clears it.
 */
export function destinationsPatch(
  drafts: ReadonlyArray<DestinationDraft>,
  saved: ReadonlyArray<ExternalNotificationDestination>,
): ReadonlyArray<ExternalNotificationDestination> {
  return drafts.map((draft) => {
    const original = saved.find((destination) => destination.id === draft.id);
    const webhookUrl =
      draft.url.kind === "stored"
        ? (original?.webhookUrl ?? "")
        : draft.url.kind === "replace"
          ? draft.url.value.trim()
          : "";
    return {
      id: draft.id,
      name: draft.name.trim(),
      kind: "home-assistant",
      enabled: draft.enabled,
      webhookUrl,
    };
  });
}

export function destinationDraftsChanged(
  drafts: ReadonlyArray<DestinationDraft>,
  saved: ReadonlyArray<ExternalNotificationDestination>,
): boolean {
  return JSON.stringify(drafts) !== JSON.stringify(destinationDrafts(saved));
}

function isWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Errors name the destination, never the URL. */
export function destinationDraftsError(drafts: ReadonlyArray<DestinationDraft>): string | null {
  if (drafts.length > MAX_DESTINATIONS) return `Keep at most ${MAX_DESTINATIONS} destinations.`;
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (name.length === 0) return "Give each destination a name.";
    if (name.length > 128) return `Shorten the name "${name.slice(0, 32)}…".`;
    if (draft.url.kind === "replace" && !isWebhookUrl(draft.url.value.trim()))
      return `Enter a full http or https webhook URL for "${name}".`;
  }
  return null;
}

/**
 * Tests use only the saved destination by ID, so a destination with unsaved
 * edits, or none saved yet, must be saved first.
 */
export function destinationTestBlocked(input: {
  readonly draft: DestinationDraft;
  readonly saved: ReadonlyArray<ExternalNotificationDestination>;
  readonly dirty: boolean;
}): string | null {
  const original = input.saved.find((destination) => destination.id === input.draft.id);
  if (original === undefined) return "Save this destination before testing it.";
  if (input.dirty) return "Save your changes before testing.";
  if (original.webhookUrl.length === 0) return "Add a webhook URL and save before testing.";
  return null;
}

const TEST_FAILURES: Record<NonNullable<ExternalNotificationTestResult["reason"]>, string> = {
  unconfigured: "No webhook URL is saved for this destination.",
  "malformed-url": "The saved webhook URL isn't valid. Replace it and save.",
  transport: "Couldn't reach the webhook from the server.",
  timeout: "The webhook didn't answer in time.",
  "http-status": "The webhook answered with an error status.",
};

export function describeTestResult(result: ExternalNotificationTestResult): {
  readonly delivered: boolean;
  readonly message: string;
} {
  if (result.status === "delivered")
    return { delivered: true, message: "Test notification delivered." };
  return {
    delivered: false,
    message:
      (result.reason === undefined ? undefined : TEST_FAILURES[result.reason]) ??
      "The test notification wasn't delivered.",
  };
}
