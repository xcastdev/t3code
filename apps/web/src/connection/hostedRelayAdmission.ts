import type { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import { HostedRelayAdmissionRequiredError } from "@t3tools/client-runtime/rpc";
import { EnvironmentId, type VerifiedRouteBinding } from "@t3tools/contracts";
import { RELAY_ADMISSION_HEADER } from "@t3tools/contracts/relay";
import {
  RELAY_BROWSER_HANDLE_PATTERN,
  RELAY_BROWSER_TICKETS_PATH,
  RELAY_HOSTED_SESSION_HEADER,
  RELAY_HOSTED_SESSION_PATH,
  RELAY_HOSTED_SESSION_REQUIRED,
  RELAY_HOSTED_WS_PROTOCOL,
  RELAY_HOSTED_WS_PROTOCOL_PREFIX,
} from "@t3tools/contracts/selfHostedRelayHosted";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { listOperatorBrowserBindings, readOperatorBrowserBinding } from "./verifiedRoute";

const MAX_SESSION_MS = 15 * 60_000;
const appOrigin = import.meta.env.VITE_HOSTED_APP_URL?.trim();

interface Admission extends Binding {
  readonly session: Redacted.Redacted<string>;
  readonly expiresAt: number;
  readonly abort: AbortController;
  readonly expiry: ReturnType<typeof setTimeout>;
}

type Binding = Pick<VerifiedRouteBinding, "environmentId" | "httpsOrigin">;
const admissions = new Map<string, Admission>();
const pending = new Map<string, Binding & { abort: AbortController }>();
const listeners = new Set<() => void>();

class HostedRelayAdmissionError extends Schema.TaggedError<
  HostedRelayAdmissionError,
  { readonly brand: unique symbol }
>()("HostedRelayAdmissionError", {}) {
  override get message() {
    return "Hosted relay admission is required. Redeem a new operator ticket for this environment.";
  }
}

function browserOrigin() {
  return typeof window !== "undefined" ? window.location?.origin : undefined;
}

function hostedBinding(url: URL) {
  if (url.protocol !== "https:" && url.protocol !== "wss:") return null;
  const origin = `https://${url.host}`;
  const binding = origin === browserOrigin() ? null : readOperatorBrowserBinding(origin);
  return binding?.transportRole === "relay" ? binding : null;
}

export function hostedAdmissionRequired(url: string): boolean {
  const parsed = URL.parse(url, browserOrigin());
  return parsed !== null && hostedBinding(parsed) !== null;
}

function admissionKey(binding: Binding) {
  return JSON.stringify([binding.environmentId, binding.httpsOrigin, browserOrigin()]);
}

function isApprovedAppOrigin() {
  return appOrigin?.startsWith("https://") === true && appOrigin === browserOrigin();
}

export function listHostedRelayPairingBindings() {
  if (!isApprovedAppOrigin() || window.top !== window) return [];
  return listOperatorBrowserBindings().filter(
    (binding) => binding.transportRole === "relay" && binding.httpsOrigin !== browserOrigin(),
  );
}

export async function submitEnrolledHostedRelayPairing<Result>(
  binding: Binding,
  ticket: string,
  pairingCode: string,
  pair: (input: ConnectionOnboarding.PairingConnectionInput) => Promise<Result>,
): Promise<Result | undefined> {
  if (
    !listHostedRelayPairingBindings().some(
      (candidate) =>
        candidate.environmentId === binding.environmentId &&
        candidate.httpsOrigin === binding.httpsOrigin,
    )
  ) {
    throw new HostedRelayAdmissionError();
  }
  await admitHostedRelay(binding, ticket);
  if (pairingCode) {
    return pair({
      host: binding.httpsOrigin,
      expectedEnvironmentId: EnvironmentId.make(binding.environmentId),
      verificationRequired: true,
      pairingCode,
    });
  }
}

function publish() {
  for (const listener of listeners) listener();
}

export function subscribeHostedRelayAdmission(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function dropAdmission(key: string) {
  const admission = admissions.get(key);
  if (admission === undefined) return false;
  admissions.delete(key);
  clearTimeout(admission.expiry);
  admission.abort.abort(new HostedRelayAdmissionError());
  return true;
}

export function clearHostedRelayAdmission(environmentId?: EnvironmentId, httpsOrigin?: string) {
  const matches = (binding: Binding) =>
    (environmentId === undefined || binding.environmentId === environmentId) &&
    (httpsOrigin === undefined || binding.httpsOrigin === httpsOrigin);
  for (const [key, attempt] of pending) {
    if (!matches(attempt)) continue;
    pending.delete(key);
    attempt.abort.abort(new HostedRelayAdmissionError());
  }
  let changed = false;
  for (const [key, admission] of admissions) {
    if (matches(admission) && dropAdmission(key)) changed = true;
  }
  if (changed) publish();
}

const clearTabAdmission = () => clearHostedRelayAdmission();

export async function admitHostedRelay(binding: Binding, oneUseTicket: string): Promise<void> {
  const url = URL.parse(binding.httpsOrigin);
  const installed = url !== null && url.origin === binding.httpsOrigin ? hostedBinding(url) : null;
  if (
    !isApprovedAppOrigin() ||
    window.top !== window ||
    installed === null ||
    installed.environmentId !== binding.environmentId ||
    !RELAY_BROWSER_HANDLE_PATTERN.test(oneUseTicket)
  ) {
    throw new HostedRelayAdmissionError();
  }
  window.addEventListener("pagehide", clearTabAdmission);
  const key = admissionKey(installed);
  pending.get(key)?.abort.abort(new HostedRelayAdmissionError());
  const attempt = { ...installed, abort: new AbortController() };
  pending.set(key, attempt);
  try {
    const response = await globalThis.fetch(
      `${installed.httpsOrigin}${RELAY_HOSTED_SESSION_PATH}`,
      {
        method: "POST",
        body: JSON.stringify({ ticket: oneUseTicket }),
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([attempt.abort.signal, AbortSignal.timeout(10_000)]),
      },
    );
    if (response.status !== 201) {
      await response.body?.cancel();
      throw new HostedRelayAdmissionError();
    }
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("session" in body) ||
      typeof body.session !== "string" ||
      !RELAY_BROWSER_HANDLE_PATTERN.test(body.session) ||
      !("expiresAt" in body) ||
      typeof body.expiresAt !== "number" ||
      !Number.isSafeInteger(body.expiresAt) ||
      pending.get(key) !== attempt ||
      key !== admissionKey(installed)
    ) {
      throw new HostedRelayAdmissionError();
    }
    const now = Date.now();
    const remaining = body.expiresAt - now;
    if (remaining <= 0) throw new HostedRelayAdmissionError();
    const lifespan = Math.min(remaining, MAX_SESSION_MS);
    dropAdmission(key);
    admissions.set(key, {
      ...installed,
      session: Redacted.make(body.session),
      expiresAt: now + lifespan,
      abort: new AbortController(),
      expiry: setTimeout(() => {
        if (dropAdmission(key)) publish();
      }, lifespan),
    });
    publish();
  } catch {
    throw new HostedRelayAdmissionError();
  } finally {
    if (pending.get(key) === attempt) pending.delete(key);
  }
}

function requireAdmission(binding: Binding) {
  const key = admissionKey(binding);
  const admission = admissions.get(key);
  if (!isApprovedAppOrigin()) throw new HostedRelayAdmissionError();
  if (admission === undefined) throw new HostedRelayAdmissionRequiredError();
  if (admission.expiresAt <= Date.now()) {
    if (dropAdmission(key)) publish();
    throw new HostedRelayAdmissionRequiredError();
  }
  return admission;
}

export function assertHostedRelayAdmission(binding: Binding) {
  const url = URL.parse(binding.httpsOrigin);
  const installed = url === null ? null : hostedBinding(url);
  if (installed === null) return;
  if (installed.environmentId !== binding.environmentId) throw new HostedRelayAdmissionError();
  return requireAdmission(installed).abort.signal;
}

function hasDestinationSocketTicket(url: URL) {
  const tickets = url.searchParams.getAll("wsTicket");
  return tickets.length === 1 && Boolean(tickets[0]);
}

export function assertHostedStreamTarget(
  url: string,
  environmentId: EnvironmentId | undefined,
  path: string | RegExp,
) {
  const parsed = URL.parse(url);
  const binding = parsed === null ? null : hostedBinding(parsed);
  if (parsed === null || binding === null) return;
  if (
    binding.environmentId !== environmentId ||
    !(typeof path === "string" ? parsed.pathname === path : path.test(parsed.pathname)) ||
    !hasDestinationSocketTicket(parsed)
  ) {
    throw new HostedRelayAdmissionError();
  }
}

export async function fetchHostedRelayResource(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : undefined;
  const url = URL.parse(request?.url ?? String(input), browserOrigin());
  const binding = url === null ? null : hostedBinding(url);
  if (url === null || binding === null) return globalThis.fetch(input, init);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new HostedRelayAdmissionError();
  if (url.pathname === RELAY_BROWSER_TICKETS_PATH || url.pathname === RELAY_HOSTED_SESSION_PATH) {
    throw new HostedRelayAdmissionError();
  }
  const admission = requireAdmission(binding);
  const headers = new Headers(init?.headers ?? request?.headers);
  headers.set(RELAY_HOSTED_SESSION_HEADER, Redacted.value(admission.session));
  const signal = init?.signal === undefined ? request?.signal : init.signal;
  const response = await globalThis.fetch(input, {
    ...init,
    headers,
    mode: "cors",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal: signal ? AbortSignal.any([signal, admission.abort.signal]) : admission.abort.signal,
  });
  if (
    response.status === 401 &&
    response.headers.get(RELAY_ADMISSION_HEADER) === RELAY_HOSTED_SESSION_REQUIRED
  ) {
    const key = admissionKey(binding);
    if (admissions.get(key) === admission && dropAdmission(key)) publish();
    void response.body?.cancel().catch(() => {});
    throw new HostedRelayAdmissionRequiredError();
  }
  return response;
}

export function openHostedRelaySocket(url: string, protocols?: string | string[]): WebSocket {
  const parsed = URL.parse(url, browserOrigin());
  const binding = parsed === null ? null : hostedBinding(parsed);
  if (parsed === null || binding === null) return new WebSocket(url, protocols);
  if (
    parsed.protocol !== "wss:" ||
    parsed.username ||
    parsed.password ||
    !hasDestinationSocketTicket(parsed)
  ) {
    throw new HostedRelayAdmissionError();
  }
  const admission = requireAdmission(binding);
  const offers = typeof protocols === "string" ? [protocols] : (protocols ?? []);
  if (offers.some((protocol) => protocol.startsWith(RELAY_HOSTED_WS_PROTOCOL_PREFIX))) {
    throw new HostedRelayAdmissionError();
  }
  let socket: WebSocket;
  try {
    socket = new WebSocket(url, [
      ...offers,
      RELAY_HOSTED_WS_PROTOCOL,
      `${RELAY_HOSTED_WS_PROTOCOL_PREFIX}${Redacted.value(admission.session)}`,
    ]);
  } catch {
    throw new HostedRelayAdmissionError();
  }
  // Browsers hide the upgrade status. A fresh descriptor read can confirm the ingress marker.
  const checkAdmission = () => {
    if (admission.abort.signal.aborted) return;
    void fetchHostedRelayResource(`${binding.httpsOrigin}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(2_500),
    })
      .then((response) => response.body?.cancel())
      .catch(() => {});
  };
  socket.addEventListener("error", checkAdmission, { once: true });
  socket.addEventListener("open", () => socket.removeEventListener("error", checkAdmission), {
    once: true,
  });
  const close = () => socket.close();
  admission.abort.signal.addEventListener("abort", close, { once: true });
  socket.addEventListener(
    "close",
    () => {
      socket.removeEventListener("error", checkAdmission);
      admission.abort.signal.removeEventListener("abort", close);
    },
    {
      once: true,
    },
  );
  return socket;
}
