import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  SelfHostedRelayAudience,
  SelfHostedRelayDeviceEntitlement,
  SelfHostedRelayDeviceRegistration,
  SelfHostedRelayEnrolledEnvironment,
  SelfHostedRelayGrant,
  SelfHostedRelayIssuePairingInput,
  SelfHostedRelayPairing,
  SelfHostedRelayPairingCredential,
  SelfHostedRelayPrincipal,
  SelfHostedRelayRegisterDeviceInput,
  SelfHostedRelayRuntimeStatus,
  SelfHostedRelaySessionCredential,
} from "./selfHostedRelay.ts";

const decodeEntitlement = Schema.decodeUnknownSync(SelfHostedRelayDeviceEntitlement);
const decodeEnrollment = Schema.decodeSync(SelfHostedRelayEnrolledEnvironment);
const decodeStatus = Schema.decodeUnknownSync(SelfHostedRelayRuntimeStatus);
const decodePairingInput = Schema.decodeUnknownSync(SelfHostedRelayIssuePairingInput);
const decodePairingCredential = Schema.decodeUnknownSync(SelfHostedRelayPairingCredential);

const relayAudience = { kind: "relay", relayId: "relay-1" } as const;
const environmentAudience = { kind: "environment", environmentId: "env-1" } as const;
const grant = {
  version: 1,
  audience: relayAudience,
  grantId: "grant-1",
  subject: { kind: "device", deviceId: "device-1" },
  scope: {
    permissions: ["forward", "device.manageSelf"],
    environments: { kind: "selected", environmentIds: ["env-1"] },
  },
} as const;
const enrollment = {
  version: 1,
  relayId: "relay-1",
  environmentId: "env-1",
  name: "Local",
} as const;

