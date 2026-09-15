import {
  AuthAdministrativeScopes,
  type DesktopPrimaryBackendState,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
} from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { parseOAuthScope } from "@t3tools/shared/oauthScope";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { parseDesktopAttachedBackendEndpoints } from "./DesktopAttachedBackendEndpoints.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

export class DesktopAttachPairingUrlError extends Schema.TaggedError<DesktopAttachPairingUrlError>()(
  "DesktopAttachPairingUrlError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}
export class DesktopAttachManagedBackendConflictError extends Schema.TaggedError<DesktopAttachManagedBackendConflictError>()(
  "DesktopAttachManagedBackendConflictError",
  {},
) {
  override get message() {
    return "The desktop backend is already running at that endpoint.";
  }
}
export class DesktopAttachCredentialExchangeError extends Schema.TaggedError<DesktopAttachCredentialExchangeError>()(
  "DesktopAttachCredentialExchangeError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The owner credential was rejected by the backend.";
  }
}
export class DesktopAttachAdministrativeScopeError extends Schema.TaggedError<DesktopAttachAdministrativeScopeError>()(
  "DesktopAttachAdministrativeScopeError",
  { missingScopes: Schema.Array(Schema.String) },
) {
  override get message() {
    return "The credential does not have the administrative access required by desktop Settings.";
  }
}
export class DesktopAttachDescriptorError extends Schema.TaggedError<DesktopAttachDescriptorError>()(
  "DesktopAttachDescriptorError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The backend did not return a valid environment identity.";
  }
}
export class DesktopAttachEncryptionUnavailableError extends Schema.TaggedError<DesktopAttachEncryptionUnavailableError>()(
  "DesktopAttachEncryptionUnavailableError",
  {},
) {
  override get message() {
    return "This desktop cannot securely store the attached backend credential.";
  }
}
export class DesktopAttachEncryptionError extends Schema.TaggedError<DesktopAttachEncryptionError>()(
  "DesktopAttachEncryptionError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The attached backend credential could not be protected by desktop storage.";
  }
}
export class DesktopAttachPersistenceError extends Schema.TaggedError<DesktopAttachPersistenceError>()(
  "DesktopAttachPersistenceError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The attached backend preference could not be saved.";
  }
}
export class DesktopAttachedCredentialUnavailableError extends Schema.TaggedError<DesktopAttachedCredentialUnavailableError>()(
  "DesktopAttachedCredentialUnavailableError",
  {},
) {
  override get message() {
    return "No valid attached backend credential is stored.";
  }
}
export class DesktopAttachedProbeError extends Schema.TaggedError<DesktopAttachedProbeError>()(
  "DesktopAttachedProbeError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The attached backend could not be reached with its stored credential.";
  }
}
export class DesktopAttachedIdentityMismatchError extends Schema.TaggedError<DesktopAttachedIdentityMismatchError>()(
  "DesktopAttachedIdentityMismatchError",
  {},
) {
  override get message() {
    return "The backend identity changed while the desktop was attached.";
  }
}
export class DesktopPrimaryBackendNotManagedError extends Schema.TaggedError<DesktopPrimaryBackendNotManagedError>()(
  "DesktopPrimaryBackendNotManagedError",
  { operation: Schema.String },
) {
  override get message() {
    return `The ${this.operation} setting is unavailable while the primary backend is attached.`;
  }
}

export const DesktopAttachedBackendError = Schema.Union([
  DesktopAttachPairingUrlError,
  DesktopAttachManagedBackendConflictError,
  DesktopAttachCredentialExchangeError,
  DesktopAttachAdministrativeScopeError,
  DesktopAttachDescriptorError,
  DesktopAttachEncryptionUnavailableError,
  DesktopAttachEncryptionError,
  DesktopAttachPersistenceError,
  DesktopAttachedCredentialUnavailableError,
  DesktopAttachedProbeError,
  DesktopAttachedIdentityMismatchError,
]);
export type DesktopAttachedBackendError = typeof DesktopAttachedBackendError.Type;

type AttachedPreference = Extract<
  DesktopAppSettings.DesktopPrimaryBackendPreference,
  { readonly mode: "attached" }
>;
const stateFor = (
  preference: DesktopAppSettings.DesktopPrimaryBackendPreference | undefined,
): DesktopPrimaryBackendState => {
  if (preference === undefined || preference.mode === "managed") return { mode: "managed" };
  if (preference.mode === "invalid-attached") {
    return { mode: "invalid-attached", reason: preference.reason };
  }
  return {
    mode: "attached",
    httpBaseUrl: preference.httpBaseUrl,
    environmentId: preference.environmentId,
    label: preference.label,
    bearerExpiresAt: preference.bearerExpiresAt,
  };
};
const missingAdministrativeScopes = (scope: string) => {
  const granted = new Set(parseOAuthScope(scope) ?? []);
  return AuthAdministrativeScopes.filter((required) => !granted.has(required));
};
const sameIdentity = (left: AttachedPreference, right: AttachedPreference) =>
  left.httpBaseUrl === right.httpBaseUrl &&
  left.wsBaseUrl === right.wsBaseUrl &&
  left.environmentId === right.environmentId &&
  left.label === right.label;

