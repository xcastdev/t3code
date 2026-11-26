import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Runtime from "@t3tools/relay-core/RelayRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as BrowserAdmission from "./SelfHostedRelayBrowserAdmission.ts";

const alias = {
  publicOrigin: "https://relay.example",
  environmentId: EnvironmentId.make("environment-a"),
};
const hostedAlias = { ...alias, clientOrigin: "https://hosted.example:8443" };
const alternatePort = { ...alias, publicOrigin: "https://relay.example:8443" };
const alternateEnvironment = { ...alias, environmentId: EnvironmentId.make("environment-b") };

const fixture = Effect.fn("SelfHostedRelayBrowserAdmissionTest.fixture")(function* () {
  const relay = yield* Runtime.RelayRuntime;
  const owner = yield* relay.bootstrapOwner();
  yield* relay.enrollEnvironment(owner.credential, {
    version: 1,
    environmentId: alias.environmentId,
    name: "Environment A",
  });
  const pairing = yield* relay.issuePairing(owner.credential, {
    version: 1,
    subject: { kind: "client" },
    scope: {
      permissions: ["forward"],
      environments: { kind: "selected", environmentIds: [alias.environmentId] },
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const session = yield* relay.redeemPairing(pairing.credential);
  const browser = yield* BrowserAdmission.SelfHostedRelayBrowserAdmission;
  return {
    browser,
    credential: session.credential,
    revoke: relay.revokeSession(owner.credential, session.sessionId),
  };
});

const provideAdmission = <A, E, R>(
  test: Effect.Effect<
    A,
    E,
    R | Runtime.RelayRuntime | BrowserAdmission.SelfHostedRelayBrowserAdmission
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-browser-" });
    return yield* test.pipe(
      Effect.provide(
        BrowserAdmission.layer.pipe(
          Layer.provideMerge(Runtime.relayRuntimeLayer({ homeDirectory })),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

it.effect.each([
  ["cookie", alias, [alternatePort, alternateEnvironment, hostedAlias]],
  [
    "hosted",
    hostedAlias,
    [
      alias,
      { ...hostedAlias, clientOrigin: "https://hosted.example" },
      {
        ...alternatePort,
        clientOrigin: hostedAlias.clientOrigin,
      },
    ],
  ],
] as const)(
  "consumes a %s ticket once and binds handles to its complete audience",
  ([, audience, otherAudiences]) =>
    provideAdmission(
      Effect.gen(function* () {
        const { browser, credential } = yield* fixture();
        const { handle: ticket } = yield* browser.mint(audience, credential);
        for (const wrongAlias of otherAudiences) {
          expect(yield* Effect.flip(browser.redeem(wrongAlias, ticket))).toMatchObject({
            reason: "invalid",
          });
        }

        const results = yield* Effect.all(
          [
            Effect.option(browser.redeem(audience, ticket)),
            Effect.option(browser.redeem(audience, ticket)),
          ],
          { concurrency: 2 },
        );
        const handles = results.flatMap((result) =>
          result._tag === "Some" ? [result.value.handle] : [],
        );
        expect(handles).toHaveLength(1);
        const [session] = handles;
        expect(session).not.toBe(ticket);
        expect(yield* browser.resolve(audience, session!)).toMatchObject({ credential });
        for (const wrongAlias of otherAudiences) {
          expect(yield* Effect.flip(browser.resolve(wrongAlias, session!))).toMatchObject({
            reason: "invalid",
          });
        }
      }),
    ),
);

it.effect.each([
  ["cookie", alias],
  ["hosted", hostedAlias],
] as const)("expires %s tickets and aborts work at the session deadline", ([, audience]) =>
  provideAdmission(
    Effect.gen(function* () {
      const { browser, credential } = yield* fixture();
      const { handle: expired } = yield* browser.mint(audience, credential);
      yield* TestClock.adjust("60 seconds");
      expect(yield* Effect.flip(browser.redeem(audience, expired))).toMatchObject({
        reason: "invalid",
      });

      const { handle: ticket } = yield* browser.mint(audience, credential);
      const { handle } = yield* browser.redeem(audience, ticket);
      const session = yield* browser.resolve(audience, handle);
      yield* TestClock.adjust("899 seconds");
      expect(session.signal.aborted).toBe(false);
      yield* TestClock.adjust("1 second");
      expect(session.signal.aborted).toBe(true);
      expect(yield* Effect.flip(browser.resolve(audience, handle))).toMatchObject({
        reason: "invalid",
      });
    }),
  ),
);

it.effect("rechecks P3 at redemption and consumes a ticket whose grant was revoked", () =>
  provideAdmission(
    Effect.gen(function* () {
      const { browser, credential, revoke } = yield* fixture();
      const { handle: ticket } = yield* browser.mint(alias, credential);
      yield* revoke;
      expect((yield* Effect.flip(browser.redeem(alias, ticket)))._tag).toBe(
        "RelayAuthenticationError",
      );
      expect(yield* Effect.flip(browser.redeem(alias, ticket))).toMatchObject({
        reason: "invalid",
      });
    }),
  ),
);

const withAuthorization = (authorizeLive: Runtime.RelayRuntime["Service"]["authorizeLive"]) =>
  BrowserAdmission.layer.pipe(Layer.provide(Layer.mock(Runtime.RelayRuntime)({ authorizeLive })));

it.effect.each([
  ["mint", "cookie", alias],
  ["redeem", "cookie", alias],
  ["mint", "hosted", hostedAlias],
  ["redeem", "hosted", hostedAlias],
] as const)(
  "rejects %s in %s mode when authorization completes after cancellation",
  ([operation, mode, audience]) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const grant = yield* Effect.abortSignal;
      let block = false;
      const authorization = withAuthorization(() =>
        Effect.suspend(() =>
          block
            ? Effect.uninterruptible(
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(grant),
                ),
              )
            : Effect.succeed(grant),
        ),
      );
      yield* Effect.gen(function* () {
        const browser = yield* BrowserAdmission.SelfHostedRelayBrowserAdmission;
        const credential = "client";
        const input =
          operation === "redeem" ? (yield* browser.mint(audience, credential)).handle : credential;
        const downstream = yield* Scope.fork(yield* Effect.scope);
        const signal = yield* Effect.abortSignal.pipe(Scope.provide(downstream));
        block = true;
        const admission = yield* browser[operation](audience, input, signal).pipe(
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        yield* Scope.close(downstream, Exit.void);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(admission)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "invalid" },
        });
        block = false;
        if (operation === "redeem" && mode === "hosted") {
          expect(yield* browser.redeem(audience, input)).toMatchObject({
            handle: expect.stringMatching(BrowserAdmission.HANDLE),
          });
        } else if (operation === "redeem") {
          expect(yield* Effect.flip(browser.redeem(audience, input))).toMatchObject({
            reason: "invalid",
          });
        }
      }).pipe(Effect.provide(authorization));
    }),
);

it.effect("caps pending tickets at 1,024 and reclaims slots on redemption and expiry", () =>
  Effect.gen(function* () {
    const browser = yield* BrowserAdmission.SelfHostedRelayBrowserAdmission;
    const mint = browser.mint(alias, "client");
    const { handle: first } = yield* mint;
    yield* TestClock.adjust("1 second");
    yield* Effect.forEach(Array.from({ length: 1023 }), () => mint, { discard: true });
    expect(yield* Effect.flip(browser.mint(alternatePort, "client"))).toMatchObject({
      reason: "capacity",
    });

    yield* browser.redeem(alias, first);
    yield* mint;
    yield* TestClock.adjust("59 seconds");
    expect(yield* Effect.flip(mint)).toMatchObject({ reason: "capacity" });
    yield* TestClock.adjust("1 second");
    yield* Effect.forEach(Array.from({ length: 1024 }), () => mint, { discard: true });
    expect(yield* Effect.flip(mint)).toMatchObject({ reason: "capacity" });
  }).pipe(Effect.provide(withAuthorization(() => Effect.abortSignal))),
);

it.effect("caps sessions at 2,048 and reclaims the slots at their deadline", () =>
  Effect.gen(function* () {
    const browser = yield* BrowserAdmission.SelfHostedRelayBrowserAdmission;
    const mint = browser.mint(alias, "client");
    const admit = mint.pipe(Effect.flatMap(({ handle }) => browser.redeem(alias, handle)));
    const { handle: first } = yield* admit;
    const live = yield* browser.resolve(alias, first);
    yield* Effect.forEach(Array.from({ length: 2047 }), () => admit, { discard: true });
    const { handle: otherTicket } = yield* browser.mint(alternatePort, "client");
    expect(yield* Effect.flip(browser.redeem(alternatePort, otherTicket))).toMatchObject({
      reason: "capacity",
    });

    yield* TestClock.adjust("899 seconds");
    expect(yield* Effect.flip(admit)).toMatchObject({ reason: "capacity" });
    const { handle: hostedTicket } = yield* browser.mint(hostedAlias, "client");
    expect(yield* Effect.flip(browser.redeem(hostedAlias, hostedTicket))).toMatchObject({
      reason: "capacity",
    });
    yield* TestClock.adjust("1 second");
    expect(live.signal.aborted).toBe(true);
    yield* browser.redeem(hostedAlias, hostedTicket);
    yield* Effect.forEach(Array.from({ length: 2047 }), () => admit, { discard: true });
    expect(yield* Effect.flip(admit)).toMatchObject({ reason: "capacity" });
  }).pipe(Effect.provide(withAuthorization(() => Effect.abortSignal))),
);
