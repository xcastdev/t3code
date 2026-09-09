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
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as NodeCrypto from "node:crypto";

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

export class DesktopAttachFreshPairingUrlRequiredError extends Schema.TaggedErrorClass<DesktopAttachFreshPairingUrlRequiredError>()(
  "DesktopAttachFreshPairingUrlRequiredError",
  {},
) {
  override get message(): string {
    return "This owner pairing URL cannot be reused. Run `t3 pair --owner` to create a fresh desktop pairing URL.";
  }
}

export class DesktopAttachOwnershipChangedError extends Schema.TaggedErrorClass<DesktopAttachOwnershipChangedError>()(
  "DesktopAttachOwnershipChangedError",
  {},
) {
  override get message(): string {
    return "The attached backend changed before its replacement credential could be saved.";
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
  DesktopAttachFreshPairingUrlRequiredError,
  DesktopAttachOwnershipChangedError,
  DesktopAttachedCredentialUnavailableError,
  DesktopAttachedProbeError,
  DesktopAttachedIdentityMismatchError,
]);
export type DesktopAttachedBackendError = typeof DesktopAttachedBackendError.Type;

type AttachedPreference = Extract<
  DesktopAppSettings.DesktopPrimaryBackendPreference,
  { readonly mode: "attached" }
>;

type AttachedPreferenceIdentity = Pick<
  AttachedPreference,
  "httpBaseUrl" | "wsBaseUrl" | "environmentId" | "label"
>;

const attachedPreferenceIdentity = (
  preference: AttachedPreference,
): AttachedPreferenceIdentity => ({
  httpBaseUrl: preference.httpBaseUrl,
  wsBaseUrl: preference.wsBaseUrl,
  environmentId: preference.environmentId,
  label: preference.label,
});

const sameAttachedPreferenceIdentity = (
  left: AttachedPreference,
  right: AttachedPreferenceIdentity,
): boolean =>
  left.httpBaseUrl === right.httpBaseUrl &&
  left.wsBaseUrl === right.wsBaseUrl &&
  left.environmentId === right.environmentId &&
  left.label === right.label;

const secretFingerprint = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

type DesktopAttachPairingTarget = {
  readonly credential: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
};

