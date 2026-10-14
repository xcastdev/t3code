// @effect-diagnostics nodeBuiltinImport:off - Synthetic JWT fixtures and disposable auth files only.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import { readPiSubscriptionCredential } from "./PiSubscriptionCredential.ts";
import { readPiSavedLiteralCredential } from "./PiNativeConfiguration.ts";

const accountClaim = "https://api.openai.com/auth";
const encodePart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (exp: number, accountId: string) =>
  `${encodePart({ alg: "none", typ: "JWT" })}.${encodePart({ exp, [accountClaim]: { chatgpt_account_id: accountId } })}.synthetic-signature`;
const nowMs = 1_900_000_000_000;
const accountId = "synthetic-account-42";
const accessToken = jwt((nowMs + 60_000) / 1000, accountId);
const encodeJsonObject = Schema.encodeSync(Schema.fromJsonString(Schema.JsonObject));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-subscription-auth-" });
  const write = (auth: unknown) =>
    fs.writeFileString(path.join(directory, "auth.json"), JSON.stringify(auth));
  return { fs, path, directory, write };
});

const piAuth = (token = accessToken, id = accountId, expires = nowMs + 60_000) => ({
  "openai-codex": {
    type: "oauth",
    access: token,
    refresh: "synthetic-refresh-token-not-returned",
    expires,
    accountId: id,
  },
});
const codexAuth = (token = accessToken, id: string | undefined = accountId) => ({
  auth_mode: "chatgpt",
  tokens: { access_token: token, ...(id === undefined ? {} : { account_id: id }) },
});

describe("Pi OpenAI subscription credential reader", () => {
  effectIt.effect.each([["pi", piAuth()] as const, ["codex", codexAuth()] as const])(
    "reads a bounded %s subscription credential and returns only the access credential",
    ([format, auth]) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write(auth);
        const result = yield* readPiSubscriptionCredential(
          { directory: f.directory, format },
          nowMs + 30_000,
        );
        const value = Redacted.value(result);
        expect(value).toEqual({ accessToken, accountId, expiresAtMs: nowMs + 60_000 });
        expect(encodeJsonObject(value)).not.toContain("synthetic-refresh-token");
        expect(String(result)).not.toContain(accessToken);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("rejects expired or too-short-lived subscription tokens as unavailable", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write(piAuth(jwt((nowMs + 30_000) / 1000, accountId), accountId, nowMs + 30_000));
      const error = yield* Effect.flip(
        readPiSubscriptionCredential({ directory: f.directory, format: "pi" }, nowMs + 30_000),
      );
      expect(error.reason).toBe("credential-unavailable");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("rejects a supplied account id that disagrees with the JWT account claim", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write(piAuth(accessToken, "synthetic-different-account"));
      const error = yield* Effect.flip(
        readPiSubscriptionCredential({ directory: f.directory, format: "pi" }, nowMs),
      );
      expect(error.reason).toBe("credential-unavailable");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("derives the Codex account id from the JWT when account_id is absent", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write(codexAuth(accessToken, undefined));
      const result = yield* readPiSubscriptionCredential(
        { directory: f.directory, format: "codex" },
        nowMs,
      );
      expect(Redacted.value(result)).toEqual({
        accessToken,
        accountId,
        expiresAtMs: nowMs + 60_000,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.effect.each(["not-a-jwt", `${accessToken}\r\nInjected: value`, "x".repeat(8193)])(
    "rejects malformed, line-broken, or oversized access tokens",
    (token) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write(piAuth(token));
        const error = yield* Effect.flip(
          readPiSubscriptionCredential({ directory: f.directory, format: "pi" }, nowMs),
        );
        expect(error.reason).toBe("credential-unavailable");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("rejects auth.json beyond the bounded reader limit", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "auth.json"),
        `{"openai-codex":${" ".repeat(262145)}}`,
      );
      const error = yield* Effect.flip(
        readPiSubscriptionCredential({ directory: f.directory, format: "pi" }, nowMs),
      );
      expect(error.reason).toBe("credential-unavailable");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.effect.each([
    ["pi", codexAuth()],
    ["codex", piAuth()],
    ["codex", { auth_mode: "apikey", tokens: { access_token: accessToken } }],
  ] as const)("rejects credentials from an unsupported %s auth format", ([format, auth]) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write(auth);
      const error = yield* Effect.flip(
        readPiSubscriptionCredential({ directory: f.directory, format }, nowMs),
      );
      expect(error.reason).toBe("credential-unavailable");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("keeps the ordinary CommandCode saved API-key reader behavior unchanged", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write({ "command-code": { type: "api_key", key: "synthetic-commandcode-key" } });
      const result = yield* readPiSavedLiteralCredential(f.directory);
      expect(Redacted.value(result)).toBe("synthetic-commandcode-key");
      expect(String(result)).not.toContain("synthetic-commandcode-key");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
