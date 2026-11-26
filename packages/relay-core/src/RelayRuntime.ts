// @effect-diagnostics-next-line nodeBuiltinImport:off -- Generate opaque relay secrets and hash them at the Node credential boundary.
import * as NodeCrypto from "node:crypto";

import type { EnvironmentId } from "@t3tools/contracts";
import {
  SelfHostedRelayDeviceEntitlement,
  type SelfHostedRelayDeviceId,
  SelfHostedRelayDeviceRegistration,
  SelfHostedRelayEnrolledEnvironment,
  SelfHostedRelayEnrollEnvironmentInput,
  type SelfHostedRelayEnvironmentScope,
  SelfHostedRelayGrant,
  SelfHostedRelayGrantId,
  type SelfHostedRelayId,
  SelfHostedRelayIssuePairingInput,
  type SelfHostedRelayPairingCredential,
  SelfHostedRelayPermission,
  type SelfHostedRelayPrincipal,
  SelfHostedRelayRegisterDeviceInput,
  type SelfHostedRelayRuntimeStatus,
  type SelfHostedRelaySessionCredential,
  SelfHostedRelaySetDeviceEntitlementInput,
} from "@t3tools/contracts/selfHostedRelay";
import {
  SelfHostedRelayHookTarget as RelayHookTarget,
  SelfHostedRelayHookPolicy as RelayHookPolicy,
} from "@t3tools/contracts/selfHostedRelayHooks";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { isSqlError, type SqlError } from "effect/sql/SqlError";
import type { Fragment } from "effect/sql/Statement";

import { allowsRelayAccess, coversEnvironments, type RelayAccessOperation } from "./RelayAccess.ts";
import * as Store from "./RelayStore.ts";

export { RelayStorageError } from "./RelayStore.ts";

export class RelayAuthenticationError extends Schema.TaggedError<RelayAuthenticationError>()(
  "RelayAuthenticationError",
  {},
) {
  override get message() {
    return "Invalid, expired, or revoked relay credential.";
  }
}

export class RelayAccessDeniedError extends Schema.TaggedError<RelayAccessDeniedError>()(
  "RelayAccessDeniedError",
  {},
) {
  override get message() {
    return "The relay grant does not authorize this operation.";
  }
}

export class RelayRuntimeStateError extends Schema.TaggedError<RelayRuntimeStateError>()(
  "RelayRuntimeStateError",
  { reason: Schema.Literals(["already-initialized", "uninitialized", "unavailable"]) },
) {
  override get message() {
    return `Relay operation unavailable (${this.reason}).`;
  }
}

export class RelayInputError extends Schema.TaggedError<RelayInputError>()("RelayInputError", {}) {
  override get message() {
    return "Invalid relay operation input.";
  }
}

type OperationError =
  | RelayAuthenticationError
  | RelayAccessDeniedError
  | RelayRuntimeStateError
  | RelayInputError
  | Store.RelayStorageError;

type LiveOperation = {
  readonly kind: "forward" | "environment.publish" | "environment.tunnel";
  readonly environmentId: EnvironmentId;
};

type LocalStatus = Pick<SelfHostedRelayRuntimeStatus, "version" | "relayId" | "state"> & {
  readonly schemaVersion: Store.RelayStore["Service"]["schemaVersion"];
  readonly storage: Store.RelayStore["Service"]["writerSettings"];
};

const isHookPolicy = Schema.is(RelayHookPolicy);
const isHookTarget = Schema.is(RelayHookTarget);

