// Refusal details reach the panel as text only (operation-failed detail), so the panel
// classifies them against these constants. Keep this module free of imports: ui/ bundles it.

export const MISSING_DETAILS = {
  request: "This request no longer exists.",
  recording: "This recording no longer exists.",
  proxy: "This proxy does not exist. Call list_proxies for the ids.",
  export: "This export no longer exists. Call export_requests again.",
  target: "This thread or project does not exist.",
} as const;

export const PROXY_DETAILS = {
  deleted: "This proxy was deleted.",
  running: "This proxy is running. Stop it with stop_proxy before deleting it.",
  limit: "8 proxies are already running. Stop one with stop_proxy first.",
  tooMany: "32 proxies exist. Delete one with delete_proxy before creating another.",
  notRunning: "This proxy is not running. Call start_proxy first, then start_recording.",
  alreadyRecording: "This proxy is already recording.",
  recordingOpen: "Stop this proxy's recording before deleting it.",
  upstreamWithSocks5:
    "SOCKS5 listening cannot be combined with an upstream proxy: mitmproxy's upstream mode is HTTP(S) only.",
  noCallerThread: 'This call has no caller thread. Pass target: { "threadId": ... } instead.',
  noCallerProject: 'This call has no caller project. Pass target: { "projectId": ... } instead.',
  linkTarget: "A link needs a thread or project id.",
  agentListenHost:
    "Agents can only listen on loopback (127.0.0.1, ::1, localhost) or the listen host set in the Request Inspector settings. Ask the user to choose another listen host in the panel.",
} as const;

export const RECORDING_DETAILS = {
  open: "Stop the recording before deleting it.",
  replaysPending: "This recording has replays in progress. Delete it after they finish.",
} as const;

export const IMPORT_DETAILS = {
  source:
    "Pass either path (a flow file on the T3 machine) or uploadId (from import_upload_write), not both.",
  relativePath: "path must be absolute, or start with ~/.",
  notAFile: "There is no readable file at that path on the T3 machine.",
  uploadMissing: "The upload no longer exists. Upload the file again.",
  uploadSize: "The first chunk of an upload must give the file's total size in bytes.",
  uploadTooLarge:
    "The file is larger than half the inspector's storage budget (or 1 GiB). Import it by its path on the T3 machine, or raise maxDiskBytes in the inspector's settings.",
  limit: "2 imports are already running. Wait for one to finish.",
  missing: "No import is known for this recording. The inspector forgets imports when it restarts.",
  noFlows: "The file holds no HTTP flows.",
  deleted: "The recording was deleted during the import.",
  exited: "mitmdump exited before the import finished.",
  proxyBusy: "This proxy has an import running. Wait for it, or delete its recording to stop it.",
} as const;

export const NSS_DETAILS = {
  unsupported: "Browser certificate databases are managed on Linux only.",
  certutilMissing:
    "certutil is not on PATH. Install the NSS tools (libnss3-tools or nss-tools) and try again.",
} as const;

export const EXPORT_DETAILS = {
  tooLarge: "The export is larger than 32 MiB. Narrow it with requestIds or a filter.",
  inlineTooLarge: 'The export is too large to return inline. Use output "auto" or "file".',
  needsScope: "Pass requestIds or a filter, not both.",
  storageFull:
    "The inspector's storage budget is full. Delete recordings with delete_recording or raise maxDiskBytes in the inspector's settings, then export again.",
} as const;

/** decode_value refuses a credential header source for an agent that did not opt in. */
export const sensitiveHeaderDetail = (header: string) =>
  `${header} is a credential header; pass includeSensitiveHeaders: true only when the user needs its value.`;

const NO_DEFAULT_PROXY_PREFIX = "No proxy is linked to this thread or its project.";

export interface DefaultProxyCandidate {
  readonly proxyId: string;
  readonly name: string;
  readonly link: "parentThread" | "rootThread" | null;
}

const MAX_LISTED_CANDIDATES = 20;

/** Candidates come ranked: the parent thread's proxy first, then the root thread's. */
export function noDefaultProxyDetail(candidates: ReadonlyArray<DefaultProxyCandidate>): string {
  if (candidates.length === 0) {
    return `${NO_DEFAULT_PROXY_PREFIX} No proxies exist. Call create_proxy.`;
  }
  const listed = candidates.slice(0, MAX_LISTED_CANDIDATES).map((candidate) => {
    const via =
      candidate.link === "parentThread"
        ? ", linked to the parent thread"
        : candidate.link === "rootThread"
          ? ", linked to the root thread"
          : "";
    return `${candidate.proxyId} (${candidate.name.slice(0, 32)}${via})`;
  });
  const more = candidates.length > MAX_LISTED_CANDIDATES ? ", …" : "";
  return `${NO_DEFAULT_PROXY_PREFIX} Pass proxyId. Candidates: ${listed.join(", ")}${more}.`;
}

export const isNoDefaultProxyDetail = (detail: string) =>
  detail.startsWith(NO_DEFAULT_PROXY_PREFIX);

const INVALID_HOST_PATTERN_PREFIX = "Invalid host pattern ";

export const invalidHostPatternDetail = (pattern: string, reason: string) =>
  `${INVALID_HOST_PATTERN_PREFIX}${JSON.stringify(pattern.slice(0, 255))}: ${reason}`;

export const isInvalidHostPatternDetail = (detail: string) =>
  detail.startsWith(INVALID_HOST_PATTERN_PREFIX);

export const STORAGE_FULL_DETAIL =
  "Not sent: the inspector's storage budget is full. Delete recordings with delete_recording or raise maxDiskBytes in the inspector's settings.";

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
