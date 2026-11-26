import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const pathIdentifier = Schema.makeFilter(
  (value: string) => {
    if (value === "." || value === "..") return false;
    try {
      encodeURIComponent(value);
      return true;
    } catch {
      return false;
    }
  },
  { expected: "an encodable URL path identifier other than a dot segment" },
);
const relayEnvironmentId = EnvironmentId.check(Schema.isMaxLength(100), pathIdentifier);
const relayIdentifier = TrimmedNonEmptyString.check(Schema.isMaxLength(100), pathIdentifier);

export const SelfHostedRelayId = relayIdentifier.pipe(Schema.brand("SelfHostedRelayId"));
export type SelfHostedRelayId = typeof SelfHostedRelayId.Type;

export const SelfHostedRelayGrantId = relayIdentifier.pipe(Schema.brand("SelfHostedRelayGrantId"));
export type SelfHostedRelayGrantId = typeof SelfHostedRelayGrantId.Type;

export const SelfHostedRelayDeviceId = relayIdentifier.pipe(
  Schema.brand("SelfHostedRelayDeviceId"),
);
export type SelfHostedRelayDeviceId = typeof SelfHostedRelayDeviceId.Type;

const version = Schema.Literal(1);
const relayAudience = Schema.Struct({ kind: Schema.Literal("relay"), relayId: SelfHostedRelayId });
export const SelfHostedRelayAudience = Schema.Union([
  relayAudience,
  Schema.Struct({ kind: Schema.Literal("environment"), environmentId: relayEnvironmentId }),
]);
export type SelfHostedRelayAudience = typeof SelfHostedRelayAudience.Type;

export const SelfHostedRelayPermission = Schema.Literals([
  "access.manage",
  "access.delegate",
  "status.read",
  "discovery.read",
  "forward",
  "environment.publish",
  "environment.tunnel",
  "activity.read",
  "device.manageSelf",
  "device.manageEntitlement",
  "environment.enroll",
  "environment.revoke",
  "settings.write",
  "exposure.write",
  "backup.export",
  "backup.restore",
]);
export type SelfHostedRelayPermission = typeof SelfHostedRelayPermission.Type;

export const SelfHostedRelayEnvironmentScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({
    kind: Schema.Literal("selected"),
    environmentIds: Schema.Array(relayEnvironmentId),
  }),
]);
export type SelfHostedRelayEnvironmentScope = typeof SelfHostedRelayEnvironmentScope.Type;

export const SelfHostedRelayScope = Schema.Struct({
  permissions: Schema.Array(SelfHostedRelayPermission),
  environments: SelfHostedRelayEnvironmentScope,
});
export type SelfHostedRelayScope = typeof SelfHostedRelayScope.Type;

export const SelfHostedRelaySubject = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("operator") }),
  Schema.Struct({ kind: Schema.Literal("client") }),
  Schema.Struct({ kind: Schema.Literal("device"), deviceId: SelfHostedRelayDeviceId }),
  Schema.Struct({ kind: Schema.Literal("publisher"), environmentId: relayEnvironmentId }),
]);
export type SelfHostedRelaySubject = typeof SelfHostedRelaySubject.Type;

export const SelfHostedRelayGrant = Schema.Struct({
  version,
  audience: relayAudience,
  grantId: SelfHostedRelayGrantId,
  subject: SelfHostedRelaySubject,
  scope: SelfHostedRelayScope,
});
export type SelfHostedRelayGrant = typeof SelfHostedRelayGrant.Type;

export const SelfHostedRelayPrincipal = Schema.Struct({
  kind: Schema.Literal("relay"),
  grant: SelfHostedRelayGrant,
});
export type SelfHostedRelayPrincipal = typeof SelfHostedRelayPrincipal.Type;

const expirationTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u),
  Schema.makeFilter(
    (value) => {
      const date = value.slice(0, 10);
      const midnight = Date.parse(`${date}T00:00:00Z`);
      return (
        Number.isFinite(Date.parse(value)) &&
        Number.isFinite(midnight) &&
        DateTime.formatIso(DateTime.makeUnsafe(midnight)).slice(0, 10) === date
      );
    },
    { expected: "an ISO 8601 timestamp with a valid calendar date and time zone" },
  ),
);

const credentialFields = {
  version,
  relayId: SelfHostedRelayId,
  credential: Schema.String.check(Schema.isMinLength(1)),
};

export const SelfHostedRelaySessionCredential = Schema.Struct({
  ...credentialFields,
  sessionId: SelfHostedRelayGrantId,
});
export type SelfHostedRelaySessionCredential = typeof SelfHostedRelaySessionCredential.Type;

