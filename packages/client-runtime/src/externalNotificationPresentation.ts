import {
  DEFAULT_EXTERNAL_NOTIFICATION_EVENTS,
  SECRET_REDACTED,
  type ExternalNotificationDestination,
  type ExternalNotificationSettings,
  type ExternalNotificationTestResult,
} from "@t3tools/contracts";

export type CredentialDraft =
  | { readonly kind: "stored" }
  | { readonly kind: "none" }
  | { readonly kind: "replace"; readonly value: string }
  | { readonly kind: "clear" };

export interface DestinationDraft {
  readonly id: string;
  readonly name: string;
  readonly kind: ExternalNotificationDestination["kind"];
  readonly enabled: boolean;
  readonly events: ExternalNotificationDestination["events"];
  readonly url: CredentialDraft;
  readonly signingKey: CredentialDraft;
}

export interface DestinationEditorDraft {
  readonly destinations: ReadonlyArray<DestinationDraft>;
  readonly original: ExternalNotificationSettings | undefined;
}

export const MAX_DESTINATIONS = 16;

export function credentialDraft(value: string, saved?: string): CredentialDraft {
  if (value.length > 0) return { kind: "replace", value };
  return saved ? { kind: "stored" } : { kind: "none" };
}

export function destinationDrafts(
  saved: ReadonlyArray<ExternalNotificationDestination>,
): ReadonlyArray<DestinationDraft> {
  return saved.map((destination) => ({
    id: destination.id,
    name: destination.name,
    kind: destination.kind,
    enabled: destination.enabled,
    events: destination.events,
    url: credentialDraft("", destination.webhookUrl),
    signingKey: credentialDraft("", destination.signingKey),
  }));
}

export function newDestinationDraft(id: string, name: string): DestinationDraft {
  return {
    id,
    name,
    kind: "home-assistant",
    enabled: false,
    events: DEFAULT_EXTERNAL_NOTIFICATION_EVENTS,
    url: { kind: "none" },
    signingKey: { kind: "none" },
  };
}

function credentialPatch(draft: CredentialDraft, saved?: string): string {
  if (draft.kind === "stored") return saved ?? "";
  if (draft.kind === "replace") return draft.value;
  return "";
}

export function destinationsPatch(
  drafts: ReadonlyArray<DestinationDraft>,
  saved: ReadonlyArray<ExternalNotificationDestination>,
  supportsWebhookOptions: boolean,
): ReadonlyArray<ExternalNotificationDestination> {
  return drafts.map((draft) => {
    const original = saved.find((destination) => destination.id === draft.id);
    const signingKey =
      draft.signingKey.kind === "clear"
        ? ""
        : draft.kind === "generic-webhook" && draft.signingKey.kind === "replace"
          ? draft.signingKey.value
          : undefined;
    return {
      id: draft.id,
      name: draft.name.trim(),
      kind: draft.kind,
      enabled: draft.enabled,
      ...(draft.events === undefined ? {} : { events: draft.events }),
      webhookUrl:
        supportsWebhookOptions &&
        original &&
        (draft.url.kind === "none" || draft.url.kind === "stored")
          ? SECRET_REDACTED
          : credentialPatch(draft.url, original?.webhookUrl).trim(),
      ...(signingKey === undefined ? {} : { signingKey }),
    };
  });
}

export function destinationDraftsChanged(
  drafts: ReadonlyArray<DestinationDraft>,
  saved: ReadonlyArray<ExternalNotificationDestination>,
): boolean {
  const original = destinationDrafts(saved);
  return (
    drafts.length !== original.length ||
    drafts.some((draft, index) => {
      const entry = original[index];
      return (
        entry === undefined ||
        draft.id !== entry.id ||
        draft.name !== entry.name ||
        draft.kind !== entry.kind ||
        draft.enabled !== entry.enabled ||
        draft.events?.length !== entry.events?.length ||
        draft.events?.some((event) => !entry.events?.includes(event)) ||
        draft.url.kind !== entry.url.kind ||
        draft.signingKey.kind !== entry.signingKey.kind
      );
    })
  );
}

export function updateDestinationEditorDraft(
  previous: DestinationEditorDraft | null,
  saved: ExternalNotificationSettings | undefined,
  destinations: ReadonlyArray<DestinationDraft> | null,
): DestinationEditorDraft | null {
  const original = previous === null ? saved : previous.original;
  if (
    destinations === null ||
    !destinationDraftsChanged(destinations, original?.destinations ?? [])
  ) {
    return null;
  }
  return { destinations, original };
}

function isWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function destinationDraftsError(drafts: ReadonlyArray<DestinationDraft>) {
  if (drafts.length > MAX_DESTINATIONS) return "too-many";
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (name.length === 0) return "empty-name";
    if (name.length > 128) return "long-name";
    if (draft.url.kind === "replace" && !isWebhookUrl(draft.url.value.trim())) return "invalid-url";
  }
  return null;
}

export function destinationTestBlocked(input: {
  readonly draft: DestinationDraft;
  readonly saved: ReadonlyArray<ExternalNotificationDestination>;
  readonly dirty: boolean;
}) {
  const original = input.saved.find((destination) => destination.id === input.draft.id);
  if (original === undefined) return "new";
  if (input.dirty) return "dirty";
  if (original.webhookUrl.length === 0) return "missing-url";
  return null;
}

export function describeTestResult(result: ExternalNotificationTestResult) {
  return {
    delivered: result.status === "delivered",
    message: result.status === "delivered" ? "delivered" : (result.reason ?? "failed"),
  } as const;
}

export function describeExternalNotificationCommandFailure(error: unknown) {
  if (error !== null && typeof error === "object" && "_tag" in error) {
    if (error._tag === "EnvironmentAuthorizationError") return "unauthorized";
    if (error._tag === "EnvironmentRpcUnavailableError") return "offline";
  }
  return "command-failed";
}
