// Refusal details reach the panel as text only (operation-failed detail), so the panel
// classifies them against these constants. Keep this module free of imports: ui/ bundles it.

export const MISSING_DETAILS = {
  request: "This request no longer exists.",
  capture: "This capture no longer exists.",
} as const;

export const STORAGE_FULL_DETAIL =
  "Not sent: the inspector's storage budget is full. Delete captures or raise maxDiskBytes.";

export const DRAFT_MISSING_DETAIL =
  "Not sent: the body draft no longer exists. Upload the body again.";

export const REPLAY_DETAILS = {
  conflict: "This idempotency key was already used for a different replay.",
  notIssued:
    "This idempotency key was not issued by this inspector. If you are retrying, the key may have been copied wrong, and the replay that used the correct key may have been sent. Call preview_replay for a new key only if a new replay is intended.",
  expired:
    "This idempotency key has expired. A replay that used it may have been sent and is no longer kept. Call preview_replay for a new key only if a new replay is intended.",
  pendingCap: "Not sent: 20 replays are in progress. Wait for one to settle.",
  httpOnly: "Only HTTP requests can be replayed.",
  aborted: "Not sent: the call was cancelled before the replay was accepted.",
  notStarted: "Not sent: mitmdump did not start.",
  intentFailed: "Not sent: the inspector could not record the handoff to mitmdump.",
  stopped: "Not sent: the plugin stopped.",
  interrupted: "Interrupted after handoff; the upstream may have received it.",
  noResponse: "No response within 30 s; the upstream may have received it.",
  responseNotStored: "Response not stored: the inspector's storage budget is full.",
  sourceMissing: MISSING_DETAILS.request,
  replayMissing:
    "This replay is not kept. It settled long ago and left the inspector's replay history.",
} as const;

/** replay_request input refusals; each means nothing was recorded or sent. */
export const REPLAY_INPUT_DETAILS = {
  keyRequired: "idempotencyKey is required. Call preview_replay for one.",
  headersShape: "edits.headers must be an array of pairs.",
  headerPairs: "edits.headers must be an array of [name, value] string pairs.",
  bodyShape: 'edits.body must be { kind: "inline", base64 } or { kind: "draft", draftId }.',
  url: "edits.url must be an absolute http or https URL.",
  method: "edits.method is not a valid HTTP method.",
  base64: "base64 is not valid base64.",
} as const;

export const mustBeDetail = (key: string, type: "a string" | "an integer") =>
  `${key} must be ${type}.`;

const INCOMPLETE_BODY_PREFIX = "The captured request body is incomplete (";

export const incompleteBodyDetail = (captured: number, declared: number | undefined) =>
  `${INCOMPLETE_BODY_PREFIX}${captured} of ${declared ?? "unknown"} bytes). Provide a replacement body to replay.`;

const MAYBE_SENT: ReadonlySet<string> = new Set([
  REPLAY_DETAILS.conflict,
  REPLAY_DETAILS.notIssued,
  REPLAY_DETAILS.expired,
]);

const NOT_SENT: ReadonlySet<string> = new Set([
  STORAGE_FULL_DETAIL,
  DRAFT_MISSING_DETAIL,
  REPLAY_DETAILS.pendingCap,
  REPLAY_DETAILS.httpOnly,
  REPLAY_DETAILS.aborted,
  REPLAY_DETAILS.sourceMissing,
  ...Object.values(REPLAY_INPUT_DETAILS),
  ...["idempotencyKey", "method", "url"].map((key) => mustBeDetail(key, "a string")),
]);

/** What a replay_request refusal says about whether an earlier replay may have been sent. */
export function replayRefusalOutcome(detail: string): "maybe-sent" | "not-sent" | "unconfirmed" {
  if (MAYBE_SENT.has(detail)) return "maybe-sent";
  if (NOT_SENT.has(detail) || detail.startsWith(INCOMPLETE_BODY_PREFIX)) return "not-sent";
  return "unconfirmed";
}
