import {
  SelfHostedRelayId,
  SelfHostedRelaySessionCredential,
} from "@t3tools/contracts/selfHostedRelay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

export class SelfHostedRelayAccountError extends Schema.TaggedError<SelfHostedRelayAccountError>()(
  "SelfHostedRelayAccountError",
  {
    reason: Schema.Literals([
      "invalid-account",
      "corrupt-storage",
      "storage-unavailable",
      "directory-unavailable",
      "unauthorized",
      "forbidden",
      "invalid-directory",
      "cache-unavailable",
    ]),
  },
) {
  override get message(): string {
    return `Self-hosted relay: ${this.reason}.`;
  }
}

export const accountError = (reason: SelfHostedRelayAccountError["reason"]) =>
  new SelfHostedRelayAccountError({ reason });

const managementOrigin = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^https:\/\/[A-Za-z0-9.:[\]-]+\/?$/u),
  Schema.makeFilter((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }),
);
const label = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
  Schema.isPattern(/^[^\x00-\x1f\x7f]+$/u),
);
const metadata = Schema.Struct({ managementOrigin, label, relayId: SelfHostedRelayId });
export type SelfHostedRelayAccount = typeof metadata.Type;

export interface ConfigureSelfHostedRelayAccount {
  readonly managementOrigin: string;
  readonly label: string;
  readonly session: SelfHostedRelaySessionCredential;
}

const session = Schema.Struct({
  ...SelfHostedRelaySessionCredential.fields,
  credential: Schema.String.check(Schema.isPattern(/^[!-+\x2d-\x7e]{1,512}$/u)),
});
const accountRecord = Schema.Struct({
  version: Schema.Literal(1),
  metadata,
  session: Schema.RedactedFromValue(session),
}).check(
  Schema.makeFilter((value) => value.metadata.relayId === Redacted.value(value.session).relayId),
);

export type StoredSelfHostedRelayAccount = typeof accountRecord.Type;

const revision = Schema.String.check(Schema.isUUID());
const storedRecord = Schema.Struct({
  version: Schema.Literal(2),
  revision,
  account: Schema.NullOr(accountRecord),
  withdrawal: Schema.NullOr(SelfHostedRelayId),
});

export type SelfHostedRelayAccountRecord = Omit<typeof storedRecord.Type, "revision"> & {
  readonly revision: string | null;
};

const strict = { onExcessProperty: "error" } as const;
const decodeAccount = Schema.decodeUnknownEffect(accountRecord);
const accountJson = Schema.fromJsonString(accountRecord);
const decodeStoredJson = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Union([storedRecord, accountRecord])),
);
const encodeStoredJson = Schema.encodeEffect(Schema.fromJsonString(storedRecord));
const encodeAccountJson = Schema.encodeEffect(accountJson);
const maxAccountBytes = 2048;
const maxRecordBytes = 3072;
const fitsStorage = (value: string, limit: number) =>
  value.length <= limit && new TextEncoder().encode(value).byteLength <= limit;

const encodeBoundedAccount = Effect.fn("SelfHostedRelayAccount.encode")(function* (
  account: StoredSelfHostedRelayAccount,
) {
  const raw = yield* encodeAccountJson(account).pipe(
    Effect.mapError(() => accountError("invalid-account")),
  );
  if (!fitsStorage(raw, maxAccountBytes)) return yield* accountError("invalid-account");
  return raw;
});

export const prepareAccount = Effect.fn("SelfHostedRelayAccount.prepare")(function* (
  input: ConfigureSelfHostedRelayAccount,
) {
  const account = yield* decodeAccount(
    {
      version: 1,
      metadata: {
        managementOrigin: input.managementOrigin,
        relayId: input.session.relayId,
        label: input.label.trim(),
      },
      session: input.session,
    },
    strict,
  ).pipe(Effect.mapError(() => accountError("invalid-account")));
  const canonical = {
    ...account,
    session: Redacted.make({ ...Redacted.value(account.session) }),
    metadata: {
      ...account.metadata,
      managementOrigin: new URL(account.metadata.managementOrigin).origin,
    },
  };
  yield* encodeBoundedAccount(canonical);
  return canonical;
});

type Exclusive = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | SelfHostedRelayAccountError, R>;

export class SelfHostedRelayAccountStore extends Context.Service<
  SelfHostedRelayAccountStore,
  {
    readonly exclusive: Exclusive;
    readonly changes: Stream.Stream<void>;
    readonly read: Effect.Effect<SelfHostedRelayAccountRecord | null, SelfHostedRelayAccountError>;
    readonly write: (
      record: typeof storedRecord.Type,
    ) => Effect.Effect<void, SelfHostedRelayAccountError>;
    readonly newRevision: Effect.Effect<string, SelfHostedRelayAccountError>;
  }
>()("@t3tools/client-runtime/selfHostedRelay/account/SelfHostedRelayAccountStore") {}

export function makeAccountStore<E>(backend: {
  readonly read: Effect.Effect<unknown, E>;
  readonly write: (raw: string) => Effect.Effect<void, E>;
  readonly exclusive: Exclusive;
  readonly changes?: Stream.Stream<void>;
  readonly invalidate?: () => void;
  readonly newRevision?: Effect.Effect<string>;
}): SelfHostedRelayAccountStore["Service"] {
  const storageUnavailable = () => accountError("storage-unavailable");
  const protect = <A, E>(operation: Effect.Effect<A, E>) =>
    operation.pipe(
      Effect.mapError(storageUnavailable),
      Effect.catchDefect(storageUnavailable),
      Effect.withTracerEnabled(false),
    );
  return {
    exclusive: backend.exclusive,
    changes: backend.changes ?? Stream.empty,
    read: Effect.gen(function* () {
      const raw = yield* protect(backend.read);
      if (raw === undefined || raw === null) return null;
      if (typeof raw !== "string" || !fitsStorage(raw, maxRecordBytes)) {
        return yield* accountError("corrupt-storage");
      }
      const decoded = yield* decodeStoredJson(raw, strict).pipe(
        Effect.mapError(() => accountError("corrupt-storage")),
      );
      if (decoded.version === 1 && !fitsStorage(raw, maxAccountBytes)) {
        return yield* accountError("corrupt-storage");
      }
      const record =
        decoded.version === 1
          ? { version: 2 as const, revision: null, account: decoded, withdrawal: null }
          : decoded;
      const origin = record.account?.metadata.managementOrigin;
      if (origin !== undefined && new URL(origin).origin !== origin) {
        return yield* accountError("corrupt-storage");
      }
      return record;
    }),
    write: Effect.fn("SelfHostedRelayAccount.write")(function* (record) {
      const raw = yield* encodeStoredJson(record).pipe(
        Effect.mapError(() => accountError("invalid-account")),
        Effect.withTracerEnabled(false),
      );
      if (!fitsStorage(raw, maxRecordBytes)) return yield* accountError("invalid-account");
      yield* protect(Effect.suspend(() => backend.write(raw)));
      yield* Effect.sync(() => backend.invalidate?.()).pipe(Effect.ignoreCause);
    }),
    newRevision: protect(
      backend.newRevision ??
        SecureRandom.SecureRandom.use((random) => random.uuidV4()).pipe(
          Effect.provide(SecureRandom.layerWebCrypto),
        ),
    ),
  };
}
