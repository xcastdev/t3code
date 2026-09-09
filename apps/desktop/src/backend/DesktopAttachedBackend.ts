import {
  AuthAdministrativeScopes,
  type DesktopPrimaryBackendState,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
} from "@t3tools/client-runtime/authorization";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import { parseOAuthScope } from "@t3tools/shared/oauthScope";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import { parseDesktopAttachedBackendEndpoints } from "./DesktopAttachedBackendEndpoints.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

const attachedBearerExpiry = (now: number, expiresIn: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(now + Math.max(0, expiresIn) * 1000));

export class DesktopAttachPairingUrlError extends Schema.TaggedErrorClass<DesktopAttachPairingUrlError>()(
  "DesktopAttachPairingUrlError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class DesktopAttachManagedBackendConflictError extends Schema.TaggedErrorClass<DesktopAttachManagedBackendConflictError>()(
  "DesktopAttachManagedBackendConflictError",
  {},
) {
  override get message(): string {
    return "The desktop backend is already running at that endpoint.";
  }
}

export class DesktopAttachCredentialExchangeError extends Schema.TaggedErrorClass<DesktopAttachCredentialExchangeError>()(
  "DesktopAttachCredentialExchangeError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The owner credential was rejected by the backend.";
  }
}

export class DesktopAttachAdministrativeScopeError extends Schema.TaggedErrorClass<DesktopAttachAdministrativeScopeError>()(
  "DesktopAttachAdministrativeScopeError",
  { missingScopes: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return "The credential does not have the administrative access required by desktop Settings.";
  }
}

export class DesktopAttachDescriptorError extends Schema.TaggedErrorClass<DesktopAttachDescriptorError>()(
  "DesktopAttachDescriptorError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The backend did not return a valid environment identity.";
  }
}

export class DesktopAttachEncryptionUnavailableError extends Schema.TaggedErrorClass<DesktopAttachEncryptionUnavailableError>()(
  "DesktopAttachEncryptionUnavailableError",
  {},
) {
  override get message(): string {
    return "This desktop cannot securely store the attached backend credential.";
  }
}

export class DesktopAttachEncryptionError extends Schema.TaggedErrorClass<DesktopAttachEncryptionError>()(
  "DesktopAttachEncryptionError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The attached backend credential could not be protected by desktop storage.";
  }
}

export class DesktopAttachPersistenceError extends Schema.TaggedErrorClass<DesktopAttachPersistenceError>()(
  "DesktopAttachPersistenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The attached backend preference could not be saved.";
  }
}

export class DesktopAttachedCredentialUnavailableError extends Schema.TaggedErrorClass<DesktopAttachedCredentialUnavailableError>()(
  "DesktopAttachedCredentialUnavailableError",
  {},
) {
  override get message(): string {
    return "No valid attached backend credential is stored.";
  }
}

export class DesktopAttachedProbeError extends Schema.TaggedErrorClass<DesktopAttachedProbeError>()(
  "DesktopAttachedProbeError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The attached backend could not be reached with its stored credential.";
  }
}

export class DesktopAttachedIdentityMismatchError extends Schema.TaggedErrorClass<DesktopAttachedIdentityMismatchError>()(
  "DesktopAttachedIdentityMismatchError",
  {},
) {
  override get message(): string {
    return "The backend identity changed while the desktop was attached.";
  }
}