export const resolveDesktopAttachPairingTarget = (pairingUrl: string) =>
  Effect.suspend(() => {
    try {
      const url = new URL(pairingUrl.trim());
      const queryKeys = [...url.searchParams.keys()];
      const fragmentKeys = [...new URLSearchParams(url.hash.slice(1)).keys()];
      if (
        url.protocol !== "http:" ||
        url.username ||
        url.password ||
        queryKeys.some((key) => key !== "token") ||
        fragmentKeys.some((key) => key !== "token") ||
        (queryKeys.includes("token") && fragmentKeys.includes("token"))
      ) {
        return Effect.fail(
          new DesktopAttachPairingUrlError({
            reason: "Desktop attach links must contain only an HTTP loopback owner token.",
          }),
        );
      }
      const target = resolveRemotePairingTarget({ pairingUrl: url.toString() });
      const endpoints = parseDesktopAttachedBackendEndpoints(target.httpBaseUrl, target.wsBaseUrl);
      return endpoints === null
        ? Effect.fail(
            new DesktopAttachPairingUrlError({
              reason: "Desktop attach links must use an HTTP loopback backend URL.",
            }),
          )
        : Effect.succeed({ ...target, ...endpoints });
    } catch {
      return Effect.fail(
        new DesktopAttachPairingUrlError({ reason: "Desktop attach URL is invalid." }),
      );
    }
  });

export class DesktopAttachedBackend extends Context.Service<
  DesktopAttachedBackend,
  {
    readonly getState: Effect.Effect<DesktopPrimaryBackendState>;
    readonly attach: (
      pairingUrl: string,
    ) => Effect.Effect<DesktopPrimaryBackendState, DesktopAttachedBackendError>;
    readonly refreshCredential: (
      pairingCredential: string,
    ) => Effect.Effect<void, DesktopAttachedBackendError>;
    readonly getBearerToken: Effect.Effect<string, DesktopAttachedBackendError>;
    readonly probe: Effect.Effect<ExecutionEnvironmentDescriptor, DesktopAttachedBackendError>;
    readonly useManagedBackend: Effect.Effect<void, DesktopAttachedBackendError>;
  }
>()("@t3tools/desktop/backend/DesktopAttachedBackend") {}

