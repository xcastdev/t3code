// @effect-diagnostics nodeBuiltinImport:off - JWT payload decoding uses Node's base64url decoder.
import * as NodeBuffer from "node:buffer";

import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { PiNativeConfigurationUnavailable, readPiAuthFile } from "./PiNativeConfiguration.ts";

export type PiSubscriptionCredential = {
  readonly accessToken: string;
  readonly accountId: string;
  readonly expiresAtMs: number;
};

const AccountId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.makeFilter((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
);
const AccessToken = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8192),
  Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
);
const SafeInteger = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
);
const PositiveSafeInteger = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const PiOAuthCredential = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: AccessToken,
  expires: Schema.optional(SafeInteger),
  accountId: AccountId,
}).annotate({ parseOptions: { onExcessProperty: "ignore" } });
const CodexAuth = Schema.Struct({
  auth_mode: Schema.Literal("chatgpt"),
  tokens: Schema.Struct({
    access_token: AccessToken,
    account_id: Schema.optional(AccountId),
  }).annotate({ parseOptions: { onExcessProperty: "ignore" } }),
}).annotate({ parseOptions: { onExcessProperty: "ignore" } });
const JwtPayload = Schema.Struct({
  exp: PositiveSafeInteger,
  "https://api.openai.com/auth": Schema.Struct({ chatgpt_account_id: AccountId }),
});

const unavailable = () =>
  new PiNativeConfigurationUnavailable({ reason: "credential-unavailable" });
const decodeAuth = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodePiAuth = Schema.decodeUnknownEffect(PiOAuthCredential);
const decodeCodexAuth = Schema.decodeUnknownEffect(CodexAuth);
const decodeJwtPayload = Schema.decodeEffect(Schema.fromJsonString(JwtPayload));

const reject = () => Effect.fail(unavailable());

/** Read subscription OAuth material in the parent only, after the caller's authority check. */
export const readPiSubscriptionCredential = Effect.fn("readPiSubscriptionCredential")(function* (
  source: { readonly directory: string; readonly format: "pi" | "codex" },
  requiredValidUntilMs: number,
) {
  if (
    !Number.isSafeInteger(requiredValidUntilMs) ||
    (source.format !== "pi" && source.format !== "codex")
  ) {
    return yield* reject();
  }

  const contents = yield* readPiAuthFile(source.directory).pipe(
    Effect.mapError(() => unavailable()),
  );
  const auth = yield* decodeAuth(contents).pipe(Effect.mapError(() => unavailable()));

  let accessToken: string;
  let suppliedAccountId: string | undefined;
  let piExpiresAtMs: number | undefined;
  if (source.format === "pi") {
    const entry = yield* decodePiAuth(auth["openai-codex"]).pipe(
      Effect.mapError(() => unavailable()),
    );
    accessToken = entry.access;
    suppliedAccountId = entry.accountId;
    piExpiresAtMs = entry.expires;
  } else {
    const entry = yield* decodeCodexAuth(auth).pipe(Effect.mapError(() => unavailable()));
    accessToken = entry.tokens.access_token;
    suppliedAccountId = entry.tokens.account_id;
  }

  const [, encodedPayload] = accessToken.split(".");
  if (encodedPayload === undefined) return yield* reject();
  const payloadJson = yield* Effect.try({
    try: () => NodeBuffer.Buffer.from(encodedPayload, "base64url").toString("utf8"),
    catch: unavailable,
  });
  const payload = yield* decodeJwtPayload(payloadJson).pipe(Effect.mapError(() => unavailable()));
  const jwtExpiresAtMs = payload.exp * 1000;
  if (!Number.isSafeInteger(jwtExpiresAtMs)) return yield* reject();

  const accountId = payload["https://api.openai.com/auth"].chatgpt_account_id;
  if (suppliedAccountId !== undefined && suppliedAccountId !== accountId) {
    return yield* reject();
  }
  if (piExpiresAtMs !== undefined && !Number.isSafeInteger(piExpiresAtMs)) return yield* reject();
  const expiresAtMs = Math.min(jwtExpiresAtMs, piExpiresAtMs ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= requiredValidUntilMs) {
    return yield* reject();
  }

  return Redacted.make(Object.freeze({ accessToken, accountId, expiresAtMs }));
});