export class DesktopPrimaryBackendNotManagedError extends Schema.TaggedErrorClass<DesktopPrimaryBackendNotManagedError>()(
  "DesktopPrimaryBackendNotManagedError",
  { operation: Schema.String },
) {
  override get message(): string {
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

const invalidPairingUrl = (reason: string): DesktopAttachPairingUrlError =>
  new DesktopAttachPairingUrlError({ reason });

export const resolveDesktopAttachPairingTarget = (pairingUrl: string) =>
  Effect.suspend(() => {
    try {
      const url = new URL(pairingUrl.trim());
      if (url.protocol !== "http:" || url.username.length > 0 || url.password.length > 0) {
        return Effect.fail(
          invalidPairingUrl("Desktop attach links must use an HTTP loopback backend URL."),
        );
      }

      const searchKeys = [...url.searchParams.keys()];
      const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
      const hashKeys = [...hash.keys()];
      if (
        searchKeys.some((key) => key !== "token") ||
        hashKeys.some((key) => key !== "token") ||
        (searchKeys.includes("token") && hashKeys.includes("token"))
      ) {
        return Effect.fail(
          invalidPairingUrl("Desktop attach links contain unsupported parameters."),
        );
      }

      const target = resolveRemotePairingTarget({ pairingUrl: url.toString() });
      const endpoints = parseDesktopAttachedBackendEndpoints(target.httpBaseUrl, target.wsBaseUrl);
      if (endpoints === null) {
        return Effect.fail(
          invalidPairingUrl("Desktop attach links must use an HTTP loopback backend URL."),
        );
      }
      return Effect.succeed({ ...target, ...endpoints });
    } catch {
      return Effect.fail(invalidPairingUrl("Desktop attach URL is invalid."));
    }
  });

const missingAdministrativeScopes = (scope: string): ReadonlyArray<string> => {
  const granted = new Set(parseOAuthScope(scope) ?? []);
  return AuthAdministrativeScopes.filter((required) => !granted.has(required));
};

const redactedState = (
  preference: DesktopAppSettings.DesktopPrimaryBackendPreference,
): DesktopPrimaryBackendState => {
  if (preference.mode === "managed") return { mode: "managed" } as const;
  if (preference.mode === "invalid-attached") {
    return { mode: "invalid-attached", reason: preference.reason } as const;
  }
  return {
    mode: "attached",
    httpBaseUrl: preference.httpBaseUrl,
    environmentId: preference.environmentId,
    label: preference.label,
    bearerExpiresAt: preference.bearerExpiresAt,
  } as const;
};

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

  const withHttpClient = <A, E, R>(effect: Effect.Effect<A, E, R | HttpClient.HttpClient>) =>
    effect.pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  const readPreference = settings.get.pipe(Effect.map((value) => value.primaryBackend));

  const getBearerToken = Effect.gen(function* () {
    const preference = yield* readPreference;
    if (preference.mode !== "attached") {
      return yield* new DesktopAttachedCredentialUnavailableError();
    }
    const bytes = yield* Effect.fromResult(
      Encoding.decodeBase64(preference.encryptedBearerToken),
    ).pipe(Effect.mapError((cause) => new DesktopAttachedProbeError({ cause })));
    return yield* safeStorage
      .decryptString(bytes)
      .pipe(Effect.mapError((cause) => new DesktopAttachedProbeError({ cause })));
  }).pipe(Effect.withSpan("desktop.attachedBackend.getBearerToken"));

  const fetchDescriptor = (httpBaseUrl: string) =>
    withHttpClient(fetchRemoteEnvironmentDescriptor({ httpBaseUrl })).pipe(
      Effect.mapError((cause) => new DesktopAttachDescriptorError({ cause })),
    );

  const exchangeCredential = (input: {
    readonly httpBaseUrl: string;
    readonly credential: string;
  }) =>
    withHttpClient(
      bootstrapRemoteBearerSession({
        httpBaseUrl: input.httpBaseUrl,
        credential: input.credential,
        scopes: AuthAdministrativeScopes,
        clientMetadata: {
          label: "T3 Code Desktop",
          deviceType: "desktop",
          os: environment.platform,
          appVersion: environment.appVersion,
        },
      }),
    ).pipe(Effect.mapError((cause) => new DesktopAttachCredentialExchangeError({ cause })));

  const protectCredential = (credential: string) =>
    Effect.gen(function* () {
      if (
        !(yield* safeStorage.isEncryptionAvailable.pipe(
          Effect.mapError((cause) => new DesktopAttachEncryptionError({ cause })),
        ))
      ) {
        return yield* new DesktopAttachEncryptionUnavailableError();
      }
      const encrypted = yield* safeStorage
        .encryptString(credential)
        .pipe(Effect.mapError((cause) => new DesktopAttachEncryptionError({ cause })));
      return Encoding.encodeBase64(encrypted);
    });

  const persistAttached = Effect.fn("desktop.attachedBackend.persistAttached")(function* (input: {
    readonly descriptor: ExecutionEnvironmentDescriptor;
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly accessToken: string;
    readonly expiresIn: number;
  }) {
    const encryptedBearerToken = yield* protectCredential(input.accessToken);
    const preference: AttachedPreference = {
      mode: "attached",
      httpBaseUrl: input.httpBaseUrl,
      wsBaseUrl: input.wsBaseUrl,
      environmentId: input.descriptor.environmentId,
      label: input.descriptor.label,
      encryptedBearerToken,
      bearerExpiresAt: attachedBearerExpiry(yield* Clock.currentTimeMillis, input.expiresIn),
    };
    yield* settings
      .setPrimaryBackendPreference(preference)
      .pipe(Effect.mapError((cause) => new DesktopAttachPersistenceError({ cause })));
    return preference;
  });

  const attach = Effect.fn("desktop.attachedBackend.attach")(function* (pairingUrl: string) {
    const target = yield* resolveDesktopAttachPairingTarget(pairingUrl);
    const instances = yield* pool.list;
    for (const instance of instances) {
      const config = yield* instance.currentConfig;
      if (
        Option.isSome(config) &&
        config.value.httpBaseUrl.origin === new URL(target.httpBaseUrl).origin
      ) {
        return yield* new DesktopAttachManagedBackendConflictError();
      }
    }
    const session = yield* exchangeCredential({
      httpBaseUrl: target.httpBaseUrl,
      credential: target.credential,
    });
    const missingScopes = missingAdministrativeScopes(session.scope);
    if (missingScopes.length > 0) {
      return yield* new DesktopAttachAdministrativeScopeError({ missingScopes });
    }
    const descriptor = yield* fetchDescriptor(target.httpBaseUrl);
    const preference = yield* persistAttached({
      descriptor,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      accessToken: session.access_token,
      expiresIn: session.expires_in,
    });
    return redactedState(preference);
  });

  const refreshCredential = Effect.fn("desktop.attachedBackend.refreshCredential")(function* (
    pairingCredential: string,
  ) {
    const preference = yield* readPreference;
    if (preference.mode !== "attached") {
      return yield* new DesktopAttachedCredentialUnavailableError();
    }
    // The descriptor is public and unauthenticated; these checks reduce
    // endpoint substitution risk but do not authenticate a capable local impersonator.
    const precheckDescriptor = yield* fetchDescriptor(preference.httpBaseUrl);
    if (precheckDescriptor.environmentId !== preference.environmentId) {
      return yield* new DesktopAttachedIdentityMismatchError();
    }
    const session = yield* exchangeCredential({
      httpBaseUrl: preference.httpBaseUrl,
      credential: pairingCredential,
    });
    const missingScopes = missingAdministrativeScopes(session.scope);
    if (missingScopes.length > 0) {
      return yield* new DesktopAttachAdministrativeScopeError({ missingScopes });
    }
    const postcheckDescriptor = yield* fetchDescriptor(preference.httpBaseUrl);
    if (postcheckDescriptor.environmentId !== preference.environmentId) {
      return yield* new DesktopAttachedIdentityMismatchError();
    }
    yield* persistAttached({
      descriptor: postcheckDescriptor,
      httpBaseUrl: preference.httpBaseUrl,
      wsBaseUrl: preference.wsBaseUrl,
      accessToken: session.access_token,
      expiresIn: session.expires_in,
    });
  });

  const probe = Effect.gen(function* () {
    const preference = yield* readPreference;
    if (preference.mode !== "attached") {
      return yield* new DesktopAttachedCredentialUnavailableError();
    }
    const bearerToken = yield* getBearerToken;
    const descriptor = yield* fetchDescriptor(preference.httpBaseUrl);
    if (descriptor.environmentId !== preference.environmentId) {
      return yield* new DesktopAttachedIdentityMismatchError();
    }
    const session = yield* withHttpClient(
      fetchRemoteSessionState({
        httpBaseUrl: preference.httpBaseUrl,
        bearerToken,
      }),
    ).pipe(Effect.mapError((cause) => new DesktopAttachedProbeError({ cause })));
    if (
      !session.authenticated ||
      !session.scopes ||
      missingAdministrativeScopes(session.scopes.join(" ")).length > 0
    ) {
      return yield* new DesktopAttachedProbeError({
        cause: "Stored credential is not administrative.",
      });
    }
    return descriptor;
  }).pipe(Effect.withSpan("desktop.attachedBackend.probe"));

  const useManagedBackend = readPreference.pipe(
    Effect.flatMap((preference) =>
      preference.mode === "managed"
        ? Effect.void
        : settings.setPrimaryBackendPreference({ mode: "managed" }).pipe(
            Effect.mapError((cause) => new DesktopAttachPersistenceError({ cause })),
            Effect.asVoid,
          ),
    ),
  );

  return DesktopAttachedBackend.of({
    getState: readPreference.pipe(Effect.map(redactedState)),
    attach,
    refreshCredential,
    getBearerToken,
    probe,
    useManagedBackend,
  });
});

export const layer = Layer.effect(DesktopAttachedBackend, make);
