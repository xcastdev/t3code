import type { EnvironmentId } from "@t3tools/contracts";
import {
  RELAY_ADMISSION_ACTIVE,
  RELAY_ADMISSION_HEADER,
  RELAY_ADMISSION_PATH,
  RELAY_ADMISSION_RETIRED,
} from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { assertHostedRelayAdmission } from "../connection/hostedRelayAdmission";
import {
  fetchEnvironmentResource,
  requiresDesktopRelayTransport,
  signedTransferCredentials,
} from "../connection/environmentTransport";
import {
  isOperatorBoundBrowserRoute,
  readOperatorBrowserBinding,
  verifiedRoutePolicy,
} from "../connection/verifiedRoute";

const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const ADMISSION_INTERVAL_MS = 2_000;
const ADMISSION_TIMEOUT_MS = 3_000;

class AttachmentUploadOutcomeUnknown extends Schema.TaggedError<
  AttachmentUploadOutcomeUnknown,
  { readonly brand: unique symbol }
>()("AttachmentUploadOutcomeUnknown", { retired: Schema.Boolean }) {
  override get message() {
    return this.retired
      ? "Upload outcome unknown because the relay route was retired."
      : "The server did not confirm whether the upload finished.";
  }
}

export const isAttachmentUploadOutcomeUnknown = Schema.is(AttachmentUploadOutcomeUnknown);

function readAdmission(url: string, signal: AbortSignal) {
  const send = requiresDesktopRelayTransport(url) ? fetchEnvironmentResource : globalThis.fetch;
  return send(url, {
    method: "HEAD",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.any([signal, AbortSignal.timeout(ADMISSION_TIMEOUT_MS)]),
  }).catch(() => null);
}

function isAdmission(response: Response | null, expected: { status: number; marker: string }) {
  return (
    response?.status === expected.status &&
    response.headers.get(RELAY_ADMISSION_HEADER) === expected.marker
  );
}

export async function uploadAttachmentBytes(input: {
  readonly environmentId: EnvironmentId;
  readonly verificationRequired: true | undefined;
  readonly url: string;
  readonly file: File;
  readonly mimeType: string;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: number) => void;
}): Promise<void> {
  const url = new URL(input.url);
  const operatorBound = isOperatorBoundBrowserRoute(url);
  const desktopRelay = requiresDesktopRelayTransport(url.href);
  const browserBinding = operatorBound ? readOperatorBrowserBinding(url.origin) : null;
  const verificationRequired = input.verificationRequired || desktopRelay;
  const binding =
    browserBinding ??
    (verificationRequired
      ? await Effect.runPromise(verifiedRoutePolicy.readEnrollment(url.origin))
      : null);
  if (
    (verificationRequired &&
      (binding === null || !(await Effect.runPromise(verifiedRoutePolicy.enforce(binding))))) ||
    (binding !== null &&
      (binding.environmentId !== input.environmentId ||
        binding.httpsOrigin !== url.origin ||
        (binding.transportRole === "relay" &&
          typeof window !== "undefined" &&
          window.desktopBridge !== undefined &&
          !desktopRelay) ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !/^\/api\/attachments\/upload\/[^/]+$/u.test(url.pathname)))
  ) {
    throw new Error("The upload issuer does not match the installed route policy.");
  }
  if (binding?.transportRole === "relay") assertHostedRelayAdmission(binding);
  const verifiedFetch = operatorBound || desktopRelay;
  const xhr = verifiedFetch ? null : new XMLHttpRequest();
  const transferAbort = verifiedFetch ? new AbortController() : null;
  return new Promise<void>((resolve, reject) => {
    const admission = url.protocol === "https:" ? new AbortController() : null;
    const admissionUrl = new URL(RELAY_ADMISSION_PATH, url.origin).href;
    let admissionTimer: ReturnType<typeof setTimeout> | undefined;
    let supportsAdmission = false;
    let checkingOutcome = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(admissionTimer);
      admission?.abort();
      input.signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve();
    };
    const abortTransfer = (error: Error) => {
      finish(error);
      transferAbort?.abort();
      xhr?.abort();
    };
    const cancel = () => abortTransfer(new Error("Upload cancelled"));
    const finishAfterInterruption = async (error: Error) => {
      if (settled || checkingOutcome) return;
      if (admission === null) return finish(error);
      checkingOutcome = true;
      clearTimeout(admissionTimer);
      const response = await readAdmission(admissionUrl, admission.signal);
      const retired = isAdmission(response, RELAY_ADMISSION_RETIRED);
      const inconclusive =
        response === null ||
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      if (
        retired ||
        inconclusive ||
        supportsAdmission ||
        isAdmission(response, RELAY_ADMISSION_ACTIVE)
      ) {
        finish(new AttachmentUploadOutcomeUnknown({ retired }));
        return;
      }
      finish(error);
    };

    if (input.signal.aborted) {
      finish(new Error("Upload cancelled"));
      return;
    }
    const onResponse = (status: number) => {
      if (status >= 200 && status < 300) return finish();
      const error = new Error(`Upload rejected (${status})`);
      if (status === 410 || status >= 500) {
        void finishAfterInterruption(error);
      } else {
        finish(error);
      }
    };
    input.signal.addEventListener("abort", cancel, { once: true });
    if (xhr !== null) {
      xhr.open("POST", input.url, true);
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      xhr.setRequestHeader("Content-Type", input.mimeType);
      xhr.upload.addEventListener("progress", (event) => {
        if (!settled && event.lengthComputable && event.total > 0) {
          input.onProgress(event.loaded / event.total);
        }
      });
      xhr.addEventListener("load", () => onResponse(xhr.status));
      xhr.addEventListener("error", () => void finishAfterInterruption(new Error("Upload failed")));
      xhr.addEventListener(
        "timeout",
        () => void finishAfterInterruption(new Error("Upload timed out")),
      );
      xhr.addEventListener("abort", () => finish(new Error("Upload cancelled")));
      try {
        xhr.send(input.file);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Upload failed", { cause: error }));
      }
    } else if (transferAbort !== null) {
      // XHR can resend the body on a 307/308. Fetch refuses redirects before a second request.
      input.onProgress(0);
      void fetchEnvironmentResource(input.url, {
        method: "POST",
        body: input.file,
        headers: { "Content-Type": input.mimeType },
        credentials: signedTransferCredentials(url),
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([transferAbort.signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]),
      }).then(
        (response) => onResponse(response.status),
        () => void finishAfterInterruption(new Error("Upload failed")),
      );
    }

    if (admission === null || settled) return;
    let retryDiscovery = true;
    // A stalled upload may outlive its socket, so check admission at the HTTP origin.
    const checkAdmission = async () => {
      const response = await readAdmission(admissionUrl, admission.signal);
      if (settled) return;
      if (isAdmission(response, RELAY_ADMISSION_RETIRED)) {
        abortTransfer(new AttachmentUploadOutcomeUnknown({ retired: true }));
        return;
      }
      supportsAdmission ||= isAdmission(response, RELAY_ADMISSION_ACTIVE);
      if (checkingOutcome) return;
      if (supportsAdmission || (retryDiscovery && (response === null || response.status >= 500))) {
        retryDiscovery = false;
        admissionTimer = setTimeout(checkAdmission, ADMISSION_INTERVAL_MS);
      }
    };
    void checkAdmission();
  });
}
