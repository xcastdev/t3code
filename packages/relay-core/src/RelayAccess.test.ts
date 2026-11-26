import { EnvironmentId } from "@t3tools/contracts";
import {
  SelfHostedRelayDeviceId,
  SelfHostedRelayGrantId,
  SelfHostedRelayId,
  type SelfHostedRelayDeviceEntitlement,
  type SelfHostedRelayEnvironmentScope,
  type SelfHostedRelayGrant,
  type SelfHostedRelayPrincipal,
  type SelfHostedRelayScope,
} from "@t3tools/contracts/selfHostedRelay";
import { describe, expect, it } from "vite-plus/test";

import {
  allowsRelayAccess,
  type RelayAccessAuthority,
  type RelayAccessOperation,
} from "./RelayAccess.ts";

const relayId = SelfHostedRelayId.make("relay");
const otherRelayId = SelfHostedRelayId.make("other-relay");
const first = EnvironmentId.make("first");
const second = EnvironmentId.make("second");
const deviceId = SelfHostedRelayDeviceId.make("phone");
const otherDeviceId = SelfHostedRelayDeviceId.make("tablet");
const all = { kind: "all" } as const;
const selected = (...environmentIds: EnvironmentId[]): SelfHostedRelayEnvironmentScope => ({
  kind: "selected",
  environmentIds,
});

const principal = (
  subject: SelfHostedRelayGrant["subject"],
  permissions: SelfHostedRelayScope["permissions"],
  environments: SelfHostedRelayEnvironmentScope = all,
): SelfHostedRelayPrincipal => ({
  kind: "relay",
  grant: {
    version: 1,
    audience: { kind: "relay", relayId },
    grantId: SelfHostedRelayGrantId.make("grant"),
    subject,
    scope: { permissions, environments },
  },
});