const attachmentFingerprint = (target: DesktopAttachPairingTarget): string =>
  secretFingerprint(`${target.httpBaseUrl}\0${target.credential}`);

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
  const ownershipLock = yield* Semaphore.make(1);

  type PreparedAttachment = {
    readonly pairingFingerprint: string;
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly accessToken: string;
    readonly bearerExpiresAt: string;
  };
  type PreparedCredentialRenewal = {
    readonly renewalId: number;
    readonly credentialFingerprint: string;
    readonly preference: AttachedPreference;
    readonly accessToken: string;
    readonly bearerExpiresAt: string;
  };
  type CompletedCredentialRenewal = {
    readonly credentialFingerprint: string;
    readonly preferenceIdentity: AttachedPreferenceIdentity;
    readonly bearerExpiresAt: string;
  };
  type CompletedPairing = {
    readonly pairingFingerprint: string;
    readonly preferenceIdentity: AttachedPreferenceIdentity;
    readonly bearerExpiresAt: string;
  };
  type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  let preparedAttachment: PreparedAttachment | null = null;
  let consumedPairingFingerprints = new Set<string>();
  let consumedRenewalFingerprints = new Set<string>();
  let completedPairing: CompletedPairing | null = null;
  let preparedRenewal: PreparedCredentialRenewal | null = null;
  let completedRenewal: CompletedCredentialRenewal | null = null;
  let nextRenewalId = 0;

  const clearPreparedRenewal = () => {
    preparedRenewal = null;
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      preparedAttachment = null;
      preparedRenewal = null;
      // Fingerprints are non-secret, but dropping them also releases the
      // closure's ownership bookkeeping when this layer is finalized.
      consumedPairingFingerprints = new Set();
      consumedRenewalFingerprints = new Set();
      completedPairing = null;
      completedRenewal = null;
    }),
  );

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
    readonly bearerExpiresAt: string;
  }) {
    const encryptedBearerToken = yield* protectCredential(input.accessToken);
    const preference: AttachedPreference = {
      mode: "attached",
      httpBaseUrl: input.httpBaseUrl,
      wsBaseUrl: input.wsBaseUrl,
      environmentId: input.descriptor.environmentId,
      label: input.descriptor.label,
      encryptedBearerToken,
      bearerExpiresAt: input.bearerExpiresAt,
    };
    yield* settings
      .setPrimaryBackendPreference(preference)
      .pipe(Effect.mapError((cause) => new DesktopAttachPersistenceError({ cause })));
    return preference;
  });

  const prepare = Effect.fn("desktop.attachedBackend.prepare")(function* (
    target: DesktopAttachPairingTarget,
    pairingFingerprint: string,
    restore: Restore,
  ) {
    if (preparedAttachment?.pairingFingerprint === pairingFingerprint) {
      if (Date.parse(preparedAttachment.bearerExpiresAt) <= (yield* Clock.currentTimeMillis)) {
        preparedAttachment = null;
        return yield* new DesktopAttachFreshPairingUrlRequiredError();
      }
      return preparedAttachment;
    }
    if (consumedPairingFingerprints.has(pairingFingerprint)) {
      return yield* new DesktopAttachFreshPairingUrlRequiredError();
    }

    const instances = yield* restore(pool.list);
    for (const instance of instances) {
      const config = yield* restore(instance.currentConfig);
      if (
        Option.isSome(config) &&
        config.value.httpBaseUrl.origin === new URL(target.httpBaseUrl).origin
      ) {
        return yield* new DesktopAttachManagedBackendConflictError();
      }
    }

    // A valid replacement supersedes any incomplete transaction. The old
    // bearer is dropped before a new one-time credential is exchanged.
    preparedAttachment = null;
    clearPreparedRenewal();
    completedRenewal = null;
    completedPairing = null;
    consumedPairingFingerprints.add(pairingFingerprint);
    const session = yield* restore(
      exchangeCredential({
        httpBaseUrl: target.httpBaseUrl,
        credential: target.credential,
      }),
    );
    const bearerExpiresAt = attachedBearerExpiry(
      yield* Clock.currentTimeMillis,
      session.expires_in,
    );
    const missingScopes = missingAdministrativeScopes(session.scope);
    if (missingScopes.length > 0) {
      return yield* new DesktopAttachAdministrativeScopeError({ missingScopes });
    }
    preparedAttachment = {
      pairingFingerprint,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      accessToken: session.access_token,
      bearerExpiresAt,
    };
    return preparedAttachment;
  });

  const complete = Effect.fn("desktop.attachedBackend.complete")(function* (
    transaction: PreparedAttachment,
    restore: Restore,
  ) {
    const descriptor = yield* restore(fetchDescriptor(transaction.httpBaseUrl));
    const preference = yield* restore(
      persistAttached({
        descriptor,
        httpBaseUrl: transaction.httpBaseUrl,
        wsBaseUrl: transaction.wsBaseUrl,
        accessToken: transaction.accessToken,
        bearerExpiresAt: transaction.bearerExpiresAt,
      }),
    );
    preparedAttachment = null;
    completedPairing = {
      pairingFingerprint: transaction.pairingFingerprint,
      preferenceIdentity: attachedPreferenceIdentity(preference),
      bearerExpiresAt: transaction.bearerExpiresAt,
    };
    return redactedState(preference);
  });

  const attach = (pairingUrl: string) =>
    ownershipLock.withPermits(1)(
      Effect.gen(function* () {
        const normalizedPairingUrl = pairingUrl.trim();
        const target = yield* resolveDesktopAttachPairingTarget(normalizedPairingUrl);
        const pairingFingerprint = attachmentFingerprint(target);
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (
              completedPairing?.pairingFingerprint === pairingFingerprint &&
              preparedAttachment === null
            ) {
              const preference = yield* restore(readPreference);
              const now = yield* Clock.currentTimeMillis;
              if (
                preference.mode === "attached" &&
                sameAttachedPreferenceIdentity(preference, completedPairing.preferenceIdentity) &&
                Date.parse(completedPairing.bearerExpiresAt) > now
              ) {
                return redactedState(preference);
              }
              completedPairing = null;
            }

            clearPreparedRenewal();
            completedRenewal = null;
            const transaction = yield* prepare(target, pairingFingerprint, restore);
            return yield* complete(transaction, restore);
          }),
        );
      }),
    );

  const completeRenewal = Effect.fn("desktop.attachedBackend.completeRenewal")(function* (
    transaction: PreparedCredentialRenewal,
    restore: Restore,
  ) {
    const currentPreference = yield* restore(readPreference);
    if (
      currentPreference.mode !== "attached" ||
      !sameAttachedPreferenceIdentity(
        currentPreference,
        attachedPreferenceIdentity(transaction.preference),
      )
    ) {
      if (preparedRenewal?.renewalId === transaction.renewalId) clearPreparedRenewal();
      return yield* new DesktopAttachOwnershipChangedError();
    }

    const postcheckDescriptor = yield* restore(fetchDescriptor(transaction.preference.httpBaseUrl));
    if (postcheckDescriptor.environmentId !== transaction.preference.environmentId) {
      return yield* new DesktopAttachedIdentityMismatchError();
    }

    // Re-check ownership immediately before the only write. Production
    // ownership writers share ownershipLock; this comparison also protects
    // against an accidental future writer bypassing that lock.
    const currentBeforePersist = yield* restore(readPreference);
    if (
      currentBeforePersist.mode !== "attached" ||
      !sameAttachedPreferenceIdentity(
        currentBeforePersist,
        attachedPreferenceIdentity(transaction.preference),
      )
    ) {
      if (preparedRenewal?.renewalId === transaction.renewalId) clearPreparedRenewal();
      return yield* new DesktopAttachOwnershipChangedError();
    }

    const persistedPreference = yield* restore(
      persistAttached({
        descriptor: postcheckDescriptor,
        httpBaseUrl: transaction.preference.httpBaseUrl,
        wsBaseUrl: transaction.preference.wsBaseUrl,
        accessToken: transaction.accessToken,
        bearerExpiresAt: transaction.bearerExpiresAt,
      }),
    );
    if (preparedRenewal?.renewalId === transaction.renewalId) {
      preparedRenewal = null;
      completedRenewal = {
        credentialFingerprint: transaction.credentialFingerprint,
        preferenceIdentity: attachedPreferenceIdentity(persistedPreference),
        bearerExpiresAt: transaction.bearerExpiresAt,
      };
    }
  });

  const refreshCredential = (pairingCredential: string) =>
    ownershipLock.withPermits(1)(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const preference = yield* restore(readPreference);
          if (preference.mode !== "attached") {
            return yield* new DesktopAttachedCredentialUnavailableError();
          }

          const credentialFingerprint = secretFingerprint(pairingCredential);
          const now = yield* Clock.currentTimeMillis;
          if (preparedRenewal !== null) {
            if (
              preparedRenewal.credentialFingerprint === credentialFingerprint &&
              sameAttachedPreferenceIdentity(
                preference,
                attachedPreferenceIdentity(preparedRenewal.preference),
              ) &&
              Date.parse(preparedRenewal.bearerExpiresAt) > now
            ) {
              return yield* completeRenewal(preparedRenewal, restore);
            }
            clearPreparedRenewal();
          }

          if (
            completedRenewal !== null &&
            completedRenewal.credentialFingerprint === credentialFingerprint &&
            sameAttachedPreferenceIdentity(preference, completedRenewal.preferenceIdentity)
          ) {
            if (Date.parse(completedRenewal.bearerExpiresAt) > now) return;
            completedRenewal = null;
          }
          if (consumedRenewalFingerprints.has(credentialFingerprint)) {
            return yield* new DesktopAttachFreshPairingUrlRequiredError();
          }

          preparedAttachment = null;
          completedRenewal = null;

          // The descriptor is public and unauthenticated; these checks reduce
          // endpoint substitution risk but do not authenticate a capable local
          // impersonator.
          const precheckDescriptor = yield* restore(fetchDescriptor(preference.httpBaseUrl));
          if (precheckDescriptor.environmentId !== preference.environmentId) {
            return yield* new DesktopAttachedIdentityMismatchError();
          }

          consumedRenewalFingerprints.add(credentialFingerprint);
          const session = yield* restore(
            exchangeCredential({
              httpBaseUrl: preference.httpBaseUrl,
              credential: pairingCredential,
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  // The exchange result is uncertain. Keep only the
                  // non-secret consumed fingerprint; never retain a bearer.
                  clearPreparedRenewal();
                }),
              ),
            ),
          );
          const bearerExpiresAt = attachedBearerExpiry(
            yield* Clock.currentTimeMillis,
            session.expires_in,
          );
          const missingScopes = missingAdministrativeScopes(session.scope);
          if (missingScopes.length > 0) {
            return yield* new DesktopAttachAdministrativeScopeError({ missingScopes });
          }

          const transaction: PreparedCredentialRenewal = {
            renewalId: ++nextRenewalId,
            credentialFingerprint,
            preference,
            accessToken: session.access_token,
            bearerExpiresAt,
          };
          // Publication happens inside the uninterruptible region. Typed
          // failures after this point leave the bearer available for retry.
          preparedRenewal = transaction;
          return yield* completeRenewal(transaction, restore);
        }),
      ),
    );

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

  const useManagedBackend = ownershipLock.withPermits(1)(
    Effect.gen(function* () {
      clearPreparedRenewal();
      preparedAttachment = null;
      completedRenewal = null;
      completedPairing = null;
      const preference = yield* readPreference;
      if (preference.mode === "managed") return;
      yield* settings.setPrimaryBackendPreference({ mode: "managed" }).pipe(
        Effect.mapError((cause) => new DesktopAttachPersistenceError({ cause })),
        Effect.asVoid,
      );
    }),
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