describe("self-hosted relay v1 contracts", () => {
  it("keeps relay and destination audiences distinct", () => {
    const decodeAudience = Schema.decodeUnknownSync(SelfHostedRelayAudience);
    expect(decodeAudience(relayAudience)).toEqual(relayAudience);
    expect(decodeAudience(environmentAudience)).toEqual(environmentAudience);

    const decodeGrant = Schema.decodeUnknownSync(SelfHostedRelayGrant);
    expect(decodeGrant(grant)).toEqual(grant);
    expect(() => decodeGrant({ ...grant, audience: environmentAudience })).toThrow();
    expect(() => decodeGrant({ ...grant, audience: { kind: "relay", relayId: " " } })).toThrow();

    const decodePrincipal = Schema.decodeUnknownSync(SelfHostedRelayPrincipal);
    expect(decodePrincipal({ kind: "relay", grant })).toEqual({ kind: "relay", grant });
    expect(() => decodePrincipal({ kind: "localOwner" })).toThrow();
    expect(() =>
      decodePrincipal({ kind: "localProxy", principal: { kind: "relay", grant } }),
    ).toThrow();
  });

  it("rejects unknown grant versions, unbound subjects and local-only permissions", () => {
    const decode = Schema.decodeUnknownSync(SelfHostedRelayGrant);
    expect(() => decode({ ...grant, version: 2 })).toThrow();
    expect(() => decode({ ...grant, subject: { kind: "device" } })).toThrow();
    expect(() =>
      decode({ ...grant, subject: { kind: "publisher", deviceId: "device-1" } }),
    ).toThrow();
    expect(() =>
      decode({
        ...grant,
        scope: { ...grant.scope, permissions: ["status.read", "owner.recover"] },
      }),
    ).toThrow();
  });

  it("decodes pairing metadata with a valid expiration timestamp", () => {
    const decode = Schema.decodeUnknownSync(SelfHostedRelayPairing);
    const pairing = { version: 1, grant, expiresAt: "2026-11-19T18:30:00.000Z" };
    expect(decode(pairing)).toEqual(pairing);
    expect(() => decode({ ...pairing, expiresAt: "tomorrow" })).toThrow();
    const expiresAt = "2027-02-30T18:30:00Z";
    expect(() => decode({ ...pairing, expiresAt })).toThrow();
    expect(() =>
      decodePairingInput({
        version: 1,
        subject: grant.subject,
        scope: grant.scope,
        expiresAt,
      }),
    ).toThrow();
    expect(() =>
      decodePairingCredential({
        version: 1,
        relayId: "relay-1",
        pairingId: "pair-1",
        credential: "opaque",
        expiresAt,
      }),
    ).toThrow();
    expect(decode({ ...pairing, expiresAt: "2028-02-29T18:30:00-06:00" }).expiresAt).toBe(
      "2028-02-29T18:30:00-06:00",
    );
  });

  it("requires v1 on both kinds of credential responses", () => {
    const credential = { relayId: "relay-1", credential: "opaque" };
    const session = { ...credential, sessionId: "grant-1" };
    const pairing = { ...credential, pairingId: "pair-1", expiresAt: "2026-11-19T18:30:00Z" };
    const decodeSession = Schema.decodeUnknownSync(SelfHostedRelaySessionCredential);
    const decodePairing = Schema.decodeUnknownSync(SelfHostedRelayPairingCredential);
    expect(decodeSession({ ...session, version: 1 })).toEqual({ ...session, version: 1 });
    expect(decodePairing({ ...pairing, version: 1 })).toEqual({ ...pairing, version: 1 });
    expect(() => decodeSession(session)).toThrow();
    expect(() => decodePairing({ ...pairing, version: 2 })).toThrow();
    expect(() => decodeSession({ ...session, version: 1, credential: "" })).toThrow();
  });

  it("takes pairing authority from the issued grant rather than caller-provided identifiers", () => {
    const input = {
      version: 1,
      subject: grant.subject,
      scope: grant.scope,
      expiresAt: "2026-11-19T18:30:00Z",
      delegation: true,
    };
    const decode = Schema.decodeUnknownSync(SelfHostedRelayIssuePairingInput);
    expect(decode({ ...input, audience: environmentAudience, grantId: "caller-grant" })).toEqual(
      input,
    );
    expect(() => decode({ ...input, delegation: false })).toThrow();
  });

  it("keeps owner-granted activity sources separate from editable registration preferences", () => {
    const scope = { kind: "selected", environmentIds: ["env-1"] };
    const entitlement = {
      version: 1,
      relayId: "relay-1",
      deviceId: "device-1",
      environments: scope,
    };
    expect(decodeEntitlement(entitlement)).toEqual(entitlement);
    const registration = {
      version: 1,
      relayId: "relay-1",
      deviceId: "device-1",
      label: "Phone",
      preferences: { notificationsEnabled: true, liveActivitiesEnabled: false },
    };
    const decode = Schema.decodeUnknownSync(SelfHostedRelayDeviceRegistration);
    expect(
      decode({
        ...registration,
        preferences: { ...registration.preferences, environments: scope },
      }),
    ).toEqual(registration);
    const decodeInput = Schema.decodeUnknownSync(SelfHostedRelayRegisterDeviceInput);
    const { relayId: _relayId, ...input } = registration;
    expect(decodeInput({ ...registration, environments: scope })).toEqual(input);
  });

  it("keeps accepted identifiers representable in management paths", () => {
    for (const id of [".", "..", "\ud800", "\udfff"]) {
      expect(() => decodeEnrollment({ ...enrollment, environmentId: id })).toThrow();
      expect(() =>
        decodeEntitlement({
          version: 1,
          relayId: "relay-1",
          deviceId: id,
          environments: { kind: "all" },
        }),
      ).toThrow();
    }
    expect(() => decodeEnrollment({ ...enrollment, environmentId: "e".repeat(101) })).toThrow();
    expect(
      decodeEnrollment({ ...enrollment, environmentId: "e".repeat(100) }).environmentId,
    ).toHaveLength(100);
    expect(() =>
      decodeEntitlement({
        version: 1,
        relayId: "relay-1",
        deviceId: "d".repeat(101),
        environments: { kind: "all" },
      }),
    ).toThrow();
  });

  it("projects only redacted metadata into runtime status", () => {
    expect(decodeEnrollment(enrollment)).toEqual(enrollment);
    const status = { version: 1, relayId: "relay-1", state: "ready", environments: [enrollment] };
    const rawStatus = {
      ...status,
      ownerCredential: "secret",
      databasePath: "/private/state.sqlite",
      environments: [{ ...enrollment, publisherCredential: "secret", upstreamHost: "private" }],
    };
    expect(decodeStatus(rawStatus)).toEqual(status);
  });
});