const operator = principal({ kind: "operator" }, [
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
const reader = principal({ kind: "operator" }, ["status.read", "discovery.read"], selected(first));
const client = principal({ kind: "client" }, ["forward"], selected(first));
const publisher = principal({ kind: "publisher", environmentId: first }, [
  "environment.publish",
  "environment.tunnel",
  "status.read",
  "discovery.read",
  "forward",
  "activity.read",
  "device.manageSelf",
  "environment.enroll",
  "environment.revoke",
]);
const device = principal({ kind: "device", deviceId }, [
  "discovery.read",
  "activity.read",
  "device.manageSelf",
  "device.manageEntitlement",
]);
const localOwner = { kind: "localOwner" } as const;
const entitlement: SelfHostedRelayDeviceEntitlement = {
  version: 1,
  relayId,
  deviceId,
  environments: selected(first),
};
const check = (authority: RelayAccessAuthority, operation: RelayAccessOperation) =>
  allowsRelayAccess(relayId, authority, operation);

describe("relay service access", () => {
  const matrix = [
    [{ kind: "owner.bootstrap" }, [true, false, false, false, false, false]],
    [{ kind: "owner.recover" }, [true, false, false, false, false, false]],
    [{ kind: "access.manage", grant: client.grant }, [false, true, false, false, false, false]],
    [{ kind: "access.delegate", grant: operator.grant }, [false, true, false, false, false, false]],
    [{ kind: "status.read", environmentId: first }, [false, true, true, false, false, false]],
    [{ kind: "discovery.read", environmentId: first }, [false, true, true, false, false, true]],
    [{ kind: "forward", environmentId: first }, [false, true, false, true, false, false]],
    [
      { kind: "environment.publish", environmentId: first },
      [false, false, false, false, true, false],
    ],
    [
      { kind: "environment.tunnel", environmentId: first },
      [false, false, false, false, true, false],
    ],
    [
      { kind: "activity.read", environmentId: first, entitlement },
      [false, false, false, false, false, true],
    ],
    [{ kind: "device.manageSelf", deviceId }, [false, false, false, false, false, true]],
    [
      { kind: "device.manageEntitlement", deviceId, environments: selected(first) },
      [false, true, false, false, false, false],
    ],
    [
      { kind: "environment.enroll", environmentId: first },
      [false, true, false, false, false, false],
    ],
    [
      { kind: "environment.revoke", environmentId: first },
      [false, true, false, false, false, false],
    ],
    [{ kind: "settings.write", environmentId: first }, [false, true, false, false, false, false]],
    [{ kind: "exposure.write", environmentId: first }, [false, true, false, false, false, false]],
    [{ kind: "backup.export" }, [false, true, false, false, false, false]],
    [{ kind: "backup.restore" }, [false, true, false, false, false, false]],
  ] as const satisfies readonly (readonly [RelayAccessOperation, readonly boolean[]])[];

  it.each(matrix)(
    "checks %o for local owner, operator, reader, client, publisher and device",
    (operation, expected) => {
      expect(
        [localOwner, operator, reader, client, publisher, device].map((actor) =>
          check(actor, operation),
        ),
      ).toEqual(expected);
    },
  );

  it("denies unknown operations and grants for a different relay audience", () => {
    // @ts-expect-error Exercise an unrecognized operation at runtime.
    expect(check(localOwner, { kind: "future.operation" })).toBe(false);
    // @ts-expect-error Exercise an unrecognized operation at runtime.
    expect(check(operator, { kind: "future.operation" })).toBe(false);
    expect(allowsRelayAccess(otherRelayId, operator, { kind: "status.read" })).toBe(false);
  });

  it("checks each scoped read, forward, and publish against its requested environment", () => {
    expect(check(reader, { kind: "status.read" })).toBe(false);
    expect(check(reader, { kind: "discovery.read", environmentId: second })).toBe(false);
    expect(check(client, { kind: "forward", environmentId: second })).toBe(false);
    expect(check(publisher, { kind: "environment.publish", environmentId: second })).toBe(false);
    expect(check(publisher, { kind: "environment.tunnel", environmentId: second })).toBe(false);
  });

  it("authorizes filtered lists with the exact named permission even when no rows are visible", () => {
    for (const kind of ["status.read", "discovery.read"] as const) {
      expect(check(reader, { kind, environments: selected(first) })).toBe(true);
      expect(check(reader, { kind, environments: selected() })).toBe(true);
      expect(check(client, { kind, environments: selected() })).toBe(false);
      expect(check(reader, { kind, environments: selected(first, second) })).toBe(false);
      expect(check(reader, { kind, environments: all })).toBe(false);
      expect(
        check(
          { kind: "localProxy", principal: operator, localScope: reader.grant.scope },
          { kind, environments: selected(first, second) },
        ),
      ).toBe(false);
    }
  });

  it("checks device binding and intersects the grant with the owner-managed entitlement", () => {
    expect(check(device, { kind: "device.manageSelf", deviceId: otherDeviceId })).toBe(false);
    expect(check(device, { kind: "activity.read", environmentId: second, entitlement })).toBe(
      false,
    );
    const activity: RelayAccessOperation = {
      kind: "activity.read",
      environmentId: first,
      entitlement: { ...entitlement, environments: all },
    };
    expect(
      check(device, { ...activity, entitlement: { ...entitlement, deviceId: otherDeviceId } }),
    ).toBe(false);
    expect(
      check(device, { ...activity, entitlement: { ...entitlement, relayId: otherRelayId } }),
    ).toBe(false);
    expect(
      check(principal(device.grant.subject, ["activity.read"], selected(second)), activity),
    ).toBe(false);
  });

  it("requires separate scopes for management, exposure, export and restore", () => {
    const manager = principal(
      { kind: "operator" },
      ["settings.write", "environment.enroll", "device.manageEntitlement", "backup.export"],
      selected(first),
    );
    expect(check(manager, { kind: "settings.write", environmentId: first })).toBe(true);
    expect(check(manager, { kind: "settings.write", environmentId: second })).toBe(false);
    expect(check(manager, { kind: "exposure.write", environmentId: first })).toBe(false);
    expect(check(manager, { kind: "environment.revoke", environmentId: first })).toBe(false);
    expect(check(manager, { kind: "device.manageEntitlement", deviceId, environments: all })).toBe(
      false,
    );
    expect(check(manager, { kind: "backup.export" })).toBe(false);
    const exporter = principal({ kind: "operator" }, ["backup.export"]);
    expect(check(exporter, { kind: "backup.export" })).toBe(true);
    expect(check(exporter, { kind: "backup.restore" })).toBe(false);
  });

  it("allows access managers to provision subjects within their own permission and membership ceilings", () => {
    const manager = principal({ kind: "operator" }, ["access.manage", "forward"], selected(first));
    expect(check(manager, { kind: "access.manage", grant: client.grant })).toBe(true);
    expect(check(manager, { kind: "access.manage", grant: device.grant })).toBe(false);
    expect(
      check(manager, {
        kind: "access.manage",
        grant: { ...client.grant, scope: { ...client.grant.scope, environments: all } },
      }),
    ).toBe(false);
    expect(
      check(operator, {
        kind: "access.manage",
        grant: {
          ...publisher.grant,
          scope: { permissions: ["environment.publish"], environments: selected(second) },
        },
      }),
    ).toBe(false);
  });

  it("keeps delegated permissions, membership, audience and subject binding within the parent grant", () => {
    const delegator = principal(
      { kind: "device", deviceId },
      ["access.delegate", "activity.read"],
      selected(first),
    );
    const grant = {
      ...delegator.grant,
      scope: { permissions: ["activity.read"], environments: selected(first) },
    } satisfies SelfHostedRelayGrant;
    expect(check(delegator, { kind: "access.delegate", grant })).toBe(true);
    for (const candidate of [
      { ...grant, subject: { kind: "device", deviceId: otherDeviceId } },
      { ...grant, subject: { kind: "operator" } },
      { ...grant, audience: { kind: "relay", relayId: otherRelayId } },
      { ...grant, scope: { ...grant.scope, permissions: ["forward"] } },
      { ...grant, scope: { ...grant.scope, environments: selected(second) } },
      { ...grant, scope: { ...grant.scope, environments: all } },
    ] satisfies SelfHostedRelayGrant[]) {
      expect(check(delegator, { kind: "access.delegate", grant: candidate })).toBe(false);
    }
    expect(check(delegator, { kind: "access.manage", grant })).toBe(false);

    const publishingDelegator = principal(
      { kind: "publisher", environmentId: first },
      ["access.delegate", "environment.publish"],
      selected(first),
    );
    expect(
      check(publishingDelegator, {
        kind: "access.delegate",
        grant: {
          ...publishingDelegator.grant,
          subject: { kind: "publisher", environmentId: second },
        },
      }),
    ).toBe(false);
  });

  it("intersects local proxy authority with the active relay grant for the exact operation", () => {
    const proxy = (
      relayPrincipal: SelfHostedRelayPrincipal,
      localScope: SelfHostedRelayScope,
    ): RelayAccessAuthority => ({
      kind: "localProxy",
      principal: relayPrincipal,
      localScope,
    });
    const localScope = {
      permissions: ["settings.write", "access.delegate", "forward"],
      environments: selected(first),
    } satisfies SelfHostedRelayScope;
    const actor = proxy(operator, localScope);
    expect(check(actor, { kind: "settings.write", environmentId: first })).toBe(true);
    expect(check(actor, { kind: "settings.write", environmentId: second })).toBe(false);
    expect(check(actor, { kind: "exposure.write", environmentId: first })).toBe(false);
    expect(check(proxy(reader, localScope), { kind: "settings.write", environmentId: first })).toBe(
      false,
    );
    expect(check(actor, { kind: "owner.bootstrap" })).toBe(false);
    expect(check(actor, { kind: "owner.recover" })).toBe(false);

    const grant = {
      ...operator.grant,
      scope: { permissions: ["forward"], environments: selected(first) },
    } satisfies SelfHostedRelayGrant;
    expect(check(actor, { kind: "access.delegate", grant })).toBe(true);
    expect(
      check(actor, {
        kind: "access.delegate",
        grant: { ...grant, scope: { ...grant.scope, environments: all } },
      }),
    ).toBe(false);
    expect(
      check(actor, {
        kind: "access.delegate",
        grant: { ...grant, scope: { ...grant.scope, permissions: ["exposure.write"] } },
      }),
    ).toBe(false);
  });
});
