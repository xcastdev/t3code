import type { EnvironmentId } from "@t3tools/contracts";
import type {
  SelfHostedRelayDeviceEntitlement,
  SelfHostedRelayDeviceId,
  SelfHostedRelayEnvironmentScope,
  SelfHostedRelayGrant,
  SelfHostedRelayId,
  SelfHostedRelayPrincipal,
  SelfHostedRelayScope,
} from "@t3tools/contracts/selfHostedRelay";

export type RelayAccessAuthority =
  | SelfHostedRelayPrincipal
  | { readonly kind: "localOwner" }
  | {
      readonly kind: "localProxy";
      readonly principal: SelfHostedRelayPrincipal;
      readonly localScope: SelfHostedRelayScope;
    };

export type RelayAccessOperation =
  | { readonly kind: "owner.bootstrap" | "owner.recover" }
  | { readonly kind: "access.manage" | "access.delegate"; readonly grant: SelfHostedRelayGrant }
  | {
      readonly kind: "status.read" | "discovery.read" | "settings.write" | "exposure.write";
      readonly environmentId?: EnvironmentId;
    }
  | {
      readonly kind: "status.read" | "discovery.read";
      readonly environments: SelfHostedRelayEnvironmentScope;
    }
  | {
      readonly kind:
        | "forward"
        | "environment.publish"
        | "environment.tunnel"
        | "environment.enroll"
        | "environment.revoke";
      readonly environmentId: EnvironmentId;
    }
  | {
      readonly kind: "activity.read";
      readonly environmentId: EnvironmentId;
      readonly entitlement: SelfHostedRelayDeviceEntitlement;
    }
  | { readonly kind: "device.manageSelf"; readonly deviceId: SelfHostedRelayDeviceId }
  | {
      readonly kind: "device.manageEntitlement";
      readonly deviceId: SelfHostedRelayDeviceId;
      readonly environments: SelfHostedRelayEnvironmentScope;
    }
  | { readonly kind: "backup.export" | "backup.restore" };

function includesEnvironment(scope: SelfHostedRelayEnvironmentScope, environmentId: EnvironmentId) {
  return scope.kind === "all" || scope.environmentIds.includes(environmentId);
}

export function coversEnvironments(
  ceiling: SelfHostedRelayEnvironmentScope,
  requested: SelfHostedRelayEnvironmentScope,
) {
  return (
    ceiling.kind === "all" ||
    (requested.kind === "selected" &&
      requested.environmentIds.every((environmentId) =>
        includesEnvironment(ceiling, environmentId),
      ))
  );
}

function coversScope(ceiling: SelfHostedRelayScope, requested: SelfHostedRelayScope) {
  return (
    coversEnvironments(ceiling.environments, requested.environments) &&
    requested.permissions.every((permission) => ceiling.permissions.includes(permission))
  );
}

function sameSubject(
  source: SelfHostedRelayGrant["subject"],
  target: SelfHostedRelayGrant["subject"],
) {
  switch (source.kind) {
    case "device":
      return target.kind === "device" && target.deviceId === source.deviceId;
    case "publisher":
      return target.kind === "publisher" && target.environmentId === source.environmentId;
    default:
      return target.kind === source.kind;
  }
}

// The runtime resolves the current grant and entitlement and supplies any local authority.
export function allowsRelayAccess(
  relayId: SelfHostedRelayId,
  authority: RelayAccessAuthority,
  operation: RelayAccessOperation,
): boolean {
  if (operation.kind === "owner.bootstrap" || operation.kind === "owner.recover") {
    return authority.kind === "localOwner";
  }
  if (authority.kind === "localOwner") return false;

  const principal = authority.kind === "localProxy" ? authority.principal : authority;
  const localScope = authority.kind === "localProxy" ? authority.localScope : undefined;
  const { audience, subject, scope } = principal.grant;
  if (
    audience.kind !== "relay" ||
    audience.relayId !== relayId ||
    !scope.permissions.includes(operation.kind) ||
    (localScope !== undefined && !localScope.permissions.includes(operation.kind))
  ) {
    return false;
  }

  const includesTarget = (environmentId: EnvironmentId | undefined) =>
    environmentId !== undefined &&
    includesEnvironment(scope.environments, environmentId) &&
    (localScope === undefined || includesEnvironment(localScope.environments, environmentId));
  const coversTargets = (environments: SelfHostedRelayEnvironmentScope) =>
    coversEnvironments(scope.environments, environments) &&
    (localScope === undefined || coversEnvironments(localScope.environments, environments));
  const relayWide =
    scope.environments.kind === "all" &&
    (localScope === undefined || localScope.environments.kind === "all");

  switch (operation.kind) {
    case "access.manage":
    case "access.delegate": {
      const target = operation.grant;
      const targetSubject = target.subject;
      const targetEnvironments = target.scope.environments;
      return (
        (operation.kind === "access.manage"
          ? subject.kind === "operator"
          : sameSubject(subject, targetSubject)) &&
        target.audience.kind === "relay" &&
        target.audience.relayId === relayId &&
        coversScope(scope, target.scope) &&
        (localScope === undefined || coversScope(localScope, target.scope)) &&
        (targetSubject.kind !== "publisher" ||
          (targetEnvironments.kind === "selected" &&
            targetEnvironments.environmentIds.includes(targetSubject.environmentId) &&
            targetEnvironments.environmentIds.every(
              (environmentId) => environmentId === targetSubject.environmentId,
            )))
      );
    }
    case "status.read":
    case "discovery.read":
      if (subject.kind === "publisher") return false;
      if ("environments" in operation) return coversTargets(operation.environments);
      return operation.environmentId === undefined
        ? relayWide
        : includesTarget(operation.environmentId);
    case "forward":
      return subject.kind !== "publisher" && includesTarget(operation.environmentId);
    case "environment.publish":
    case "environment.tunnel":
      return (
        subject.kind === "publisher" &&
        subject.environmentId === operation.environmentId &&
        includesTarget(operation.environmentId)
      );
    case "activity.read": {
      const { entitlement, environmentId } = operation;
      return (
        subject.kind === "device" &&
        entitlement.relayId === relayId &&
        entitlement.deviceId === subject.deviceId &&
        includesTarget(environmentId) &&
        includesEnvironment(entitlement.environments, environmentId)
      );
    }
    case "device.manageSelf":
      return subject.kind === "device" && subject.deviceId === operation.deviceId;
    case "device.manageEntitlement":
      return subject.kind === "operator" && coversTargets(operation.environments);
    case "environment.enroll":
    case "environment.revoke":
      return subject.kind === "operator" && includesTarget(operation.environmentId);
    case "settings.write":
    case "exposure.write":
      return (
        subject.kind === "operator" &&
        (operation.environmentId === undefined
          ? relayWide
          : includesTarget(operation.environmentId))
      );
    case "backup.export":
    case "backup.restore":
      return subject.kind === "operator" && relayWide;
    default:
      return false;
  }
}