export const SelfHostedRelayPairingCredential = Schema.Struct({
  ...credentialFields,
  pairingId: SelfHostedRelayGrantId,
  expiresAt: expirationTimestamp,
});
export type SelfHostedRelayPairingCredential = typeof SelfHostedRelayPairingCredential.Type;

export const SelfHostedRelayIssuePairingInput = Schema.Struct({
  version,
  subject: SelfHostedRelaySubject,
  scope: SelfHostedRelayScope,
  expiresAt: expirationTimestamp,
  delegation: Schema.optionalKey(Schema.Literal(true)),
});
export type SelfHostedRelayIssuePairingInput = typeof SelfHostedRelayIssuePairingInput.Type;

export const SelfHostedRelayRevokePairingInput = Schema.Struct({
  version,
  pairingId: SelfHostedRelayGrantId,
});
export type SelfHostedRelayRevokePairingInput = typeof SelfHostedRelayRevokePairingInput.Type;

export const SelfHostedRelayRevokeSessionInput = Schema.Struct({
  version,
  sessionId: SelfHostedRelayGrantId,
});
export type SelfHostedRelayRevokeSessionInput = typeof SelfHostedRelayRevokeSessionInput.Type;

export const SelfHostedRelayPairing = Schema.Struct({
  version,
  grant: SelfHostedRelayGrant,
  expiresAt: expirationTimestamp,
});
export type SelfHostedRelayPairing = typeof SelfHostedRelayPairing.Type;

export const SelfHostedRelayRevokeEnvironmentInput = Schema.Struct({
  version,
  environmentId: relayEnvironmentId,
});
export type SelfHostedRelayRevokeEnvironmentInput =
  typeof SelfHostedRelayRevokeEnvironmentInput.Type;

export const SelfHostedRelayEnrollEnvironmentInput = Schema.Struct({
  ...SelfHostedRelayRevokeEnvironmentInput.fields,
  name: TrimmedNonEmptyString,
});
export type SelfHostedRelayEnrollEnvironmentInput =
  typeof SelfHostedRelayEnrollEnvironmentInput.Type;

export const SelfHostedRelayEnrolledEnvironment = Schema.Struct({
  ...SelfHostedRelayEnrollEnvironmentInput.fields,
  relayId: SelfHostedRelayId,
});
export type SelfHostedRelayEnrolledEnvironment = typeof SelfHostedRelayEnrolledEnvironment.Type;

export const SelfHostedRelayRevokeDeviceInput = Schema.Struct({
  version,
  deviceId: SelfHostedRelayDeviceId,
});
export type SelfHostedRelayRevokeDeviceInput = typeof SelfHostedRelayRevokeDeviceInput.Type;

export const SelfHostedRelaySetDeviceEntitlementInput = Schema.Struct({
  ...SelfHostedRelayRevokeDeviceInput.fields,
  environments: SelfHostedRelayEnvironmentScope,
});
export type SelfHostedRelaySetDeviceEntitlementInput =
  typeof SelfHostedRelaySetDeviceEntitlementInput.Type;

export const SelfHostedRelayDeviceEntitlement = Schema.Struct({
  ...SelfHostedRelaySetDeviceEntitlementInput.fields,
  relayId: SelfHostedRelayId,
});
export type SelfHostedRelayDeviceEntitlement = typeof SelfHostedRelayDeviceEntitlement.Type;

export const SelfHostedRelayRegisterDeviceInput = Schema.Struct({
  ...SelfHostedRelayRevokeDeviceInput.fields,
  label: TrimmedNonEmptyString,
  preferences: Schema.Struct({
    notificationsEnabled: Schema.Boolean,
    liveActivitiesEnabled: Schema.Boolean,
  }),
});
export type SelfHostedRelayRegisterDeviceInput = typeof SelfHostedRelayRegisterDeviceInput.Type;

export const SelfHostedRelayDeviceRegistration = Schema.Struct({
  ...SelfHostedRelayRegisterDeviceInput.fields,
  relayId: SelfHostedRelayId,
});
export type SelfHostedRelayDeviceRegistration = typeof SelfHostedRelayDeviceRegistration.Type;

export const SelfHostedRelayRuntimeStatus = Schema.Struct({
  version,
  relayId: SelfHostedRelayId,
  state: Schema.Literals(["uninitialized", "ready"]),
  environments: Schema.Array(SelfHostedRelayEnrolledEnvironment),
});
export type SelfHostedRelayRuntimeStatus = typeof SelfHostedRelayRuntimeStatus.Type;