export const make = Effect.gen(function* () {
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const httpClient = yield* HttpClient.HttpClient;
  const lock = yield* Semaphore.make(1);
  const readPreference = settings.get.pipe(
    Effect.map((value) => value.primaryBackend ?? ({ mode: "managed" } as const)),
  );
  const withClient = <A, E, R>(effect: Effect.Effect<A, E, R | HttpClient.HttpClient>) =>
    effect.pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
  const descriptor = (httpBaseUrl: string) =>
    withClient(fetchRemoteEnvironmentDescriptor({ httpBaseUrl })).pipe(
      Effect.mapError((cause) => new DesktopAttachDescriptorError({ cause })),
    );
  const exchange = (httpBaseUrl: string, credential: string) =>
    withClient(
      bootstrapRemoteBearerSession({
        httpBaseUrl,
        credential,
        scopes: AuthAdministrativeScopes,
        clientMetadata: {
          label: "T3 Code Desktop",
          deviceType: "desktop",
          os: environment.platform,
          appVersion: environment.appVersion,
        },
      }),
    ).pipe(Effect.mapError((cause) => new DesktopAttachCredentialExchangeError({ cause })));
  const getBearerToken = Effect.gen(function* () {
    const preference = yield* readPreference;
    if (preference.mode !== "attached")
      return yield* new DesktopAttachedCredentialUnavailableError();
    const bytes = yield* Effect.fromResult(
      Encoding.decodeBase64(preference.encryptedBearerToken),
    ).pipe(Effect.mapError((cause) => new DesktopAttachedProbeError({ cause })));
    return yield* safeStorage
      .decryptString(bytes)
      .pipe(Effect.mapError((cause) => new DesktopAttachedProbeError({ cause })));
  });
  const persist = (input: {
    readonly descriptor: ExecutionEnvironmentDescriptor;
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly token: string;
    readonly expiresAt: string;
  }) =>
    Effect.gen(function* () {
      if (
        !(yield* safeStorage.isEncryptionAvailable.pipe(
          Effect.mapError((cause) => new DesktopAttachEncryptionError({ cause })),
        ))
      )
        return yield* new DesktopAttachEncryptionUnavailableError();
      const encrypted = yield* safeStorage
        .encryptString(input.token)
        .pipe(Effect.mapError((cause) => new DesktopAttachEncryptionError({ cause })));
      const preference: AttachedPreference = {
        mode: "attached",
        httpBaseUrl: input.httpBaseUrl,
        wsBaseUrl: input.wsBaseUrl,
        environmentId: input.descriptor.environmentId,
        label: input.descriptor.label,
        encryptedBearerToken: Encoding.encodeBase64(encrypted),
        bearerExpiresAt: input.expiresAt,
      };
      const setPreference = settings.setPrimaryBackendPreference;
      if (setPreference === undefined)
        return yield* new DesktopAttachPersistenceError({
          cause: "Attached backend persistence is unavailable.",
        });
      yield* setPreference(preference).pipe(
        Effect.mapError((cause) => new DesktopAttachPersistenceError({ cause })),
      );
      return preference;
    });
  const attach = (pairingUrl: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const target = yield* resolveDesktopAttachPairingTarget(pairingUrl);
        for (const instance of yield* pool.list) {
          const config = yield* instance.currentConfig;
          if (
            Option.isSome(config) &&
            config.value.httpBaseUrl.origin === new URL(target.httpBaseUrl).origin
          )
            return yield* new DesktopAttachManagedBackendConflictError();
        }
        const session = yield* exchange(target.httpBaseUrl, target.credential);
        const missingScopes = missingAdministrativeScopes(session.scope);
        if (missingScopes.length)
          return yield* new DesktopAttachAdministrativeScopeError({ missingScopes });
        const remoteDescriptor = yield* descriptor(target.httpBaseUrl);
        const preference = yield* persist({
          descriptor: remoteDescriptor,
          httpBaseUrl: target.httpBaseUrl,
          wsBaseUrl: target.wsBaseUrl,
          token: session.access_token,
          expiresAt: DateTime.formatIso(
            DateTime.makeUnsafe(
              (yield* Clock.currentTimeMillis) + Math.max(0, session.expires_in) * 1_000,
            ),
          ),
        });
        return stateFor(preference);
      }),
    );
  const refreshCredential = (credential: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* readPreference;
        if (current.mode !== "attached")
          return yield* new DesktopAttachedCredentialUnavailableError();
        const before = yield* descriptor(current.httpBaseUrl);
        if (before.environmentId !== current.environmentId)
          return yield* new DesktopAttachedIdentityMismatchError();
        const session = yield* exchange(current.httpBaseUrl, credential);
        const missingScopes = missingAdministrativeScopes(session.scope);
        if (missingScopes.length)
          return yield* new DesktopAttachAdministrativeScopeError({ missingScopes });
        const after = yield* descriptor(current.httpBaseUrl);
        if (after.environmentId !== current.environmentId)
          return yield* new DesktopAttachedIdentityMismatchError();
        const latest = yield* readPreference;
        if (latest.mode !== "attached" || !sameIdentity(latest, current))
          return yield* new DesktopAttachedIdentityMismatchError();
        yield* persist({
          descriptor: after,
          httpBaseUrl: current.httpBaseUrl,
          wsBaseUrl: current.wsBaseUrl,
          token: session.access_token,
          expiresAt: DateTime.formatIso(
            DateTime.makeUnsafe(
              (yield* Clock.currentTimeMillis) + Math.max(0, session.expires_in) * 1_000,
            ),
          ),
        });
      }),
    );
  const probe = Effect.gen(function* () {
    const preference = yield* readPreference;
    if (preference.mode !== "attached")
      return yield* new DesktopAttachedCredentialUnavailableError();
    const remoteDescriptor = yield* descriptor(preference.httpBaseUrl);
    if (remoteDescriptor.environmentId !== preference.environmentId)
      return yield* new DesktopAttachedIdentityMismatchError();
    const session = yield* withClient(
      fetchRemoteSessionState({
        httpBaseUrl: preference.httpBaseUrl,
        bearerToken: yield* getBearerToken,
      }),
    ).pipe(Effect.mapError((cause) => new DesktopAttachedProbeError({ cause })));
    if (
      !session.authenticated ||
      !session.scopes ||
      missingAdministrativeScopes(session.scopes.join(" ")).length
    )
      return yield* new DesktopAttachedProbeError({
        cause: "Stored credential is not administrative.",
      });
    return remoteDescriptor;
  });
  return DesktopAttachedBackend.of({
    getState: readPreference.pipe(Effect.map(stateFor)),
    attach,
    refreshCredential,
    getBearerToken,
    probe,
    useManagedBackend: lock.withPermits(1)(
      Effect.gen(function* () {
        const setPreference = settings.setPrimaryBackendPreference;
        if (setPreference === undefined)
          return yield* new DesktopAttachPersistenceError({
            cause: "Attached backend persistence is unavailable.",
          });
        yield* setPreference({ mode: "managed" }).pipe(
          Effect.mapError((cause) => new DesktopAttachPersistenceError({ cause })),
        );
      }),
    ),
  });
});

export const layer = Layer.effect(DesktopAttachedBackend, make);
