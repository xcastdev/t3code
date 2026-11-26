// @effect-diagnostics-next-line nodeBuiltinImport:off -- Relay handles require cryptographic randomness and hashed lookup.
import * as NodeCrypto from "node:crypto";
import type { EnvironmentId } from "@t3tools/contracts";
import { RELAY_BROWSER_HANDLE_PATTERN } from "@t3tools/contracts/selfHostedRelayHosted";
import { RelayRuntime } from "@t3tools/relay-core/RelayRuntime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

type Audience = {
  readonly publicOrigin: string;
  readonly environmentId: EnvironmentId;
  readonly clientOrigin?: string;
};
type Alias = Audience & { readonly admission?: () => boolean };
type Issued = { readonly handle: string; readonly expiresAt: number };
type Ticket = Audience & { readonly credential: string; readonly expiresAt: number };
type Session = Ticket & { readonly controller: AbortController };
type RuntimeError = Effect.Error<ReturnType<RelayRuntime["Service"]["authorizeLive"]>>;

const TICKET_MS = 60_000;
export const SESSION_SECONDS = 900;
const MAX_TICKETS = 1024;
const MAX_SESSIONS = 2048;
export const HANDLE = RELAY_BROWSER_HANDLE_PATTERN;
const digest = (handle: string) => NodeCrypto.createHash("sha256").update(handle).digest("hex");
const newHandle = () => NodeCrypto.randomBytes(32).toString("base64url");
const matches = (a: Audience, b: Audience) =>
  a.publicOrigin === b.publicOrigin &&
  a.environmentId === b.environmentId &&
  a.clientOrigin === b.clientOrigin;
const isActive = (alias: Alias) => alias.admission?.() !== false;

export class BrowserAdmissionError extends Schema.TaggedError<
  BrowserAdmissionError,
  { readonly brand: unique symbol }
>()("BrowserAdmissionError", { reason: Schema.Literals(["invalid", "capacity"]) }) {}

export class SelfHostedRelayBrowserAdmission extends Context.Service<
  SelfHostedRelayBrowserAdmission,
  {
    readonly mint: (
      alias: Alias,
      credential: string,
      signal?: AbortSignal,
    ) => Effect.Effect<Issued, RuntimeError | BrowserAdmissionError>;
    readonly redeem: (
      alias: Alias,
      handle: string,
      signal?: AbortSignal,
    ) => Effect.Effect<Issued, RuntimeError | BrowserAdmissionError>;
    readonly resolve: (
      alias: Alias,
      handle: string,
    ) => Effect.Effect<{ credential: string; signal: AbortSignal }, BrowserAdmissionError>;
  }
>()("t3/relay/SelfHostedRelayBrowserAdmission") {}