export class RelayRuntime extends Context.Service<
  RelayRuntime,
  {
    readonly localStatus: () => Effect.Effect<LocalStatus, OperationError>;
    readonly bootstrapOwner: () => Effect.Effect<SelfHostedRelaySessionCredential, OperationError>;
    readonly recoverOwner: () => Effect.Effect<SelfHostedRelaySessionCredential, OperationError>;
    readonly authenticate: (
      credential: string,
    ) => Effect.Effect<SelfHostedRelayPrincipal, OperationError>;
    readonly status: (
      credential: string,
      environmentId?: EnvironmentId,
    ) => Effect.Effect<SelfHostedRelayRuntimeStatus, OperationError>;
    readonly issuePairing: (
      credential: string,
      input: SelfHostedRelayIssuePairingInput,
    ) => Effect.Effect<SelfHostedRelayPairingCredential, OperationError>;
    readonly redeemPairing: (
      credential: string,
    ) => Effect.Effect<SelfHostedRelaySessionCredential, OperationError>;
    readonly revokePairing: (
      credential: string,
      pairingId: SelfHostedRelayGrantId,
    ) => Effect.Effect<void, OperationError>;
    readonly revokeSession: (
      credential: string,
      sessionId: SelfHostedRelayGrantId,
    ) => Effect.Effect<void, OperationError>;
    readonly discoverEnvironments: (
      credential: string,
      environmentId?: EnvironmentId,
    ) => Effect.Effect<ReadonlyArray<SelfHostedRelayEnrolledEnvironment>, OperationError>;
    readonly enrollEnvironment: (
      credential: string,
      input: SelfHostedRelayEnrollEnvironmentInput,
    ) => Effect.Effect<SelfHostedRelayEnrolledEnvironment, OperationError>;
    readonly revokeEnvironment: (
      credential: string,
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, OperationError>;
    readonly registerDevice: (
      credential: string,
      input: SelfHostedRelayRegisterDeviceInput,
    ) => Effect.Effect<SelfHostedRelayDeviceRegistration, OperationError>;
    readonly getDeviceRegistration: (
      credential: string,
      deviceId: SelfHostedRelayDeviceId,
    ) => Effect.Effect<SelfHostedRelayDeviceRegistration, OperationError>;
    readonly setDeviceEntitlement: (
      credential: string,
      input: SelfHostedRelaySetDeviceEntitlementInput,
    ) => Effect.Effect<SelfHostedRelayDeviceEntitlement, OperationError>;
    readonly revokeDevice: (
      credential: string,
      deviceId: SelfHostedRelayDeviceId,
    ) => Effect.Effect<void, OperationError>;
    readonly setHookPolicy: (
      credential: string,
      input: RelayHookPolicy,
    ) => Effect.Effect<RelayHookPolicy, OperationError>;
    readonly getHookPolicy: (
      credential: string,
      input: RelayHookTarget,
    ) => Effect.Effect<RelayHookPolicy | null, OperationError>;
    readonly authorizeHook: (input: RelayHookTarget) => Effect.Effect<
      {
        readonly holdEnabled: boolean;
        readonly revision: string;
        readonly signal: AbortSignal;
      } | null,
      OperationError,
      Scope.Scope
    >;
    readonly authorizeLive: (
      credential: string,
      operation: LiveOperation,
    ) => Effect.Effect<AbortSignal, OperationError, Scope.Scope>;
  }
>()("@t3tools/relay-core/RelayRuntime") {}

const hash = (credential: string) =>
  NodeCrypto.createHash("sha256").update(credential).digest("hex");
const credentialPrefix = (
  kind: "session" | "pairing",
  relayId: SelfHostedRelayId,
  generation: number,
) => `t3-${kind}-1.${relayId}.${generation}.`;
const createCredential = (
  kind: "session" | "pairing",
  relayId: SelfHostedRelayId,
  generation: number,
) => credentialPrefix(kind, relayId, generation) + NodeCrypto.randomBytes(32).toString("base64url");

const encodeGrant = Schema.encodeEffect(Schema.fromJsonString(SelfHostedRelayGrant));
const encodeEnvironment = Schema.encodeEffect(
  Schema.fromJsonString(SelfHostedRelayEnrolledEnvironment),
);
const encodeDeviceRegistration = Schema.encodeEffect(
  Schema.fromJsonString(SelfHostedRelayDeviceRegistration),
);
const encodeDeviceEntitlement = Schema.encodeEffect(
  Schema.fromJsonString(SelfHostedRelayDeviceEntitlement),
);

const decodedGrant = Schema.decodeUnknownEffect(Schema.fromJsonString(SelfHostedRelayGrant));
const decodedEnvironment = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SelfHostedRelayEnrolledEnvironment),
);
const decodedDeviceRegistration = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SelfHostedRelayDeviceRegistration),
);
const decodedDeviceEntitlement = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SelfHostedRelayDeviceEntitlement),
);
const isPairingInput = Schema.is(SelfHostedRelayIssuePairingInput);
const isEnrollmentInput = Schema.is(SelfHostedRelayEnrollEnvironmentInput);
const isRegistrationInput = Schema.is(SelfHostedRelayRegisterDeviceInput);
const isEntitlementInput = Schema.is(SelfHostedRelaySetDeviceEntitlementInput);

const emptyEnvironmentScope = { kind: "selected", environmentIds: [] } as const;

interface GrantRow {
  readonly grant_id: string;
  readonly parent_grant_id: string | null;
  readonly generation: number;
  readonly subject_kind: string;
  readonly subject_id: string | null;
  readonly grant_json: string;
  readonly pairing_hash: string | null;
  readonly expires_at: number | null;
  readonly session_hash: string | null;
  readonly revoked: number;
}

interface EnvironmentRow {
  readonly environment_id: EnvironmentId;
  readonly record_json: string;
}

interface LiveStream {
  readonly grantId: SelfHostedRelayGrantId;
  readonly environmentId: EnvironmentId;
}

interface DeviceRow {
  readonly device_id: SelfHostedRelayDeviceId;
  readonly binding_grant_id: string | null;
  readonly registration_json: string | null;
  readonly entitlement_json: string | null;
}

const subjectId = (subject: SelfHostedRelayGrant["subject"]) => {
  switch (subject.kind) {
    case "device":
      return subject.deviceId;
    case "publisher":
      return subject.environmentId;
    default:
      return null;
  }
};

const invalidState = () => new Store.RelayStorageError({ reason: "invalid-state" });

type RelayRuntimeOptions = {
  readonly homeDirectory: string;
  readonly beforeEnvironmentRevoke?: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<void, Store.RelayStorageError>;
};

