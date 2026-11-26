import { expect, it } from "@effect/vitest";
import { SelfHostedRelayAccountStore } from "@t3tools/client-runtime/self-hosted-relay";
import { SelfHostedRelayGrantId, SelfHostedRelayId } from "@t3tools/contracts/selfHostedRelay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { vi } from "vite-plus/test";

vi.mock("expo-crypto", () => ({ randomUUID: () => SecureRandom.uuidV4Unsafe() }));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import * as MobileSecureStorage from "../persistence/mobile-secure-storage";
import { layer } from "./storage";

it.effect("keeps one account in SecureStore across mobile connection storage restarts", () =>
  Effect.gen(function* () {
    const rows = new Map<string, string>();
    const storage = MobileSecureStorage.MobileSecureStorage.of({
      getItem: (key) => Effect.sync(() => rows.get(key) ?? null),
      setItem: (key, value) =>
        Effect.sync(() => {
          rows.set(key, value);
        }),
      removeItem: (key) =>
        Effect.sync(() => {
          rows.delete(key);
        }),
    });
    const withStore = <A, E>(
      run: (store: SelfHostedRelayAccountStore["Service"]) => Effect.Effect<A, E>,
    ) =>
      Effect.flatMap(SelfHostedRelayAccountStore, run).pipe(
        Effect.provide(Layer.fresh(layer)),
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, storage),
      );

    const relayId = SelfHostedRelayId.make("private-relay");
    const account = {
      version: 1,
      metadata: {
        managementOrigin: "https://management.example.test",
        relayId,
        label: "Private relay",
      },
      session: Redacted.make({
        version: 1 as const,
        relayId,
        sessionId: SelfHostedRelayGrantId.make("session"),
        credential: "private-session",
      }),
    } as const;
    const key = "t3code.self-hosted-relay-account.v1";
    expect(yield* withStore((store) => store.read)).toBeNull();
    rows.set(key, JSON.stringify({ ...account, session: Redacted.value(account.session) }));
    expect(yield* withStore((store) => store.read)).toMatchObject({
      revision: null,
      account: { metadata: account.metadata },
      withdrawal: null,
    });
    yield* withStore((store) =>
      store.exclusive(
        Effect.flatMap(store.newRevision, (revision) =>
          store.write({ version: 2, revision, account, withdrawal: null }),
        ),
      ),
    );
    expect([...rows.keys()]).toEqual(["t3code.self-hosted-relay-account.v1"]);
    const loaded = yield* withStore((store) => store.read);
    expect(loaded?.account?.metadata).toEqual(account.metadata);
    expect(loaded?.account && Redacted.value(loaded.account.session)).toEqual(
      Redacted.value(account.session),
    );
    yield* withStore((store) =>
      store.exclusive(
        Effect.flatMap(store.newRevision, (revision) =>
          store.write({ version: 2, revision, account: null, withdrawal: null }),
        ),
      ),
    );
    const cleared = yield* withStore((store) => store.read);
    expect(cleared).toMatchObject({ account: null, withdrawal: null });
    expect(cleared?.revision).not.toBe(loaded?.revision);
    expect([...rows.values()][0]).not.toContain("private-session");
  }),
);