const make = Effect.gen(function* () {
  const relay = yield* RelayRuntime;
  const scope = yield* Effect.scope;
  const tickets = new Map<string, Ticket>();
  const sessions = new Map<string, Session>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      tickets.clear();
      for (const session of sessions.values()) session.controller.abort();
      sessions.clear();
    }),
  );

  const sweepTickets = (now: number) => {
    for (const [key, ticket] of tickets) {
      if (ticket.expiresAt <= now) tickets.delete(key);
    }
  };
  yield* Effect.sleep(TICKET_MS).pipe(
    Effect.andThen(Clock.currentTimeMillis),
    Effect.map(sweepTickets),
    Effect.forever,
    Effect.forkScoped,
  );

  const mint = Effect.fn("SelfHostedRelayBrowserAdmission.mint")(function* (
    alias: Alias,
    credential: string,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted || !isActive(alias))
      return yield* new BrowserAdmissionError({ reason: "invalid" });
    const grant = yield* relay.authorizeLive(credential, {
      kind: "forward",
      environmentId: alias.environmentId,
    });
    const now = yield* Clock.currentTimeMillis;
    if (signal?.aborted || grant.aborted || !isActive(alias))
      return yield* new BrowserAdmissionError({ reason: "invalid" });
    if (tickets.size >= MAX_TICKETS) sweepTickets(now);
    if (tickets.size >= MAX_TICKETS)
      return yield* new BrowserAdmissionError({ reason: "capacity" });
    const handle = newHandle();
    const expiresAt = now + TICKET_MS;
    const { publicOrigin, environmentId, clientOrigin } = alias;
    tickets.set(digest(handle), {
      publicOrigin,
      environmentId,
      ...(clientOrigin === undefined ? {} : { clientOrigin }),
      credential,
      expiresAt,
    });
    return { handle, expiresAt };
  }, Effect.scoped);

  const expire = (key: string, session: Session) => {
    sessions.delete(key);
    session.controller.abort();
  };

  const redeem = Effect.fn("SelfHostedRelayBrowserAdmission.redeem")(function* (
    alias: Alias,
    handle: string,
    signal?: AbortSignal,
  ) {
    if (!HANDLE.test(handle)) return yield* new BrowserAdmissionError({ reason: "invalid" });
    const now = yield* Clock.currentTimeMillis;
    const key = digest(handle);
    const ticket = tickets.get(key);
    if (signal?.aborted || !isActive(alias) || ticket === undefined || !matches(ticket, alias))
      return yield* new BrowserAdmissionError({ reason: "invalid" });

    if (ticket.expiresAt <= now) {
      tickets.delete(key);
      return yield* new BrowserAdmissionError({ reason: "invalid" });
    }
    if (ticket.clientOrigin === undefined) tickets.delete(key);
    const grant = yield* relay.authorizeLive(ticket.credential, {
      kind: "forward",
      environmentId: alias.environmentId,
    });
    const issuedAt = yield* Clock.currentTimeMillis;
    if (
      signal?.aborted ||
      grant.aborted ||
      !isActive(alias) ||
      ticket.expiresAt <= issuedAt ||
      (ticket.clientOrigin !== undefined && tickets.get(key) !== ticket)
    )
      return yield* new BrowserAdmissionError({ reason: "invalid" });
    if (sessions.size >= MAX_SESSIONS)
      return yield* new BrowserAdmissionError({ reason: "capacity" });

    tickets.delete(key);
    const sessionHandle = newHandle();
    const sessionKey = digest(sessionHandle);
    const duration = SESSION_SECONDS * 1000;
    const session: Session = {
      ...ticket,
      expiresAt: issuedAt + duration,
      // @effect-diagnostics-next-line abortControllerInEffect:off -- The session deadline cancels the Node exchange.
      controller: new AbortController(),
    };
    sessions.set(sessionKey, session);
    yield* Effect.sleep(duration).pipe(
      Effect.andThen(Effect.sync(() => expire(sessionKey, session))),
      Effect.forkIn(scope, { startImmediately: true }),
    );
    return { handle: sessionHandle, expiresAt: session.expiresAt };
  }, Effect.scoped);

  const resolve = Effect.fn("SelfHostedRelayBrowserAdmission.resolve")(function* (
    alias: Alias,
    handle: string,
  ) {
    if (!HANDLE.test(handle)) return yield* new BrowserAdmissionError({ reason: "invalid" });
    const now = yield* Clock.currentTimeMillis;
    const key = digest(handle);
    const session = sessions.get(key);
    if (!isActive(alias) || session === undefined || !matches(session, alias))
      return yield* new BrowserAdmissionError({ reason: "invalid" });
    if (session.expiresAt <= now) {
      expire(key, session);
      return yield* new BrowserAdmissionError({ reason: "invalid" });
    }
    return { credential: session.credential, signal: session.controller.signal };
  });

  return SelfHostedRelayBrowserAdmission.of({ mint, redeem, resolve });
});

export const layer = Layer.effect(SelfHostedRelayBrowserAdmission, make);