const make = Effect.fn("RelayRuntime.make")(function* ({
  beforeEnvironmentRevoke,
}: RelayRuntimeOptions) {
  const { sql, relayId, schemaVersion, writerSettings } = yield* Store.RelayStore;
  const gate = yield* Semaphore.make(1);
  const streams = new Map<AbortController, LiveStream>();
  const hookStreams = new Map<AbortController, RelayHookTarget>();
  const abortHooks = (matches: (target: RelayHookTarget) => boolean) => {
    for (const [controller, target] of hookStreams) {
      if (matches(target)) {
        hookStreams.delete(controller);
        controller.abort();
      }
    }
  };
  let closed = false;

  const abortStreams = (matches: (stream: LiveStream) => boolean) => {
    for (const [controller, stream] of streams) {
      if (matches(stream)) {
        streams.delete(controller);
        controller.abort();
      }
    }
  };

  const close = Effect.sync(() => {
    closed = true;
    abortStreams(() => true);
    abortHooks(() => true);
  });
  yield* Effect.addFinalizer(() => close);

  const generation = Effect.gen(function* () {
    const [row] = yield* sql<{
      generation: number;
    }>`SELECT generation FROM relay_identity WHERE singleton = 1`;
    if (!row || !Number.isSafeInteger(row.generation) || row.generation < 0) {
      return yield* invalidState();
    }
    return row.generation;
  });

  const checkCredential = Effect.fn("RelayRuntime.checkCredential")(function* (
    token: string,
    kind: "session" | "pairing",
  ) {
    const current = yield* generation;
    const prefix = credentialPrefix(kind, relayId, current);
    if (!token.startsWith(prefix) || !/^[A-Za-z0-9_-]{43}$/u.test(token.slice(prefix.length))) {
      return yield* new RelayAuthenticationError();
    }
    return { current, digest: hash(token) };
  });

  const decodeGrant = Effect.fn("RelayRuntime.decodeGrant")(function* (row: GrantRow) {
    const grant = yield* decodedGrant(row.grant_json).pipe(
      Effect.mapError((cause) => new Store.RelayStorageError({ reason: "invalid-state", cause })),
    );
    if (
      grant.audience.relayId !== relayId ||
      grant.grantId !== row.grant_id ||
      grant.subject.kind !== row.subject_kind ||
      subjectId(grant.subject) !== row.subject_id
    ) {
      return yield* invalidState();
    }
    return grant;
  });

  const principalFor = Effect.fn("RelayRuntime.principalFor")(function* (credential: string) {
    const { current, digest } = yield* checkCredential(credential, "session");
    const [row] = yield* sql<GrantRow>`
      SELECT * FROM relay_grants
      WHERE session_hash = ${digest} AND generation = ${current} AND revoked = 0
    `;
    if (!row) return yield* new RelayAuthenticationError();
    const grant = yield* decodeGrant(row);
    return { kind: "relay", grant } satisfies SelfHostedRelayPrincipal;
  });

  const requireAccess = (principal: SelfHostedRelayPrincipal, operation: RelayAccessOperation) =>
    allowsRelayAccess(relayId, principal, operation)
      ? Effect.void
      : Effect.fail(new RelayAccessDeniedError());

  const transaction = <A, E extends OperationError, R>(
    body: Effect.Effect<A, E | SqlError, R>,
    afterCommit?: (result: A) => void,
  ) =>
    Effect.flatMap(Effect.serviceOption(sql.transactionService), (outer) =>
      Option.isSome(outer)
        ? Effect.fail(new RelayRuntimeStateError({ reason: "unavailable" }))
        : Effect.void,
    ).pipe(
      Effect.andThen(
        gate.withPermits(1)(
          Effect.uninterruptible(
            Effect.suspend((): Effect.Effect<A, E | SqlError | RelayRuntimeStateError, R> =>
              closed
                ? Effect.fail(new RelayRuntimeStateError({ reason: "unavailable" }))
                : sql.withTransaction(
                    Effect.suspend(
                      (): Effect.Effect<A, E | SqlError | RelayRuntimeStateError, R> =>
                        closed
                          ? Effect.fail(new RelayRuntimeStateError({ reason: "unavailable" }))
                          : body,
                    ),
                  ),
            ).pipe(
              Effect.mapError((error) => (isSqlError(error) ? Store.storageError(error) : error)),
              Effect.tap((result) => Effect.sync(() => afterCommit?.(result))),
              Effect.tapCause((cause) =>
                Cause.hasDies(cause) ||
                cause.reasons.some(
                  (reason) =>
                    Cause.isFailReason(reason) && reason.error._tag === "RelayStorageError",
                )
                  ? close
                  : Effect.void,
              ),
            ),
          ),
        ),
      ),
    );

  const insertGrant = Effect.fn("RelayRuntime.insertGrant")(function* (
    grant: SelfHostedRelayGrant,
    current: number,
    issuerId: SelfHostedRelayGrantId | null,
    pairingHash: string | null,
    expiresAt: number | null,
    sessionHash: string | null,
  ) {
    yield* sql`
      INSERT INTO relay_grants (
        grant_id, parent_grant_id, generation, subject_kind, subject_id, grant_json,
        pairing_hash, expires_at, session_hash
      ) VALUES (
        ${grant.grantId}, ${issuerId}, ${current}, ${grant.subject.kind}, ${subjectId(grant.subject)},
        ${yield* encodeGrant(grant).pipe(Effect.mapError(invalidState))}, ${pairingHash}, ${expiresAt}, ${sessionHash}
      )
    `;
  });

  const newGrant = (
    subject: SelfHostedRelayGrant["subject"],
    scope: SelfHostedRelayGrant["scope"],
  ): SelfHostedRelayGrant => ({
    version: 1,
    audience: { kind: "relay", relayId },
    grantId: SelfHostedRelayGrantId.make(NodeCrypto.randomUUID()),
    subject,
    scope,
  });

  const ownerSession = Effect.fn("RelayRuntime.ownerSession")(function* (
    operation: "owner.bootstrap" | "owner.recover",
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        if (!allowsRelayAccess(relayId, { kind: "localOwner" }, { kind: operation })) {
          return yield* new RelayAccessDeniedError();
        }
        const previous = yield* generation;
        if (operation === "owner.bootstrap" && previous !== 0) {
          return yield* new RelayRuntimeStateError({ reason: "already-initialized" });
        }
        if (operation === "owner.recover" && previous === 0) {
          return yield* new RelayRuntimeStateError({ reason: "uninitialized" });
        }
        const current = previous + 1;
        const grant = newGrant(
          { kind: "operator" },
          { permissions: SelfHostedRelayPermission.literals, environments: { kind: "all" } },
        );
        const credential = createCredential("session", relayId, current);
        yield* sql`UPDATE relay_identity SET generation = ${current} WHERE singleton = 1`;
        yield* sql`UPDATE relay_grants SET revoked = 1, pairing_hash = NULL, expires_at = NULL, session_hash = NULL WHERE revoked = 0`;
        yield* insertGrant(grant, current, null, null, null, hash(credential));
        return {
          version: 1,
          relayId,
          sessionId: grant.grantId,
          credential,
        } satisfies SelfHostedRelaySessionCredential;
      }),
      () => {
        abortStreams(() => true);
        abortHooks(() => true);
      },
    );
  });

  const getDevice = (deviceId: SelfHostedRelayDeviceId) =>
    sql<DeviceRow>`SELECT * FROM relay_devices WHERE device_id = ${deviceId}`;

  const deviceIssuer = Effect.fn("RelayRuntime.deviceIssuer")(function* (grantId: string) {
    const [issuer] = yield* sql<GrantRow>`
      WITH RECURSIVE lineage(grant_id, parent_grant_id, subject_kind) AS (
        SELECT grant_id, parent_grant_id, subject_kind FROM relay_grants WHERE grant_id = ${grantId}
        UNION ALL
        SELECT parent.grant_id, parent.parent_grant_id, parent.subject_kind
        FROM relay_grants parent JOIN lineage child ON parent.grant_id = child.parent_grant_id
        WHERE child.subject_kind = 'device'
      )
      SELECT relay_grants.* FROM lineage JOIN relay_grants USING (grant_id)
      WHERE lineage.subject_kind = 'operator'
    `;
    if (!issuer) return yield* invalidState();
    return issuer;
  });

  const canPairDevice = Effect.fn("RelayRuntime.canPairDevice")(function* (
    deviceId: SelfHostedRelayDeviceId,
    parentGrantId: string,
  ) {
    const [device] = yield* getDevice(deviceId);
    if (!device) return true;
    const issuer = yield* deviceIssuer(parentGrantId);
    if (device.binding_grant_id !== null) {
      const boundIssuer = yield* deviceIssuer(device.binding_grant_id);
      // Only the newly recovered owner can rebind a device from an older generation.
      return (
        issuer.grant_id === boundIssuer.grant_id ||
        (issuer.parent_grant_id === null && issuer.generation > boundIssuer.generation)
      );
    }
    if (device.registration_json !== null && issuer.parent_grant_id !== null) return false;
    const entitlement = yield* readEntitlement(deviceId, device);
    if (!entitlement) return true;
    const issuerGrant = yield* decodeGrant(issuer);
    return coversEnvironments(issuerGrant.scope.environments, entitlement.environments);
  });

  const issuePairing = Effect.fn("RelayRuntime.issuePairing")(function* (
    credential: string,
    input: SelfHostedRelayIssuePairingInput,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const principal = yield* principalFor(credential);
        if (!isPairingInput(input)) return yield* new RelayInputError();
        const grant = newGrant(input.subject, input.scope);
        yield* requireAccess(principal, {
          kind: input.delegation ? "access.delegate" : "access.manage",
          grant,
        });
        if (
          grant.subject.kind === "device" &&
          !(yield* canPairDevice(grant.subject.deviceId, principal.grant.grantId))
        ) {
          return yield* new RelayAccessDeniedError();
        }
        const current = yield* generation;
        const expiresAt = Date.parse(input.expiresAt);
        if (expiresAt <= (yield* Clock.currentTimeMillis)) return yield* new RelayInputError();
        const pairing = createCredential("pairing", relayId, current);
        yield* insertGrant(grant, current, principal.grant.grantId, hash(pairing), expiresAt, null);
        return {
          version: 1,
          relayId,
          pairingId: grant.grantId,
          credential: pairing,
          expiresAt: input.expiresAt,
        } satisfies SelfHostedRelayPairingCredential;
      }),
    );
  });

  const redeemPairing = Effect.fn("RelayRuntime.redeemPairing")(function* (credential: string) {
    return yield* transaction(
      Effect.gen(function* () {
        const { current, digest } = yield* checkCredential(credential, "pairing");
        const [row] = yield* sql<GrantRow>`
        SELECT * FROM relay_grants WHERE pairing_hash = ${digest} AND generation = ${current}
          AND revoked = 0 AND expires_at > ${yield* Clock.currentTimeMillis}
      `;
        if (!row) return yield* new RelayAuthenticationError();
        const grant = yield* decodeGrant(row);
        if (grant.subject.kind === "device") {
          const { deviceId } = grant.subject;
          if (row.parent_grant_id === null) return yield* invalidState();
          if (!(yield* canPairDevice(deviceId, row.parent_grant_id))) {
            return yield* new RelayAuthenticationError();
          }
          yield* sql`
            INSERT INTO relay_devices (device_id, binding_grant_id)
            VALUES (${deviceId}, ${grant.grantId})
            ON CONFLICT(device_id) DO UPDATE SET binding_grant_id = excluded.binding_grant_id
            WHERE relay_devices.binding_grant_id IS NULL OR EXISTS (
              SELECT 1 FROM relay_grants
              WHERE grant_id = relay_devices.binding_grant_id AND generation < ${current}
            )
          `;
        }
        const session = createCredential("session", relayId, current);
        yield* sql`
        UPDATE relay_grants SET pairing_hash = NULL, expires_at = NULL, session_hash = ${hash(session)}
        WHERE grant_id = ${grant.grantId}
      `;
        return {
          version: 1,
          relayId,
          sessionId: grant.grantId,
          credential: session,
        } satisfies SelfHostedRelaySessionCredential;
      }),
    );
  });

  const revokeTree = (roots: Fragment) => sql<{ grant_id: SelfHostedRelayGrantId }>`
    WITH RECURSIVE affected(grant_id) AS (
      ${roots}
      UNION
      SELECT child.grant_id FROM relay_grants child JOIN affected parent
        ON child.parent_grant_id = parent.grant_id
    )
    UPDATE relay_grants SET revoked = 1, pairing_hash = NULL, expires_at = NULL, session_hash = NULL
    WHERE revoked = 0 AND grant_id IN (SELECT grant_id FROM affected)
    RETURNING grant_id
  `;

  const abortGrants = (rows: ReadonlyArray<{ readonly grant_id: SelfHostedRelayGrantId }>) => {
    const revoked = new Set(rows.map((row) => row.grant_id));
    abortStreams((stream) => revoked.has(stream.grantId));
  };

  const revokeGrant = Effect.fn("RelayRuntime.revokeGrant")(function* (
    credential: string,
    grantId: SelfHostedRelayGrantId,
    kind: "pairing" | "session",
  ) {
    yield* transaction(
      Effect.gen(function* () {
        const principal = yield* principalFor(credential);
        const current = yield* generation;
        const [row] = yield* sql<GrantRow>`
          SELECT * FROM relay_grants WHERE grant_id = ${grantId} AND generation = ${current}
            AND parent_grant_id IS NOT NULL AND revoked = 0
        `;
        if (!row || (kind === "session" && !row.session_hash))
          return yield* new RelayAccessDeniedError();
        const grant = yield* decodeGrant(row);
        if (
          principal.grant.grantId !== grantId &&
          row.parent_grant_id !== principal.grant.grantId
        ) {
          yield* requireAccess(principal, { kind: "access.manage", grant });
        }
        return yield* revokeTree(sql`SELECT ${grantId}`);
      }),
      abortGrants,
    );
  });

  const readEnvironment = (row: EnvironmentRow) =>
    decodedEnvironment(row.record_json).pipe(
      Effect.mapError(invalidState),
      Effect.filterOrFail(
        (record) => record.relayId === relayId && record.environmentId === row.environment_id,
        invalidState,
      ),
    );

  const listEnvironments = Effect.fn("RelayRuntime.listEnvironments")(function* (
    principal: SelfHostedRelayPrincipal,
    kind: "discovery.read" | "status.read",
    environmentId?: EnvironmentId,
  ) {
    if (environmentId !== undefined) {
      yield* requireAccess(principal, { kind, environmentId });
    } else {
      yield* requireAccess(principal, { kind, environments: principal.grant.scope.environments });
    }
    const rows = yield* environmentId === undefined
      ? sql<EnvironmentRow>`
          SELECT * FROM relay_environments ORDER BY environment_id
        `
      : sql<EnvironmentRow>`
          SELECT * FROM relay_environments WHERE environment_id = ${environmentId}
        `;
    return yield* Effect.forEach(
      rows.filter((row) =>
        allowsRelayAccess(relayId, principal, { kind, environmentId: row.environment_id }),
      ),
      readEnvironment,
    );
  });

  const enrollEnvironment = Effect.fn("RelayRuntime.enrollEnvironment")(function* (
    credential: string,
    input: SelfHostedRelayEnrollEnvironmentInput,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const principal = yield* principalFor(credential);
        if (!isEnrollmentInput(input)) return yield* new RelayInputError();
        yield* requireAccess(principal, {
          kind: "environment.enroll",
          environmentId: input.environmentId,
        });
        const record = {
          version: 1,
          relayId,
          environmentId: input.environmentId,
          name: input.name,
        } satisfies SelfHostedRelayEnrolledEnvironment;
        yield* sql`
        INSERT INTO relay_environments (environment_id, record_json)
        VALUES (${record.environmentId}, ${yield* encodeEnvironment(record).pipe(Effect.mapError(invalidState))})
        ON CONFLICT(environment_id) DO UPDATE SET record_json = excluded.record_json
      `;
        return record;
      }),
    );
  });

  const revokeEnvironment = Effect.fn("RelayRuntime.revokeEnvironment")(function* (
    credential: string,
    environmentId: EnvironmentId,
  ) {
    yield* transaction(
      Effect.gen(function* () {
        const principal = yield* principalFor(credential);
        yield* requireAccess(principal, { kind: "environment.revoke", environmentId });
        yield* beforeEnvironmentRevoke?.(environmentId) ?? Effect.void;
        yield* sql`DELETE FROM relay_environments WHERE environment_id = ${environmentId}`;
        return yield* revokeTree(sql`
          SELECT grant_id FROM relay_grants WHERE subject_kind = 'publisher' AND subject_id = ${environmentId}
        `);
      }),
      (revoked) => {
        abortGrants(revoked);
        abortStreams((stream) => stream.environmentId === environmentId);
        abortHooks((target) => target.environmentId === environmentId);
      },
    );
  });

  const readEntitlement = Effect.fn("RelayRuntime.readEntitlement")(function* (
    deviceId: SelfHostedRelayDeviceId,
    row: DeviceRow | undefined,
  ) {
    if (row?.entitlement_json == null) return undefined;
    const entitlement = yield* decodedDeviceEntitlement(row.entitlement_json).pipe(
      Effect.mapError(() => invalidState()),
    );
    if (entitlement.relayId !== relayId || entitlement.deviceId !== deviceId) {
      return yield* invalidState();
    }
    return entitlement;
  });

  const registerDevice = Effect.fn("RelayRuntime.registerDevice")(function* (
    credential: string,
    input: SelfHostedRelayRegisterDeviceInput,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const principal = yield* principalFor(credential);
        if (!isRegistrationInput(input)) return yield* new RelayInputError();
        yield* requireAccess(principal, { kind: "device.manageSelf", deviceId: input.deviceId });
        const record = {
          version: 1,
          relayId,
          deviceId: input.deviceId,
          label: input.label,
          preferences: {
            liveActivitiesEnabled: input.preferences.liveActivitiesEnabled,
            notificationsEnabled: input.preferences.notificationsEnabled,
          },
        } satisfies SelfHostedRelayDeviceRegistration;
        yield* sql`
        INSERT INTO relay_devices (device_id, registration_json)
        VALUES (${record.deviceId}, ${yield* encodeDeviceRegistration(record).pipe(Effect.mapError(invalidState))})
        ON CONFLICT(device_id) DO UPDATE SET registration_json = excluded.registration_json
      `;
        return record;
      }),
    );
  });

  const readRegistration = (row: DeviceRow) =>
    decodedDeviceRegistration(row.registration_json).pipe(
      Effect.mapError(invalidState),
      Effect.filterOrFail(
        (record) => record.relayId === relayId && record.deviceId === row.device_id,
        invalidState,
      ),
    );

  const getDeviceRegistration = Effect.fn("RelayRuntime.getDeviceRegistration")(function* (
    credential: string,
    deviceId: SelfHostedRelayDeviceId,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const principal = yield* principalFor(credential);
        yield* requireAccess(principal, { kind: "device.manageSelf", deviceId });
        const [row] = yield* getDevice(deviceId);
        if (!row?.registration_json)
          return yield* new RelayRuntimeStateError({ reason: "unavailable" });
        return yield* readRegistration(row);
      }),
    );
  });

  const setDeviceEntitlement = Effect.fn("RelayRuntime.setDeviceEntitlement")(function* (
    credential: string,
    input: SelfHostedRelaySetDeviceEntitlementInput,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const principal = yield* principalFor(credential);
        if (!isEntitlementInput(input)) return yield* new RelayInputError();
        const { deviceId, environments } = input;
        yield* requireAccess(principal, {
          kind: "device.manageEntitlement",
          deviceId,
          environments,
        });
        const [row] = yield* getDevice(deviceId);
        const previous = yield* readEntitlement(deviceId, row);
        if (previous) {
          yield* requireAccess(principal, {
            kind: "device.manageEntitlement",
            deviceId,
            environments: previous.environments,
          });
        }
        const record = {
          version: 1,
          relayId,
          deviceId,
          environments:
            environments.kind === "all"
              ? { kind: "all" }
              : { kind: "selected", environmentIds: [...new Set(environments.environmentIds)] },
        } satisfies SelfHostedRelayDeviceEntitlement;
        yield* sql`
        INSERT INTO relay_devices (device_id, entitlement_json)
        VALUES (${record.deviceId}, ${yield* encodeDeviceEntitlement(record).pipe(Effect.mapError(invalidState))})
        ON CONFLICT(device_id) DO UPDATE SET entitlement_json = excluded.entitlement_json
      `;
        return record;
      }),
    );
  });

  const revokeDevice = Effect.fn("RelayRuntime.revokeDevice")(function* (
    credential: string,
    deviceId: SelfHostedRelayDeviceId,
  ) {
    yield* transaction(
      Effect.gen(function* () {
        const principal = yield* principalFor(credential);
        const [row] = yield* getDevice(deviceId);
        const entitlement = yield* readEntitlement(deviceId, row);
        const environments: SelfHostedRelayEnvironmentScope =
          entitlement?.environments ?? emptyEnvironmentScope;
        yield* requireAccess(principal, {
          kind: "device.manageEntitlement",
          deviceId,
          environments,
        });
        const deviceGrants = yield* sql<GrantRow>`
          SELECT * FROM relay_grants
          WHERE (subject_kind = 'device' AND subject_id = ${deviceId} AND revoked = 0)
            OR grant_id = ${row?.binding_grant_id ?? null}
        `;
        for (const row of deviceGrants) {
          const grant = yield* decodeGrant(row);
          yield* requireAccess(principal, {
            kind: "device.manageEntitlement",
            deviceId,
            environments: grant.scope.environments,
          });
        }
        yield* sql`DELETE FROM relay_devices WHERE device_id = ${deviceId}`;
        return yield* revokeTree(sql`
          SELECT grant_id FROM relay_grants WHERE subject_kind = 'device' AND subject_id = ${deviceId}
        `);
      }),
      abortGrants,
    );
  });

  const readHookPolicy = Effect.fn("RelayRuntime.readHookPolicy")(function* (
    input: RelayHookTarget,
  ) {
    const current = yield* generation;
    const [row] = yield* sql<{ enabled: number; hold_enabled: number; revision: string }>`
      SELECT policy.enabled, policy.hold_enabled, policy.revision FROM relay_hook_policies policy
      JOIN relay_environments environment ON environment.environment_id = policy.environment_id
      WHERE policy.environment_id = ${input.environmentId} AND policy.hook_id = ${input.hookId}
        AND policy.generation = ${current}
    `;
    return row
      ? {
          ...input,
          enabled: row.enabled === 1,
          holdEnabled: row.hold_enabled === 1,
          revision: row.revision,
        }
      : null;
  });
  const setHookPolicy = Effect.fn("RelayRuntime.setHookPolicy")(function* (
    credential: string,
    input: RelayHookPolicy,
  ) {
    if (!isHookPolicy(input)) return yield* new RelayInputError();
    input = {
      environmentId: input.environmentId,
      hookId: input.hookId,
      enabled: input.enabled,
      holdEnabled: input.holdEnabled,
    };
    return yield* transaction(
      Effect.gen(function* () {
        yield* requireAccess(yield* principalFor(credential), {
          kind: "exposure.write",
          environmentId: input.environmentId,
        });
        const [environment] =
          yield* sql`SELECT 1 FROM relay_environments WHERE environment_id = ${input.environmentId}`;
        if (!environment) return yield* new RelayAccessDeniedError();
        const previous = yield* readHookPolicy(input);
        if (
          previous &&
          previous.enabled === input.enabled &&
          previous.holdEnabled === input.holdEnabled
        ) {
          return { policy: input, changed: false };
        }
        const current = yield* generation;
        yield* sql`INSERT INTO relay_hook_policies (environment_id, hook_id, generation, revision, enabled, hold_enabled)
        VALUES (${input.environmentId}, ${input.hookId}, ${current}, ${NodeCrypto.randomUUID()}, ${input.enabled ? 1 : 0}, ${input.holdEnabled ? 1 : 0})
        ON CONFLICT(environment_id, hook_id) DO UPDATE SET generation = excluded.generation,
          revision = excluded.revision, enabled = excluded.enabled, hold_enabled = excluded.hold_enabled`;
        return { policy: input, changed: true };
      }),
      (result) => {
        if (result.changed)
          abortHooks(
            (target) =>
              target.environmentId === input.environmentId && target.hookId === input.hookId,
          );
      },
    ).pipe(Effect.map((result) => result.policy));
  });
  const getHookPolicy = Effect.fn("RelayRuntime.getHookPolicy")(function* (
    credential: string,
    input: RelayHookTarget,
  ) {
    if (!isHookTarget(input)) return yield* new RelayInputError();
    input = { environmentId: input.environmentId, hookId: input.hookId };
    return yield* transaction(
      Effect.gen(function* () {
        yield* requireAccess(yield* principalFor(credential), {
          kind: "exposure.write",
          environmentId: input.environmentId,
        });
        const policy = yield* readHookPolicy(input);
        return policy
          ? {
              environmentId: policy.environmentId,
              hookId: policy.hookId,
              enabled: policy.enabled,
              holdEnabled: policy.holdEnabled,
            }
          : null;
      }),
    );
  });
  const authorizeHook = Effect.fn("RelayRuntime.authorizeHook")(function* (input: RelayHookTarget) {
    if (!isHookTarget(input)) return yield* new RelayInputError();
    input = { environmentId: input.environmentId, hookId: input.hookId };
    // @effect-diagnostics-next-line abortControllerInEffect:off -- Policy revocation must end an exchange before its caller scope closes.
    const controller = new AbortController();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        hookStreams.delete(controller);
        controller.abort();
      }),
    );
    return yield* transaction(
      Effect.gen(function* () {
        const policy = yield* readHookPolicy(input);
        return policy?.enabled && !controller.signal.aborted
          ? {
              holdEnabled: policy.holdEnabled,
              revision: policy.revision,
              signal: controller.signal,
            }
          : null;
      }),
      (result) => {
        if (result && !closed && !controller.signal.aborted) hookStreams.set(controller, input);
        else controller.abort();
      },
    );
  });

  const authorizeLive = Effect.fn("RelayRuntime.authorizeLive")(function* (
    credential: string,
    operation: LiveOperation,
  ) {
    if (
      operation.kind !== "forward" &&
      operation.kind !== "environment.publish" &&
      operation.kind !== "environment.tunnel"
    ) {
      return yield* new RelayInputError();
    }
    // @effect-diagnostics-next-line abortControllerInEffect:off -- Durable revocation may end the resource before its caller scope closes.
    const controller = new AbortController();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        streams.delete(controller);
        controller.abort();
      }),
    );
    yield* transaction(
      Effect.gen(function* () {
        const principal = yield* principalFor(credential);
        yield* requireAccess(principal, operation);
        const [row] =
          yield* sql`SELECT 1 FROM relay_environments WHERE environment_id = ${operation.environmentId}`;
        if (!row || controller.signal.aborted) return yield* new RelayAccessDeniedError();
        return { grantId: principal.grant.grantId, environmentId: operation.environmentId };
      }),
      (stream) => {
        if (!closed && !controller.signal.aborted) streams.set(controller, stream);
        else controller.abort();
      },
    );
    return controller.signal;
  });

  const localStatus = Effect.fn("RelayRuntime.localStatus")(function* () {
    return yield* transaction(
      Effect.gen(function* () {
        const current = yield* generation;
        return {
          version: 1,
          relayId,
          state: current ? "ready" : "uninitialized",
          schemaVersion,
          storage: writerSettings,
        } satisfies LocalStatus;
      }),
    );
  });

  const status = Effect.fn("RelayRuntime.status")(function* (
    credential: string,
    environmentId?: EnvironmentId,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const principal = yield* principalFor(credential);
        const environments = yield* listEnvironments(principal, "status.read", environmentId);
        return {
          version: 1,
          relayId,
          state: "ready",
          environments,
        } satisfies SelfHostedRelayRuntimeStatus;
      }),
    );
  });

  const discoverEnvironments = Effect.fn("RelayRuntime.discoverEnvironments")(function* (
    credential: string,
    environmentId?: EnvironmentId,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const principal = yield* principalFor(credential);
        return yield* listEnvironments(principal, "discovery.read", environmentId);
      }),
    );
  });

  const validateGrants = Effect.fn("RelayRuntime.validateGrants")(function* (current: number) {
    const rows = yield* sql<GrantRow>`SELECT * FROM relay_grants`;
    const entries = yield* Effect.forEach(rows, (row) =>
      Effect.map(decodeGrant(row), (grant) => [row.grant_id, { row, grant }] as const),
    );
    const indexed = new Map(entries);
    const roots = new Set<number>();
    for (const { row, grant } of indexed.values()) {
      const hasPairing = row.pairing_hash !== null;
      const hasSession = row.session_hash !== null;
      if (
        row.generation > current ||
        (row.revoked === 0
          ? row.generation !== current || hasPairing === hasSession
          : hasPairing || hasSession) ||
        (hasPairing && !Number.isSafeInteger(row.expires_at))
      ) {
        return yield* invalidState();
      }
      if (row.parent_grant_id === null) {
        if (
          roots.has(row.generation) ||
          (row.revoked === 0) !== (row.generation === current) ||
          grant.subject.kind !== "operator" ||
          grant.scope.environments.kind !== "all"
        ) {
          return yield* invalidState();
        }
        roots.add(row.generation);
        continue;
      }
      const parent = indexed.get(row.parent_grant_id);
      if (
        !parent ||
        parent.row.generation !== row.generation ||
        (row.revoked === 0 && (parent.row.revoked !== 0 || parent.row.session_hash === null))
      ) {
        return yield* invalidState();
      }
      const principal = { kind: "relay", grant: parent.grant } as const;
      if (
        !allowsRelayAccess(relayId, principal, { kind: "access.manage", grant }) &&
        !allowsRelayAccess(relayId, principal, { kind: "access.delegate", grant })
      ) {
        return yield* invalidState();
      }
    }
    if (roots.size !== current) return yield* invalidState();

    const deviceIssuers = new Map<string, string>();
    const checked = new Set<string>();
    for (const { row } of indexed.values()) {
      const path = new Map<string, GrantRow>();
      let ancestor: GrantRow | undefined = row;
      while (ancestor && !checked.has(ancestor.grant_id)) {
        if (path.has(ancestor.grant_id)) return yield* invalidState();
        path.set(ancestor.grant_id, ancestor);
        ancestor =
          ancestor.parent_grant_id === null
            ? undefined
            : indexed.get(ancestor.parent_grant_id)?.row;
      }
      for (const child of [...path.values()].reverse()) {
        checked.add(child.grant_id);
        if (child.subject_kind === "device" && child.parent_grant_id !== null) {
          const issuer = deviceIssuers.get(child.parent_grant_id) ?? child.parent_grant_id;
          deviceIssuers.set(child.grant_id, issuer);
        }
      }
    }
    return { indexed, deviceIssuers };
  });

  yield* transaction(
    Effect.gen(function* () {
      const current = yield* generation;
      const { indexed, deviceIssuers } = yield* validateGrants(current);
      const devices = new Map<SelfHostedRelayDeviceId, string>();

      const environments = yield* sql<EnvironmentRow>`SELECT * FROM relay_environments`;
      yield* Effect.forEach(environments, readEnvironment, { discard: true });
      for (const row of yield* sql<DeviceRow>`SELECT * FROM relay_devices`) {
        if (row.entitlement_json !== null) yield* readEntitlement(row.device_id, row);
        if (row.registration_json !== null) yield* readRegistration(row);
        if (row.binding_grant_id === null) continue;
        const binding = indexed.get(row.binding_grant_id);
        const issuer = deviceIssuers.get(row.binding_grant_id);
        if (binding?.grant.subject.kind === "operator" && binding.row.parent_grant_id === null) {
          devices.set(row.device_id, binding.row.grant_id);
          continue;
        }
        if (
          binding?.grant.subject.kind !== "device" ||
          binding.grant.subject.deviceId !== row.device_id ||
          (binding.row.revoked === 0 && binding.row.session_hash === null) ||
          issuer === undefined ||
          binding.row.parent_grant_id !== issuer
        ) {
          return yield* invalidState();
        }
        devices.set(row.device_id, issuer);
      }
      for (const { row, grant } of indexed.values()) {
        if (grant.subject.kind === "device" && row.revoked === 0 && row.session_hash !== null) {
          const issuer = devices.get(grant.subject.deviceId);
          if (issuer === undefined || issuer !== deviceIssuers.get(row.grant_id)) {
            return yield* invalidState();
          }
        }
      }
    }),
  );

  return RelayRuntime.of({
    localStatus,
    bootstrapOwner: Effect.fn("RelayRuntime.bootstrapOwner")(() => ownerSession("owner.bootstrap")),
    recoverOwner: Effect.fn("RelayRuntime.recoverOwner")(() => ownerSession("owner.recover")),
    authenticate: Effect.fn("RelayRuntime.authenticate")((credential) =>
      transaction(principalFor(credential)),
    ),
    status,
    issuePairing,
    redeemPairing,
    revokePairing: Effect.fn("RelayRuntime.revokePairing")((credential, pairingId) =>
      revokeGrant(credential, pairingId, "pairing"),
    ),
    revokeSession: Effect.fn("RelayRuntime.revokeSession")((credential, sessionId) =>
      revokeGrant(credential, sessionId, "session"),
    ),
    discoverEnvironments,
    enrollEnvironment,
    revokeEnvironment,
    registerDevice,
    getDeviceRegistration,
    setDeviceEntitlement,
    revokeDevice,
    authorizeLive,
    setHookPolicy,
    getHookPolicy,
    authorizeHook,
  });
});

export const relayRuntimeLayer = (options: RelayRuntimeOptions) =>
  Layer.effect(RelayRuntime, make(options)).pipe(
    Layer.provideMerge(Store.layer(options.homeDirectory)),
  );
