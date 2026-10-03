// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import {
  type ProviderDriverKind,
  ProviderInstanceId,
  ManagedSkillKey,
  SkillCatalogRevision,
  ThreadId,
  TrimmedNonEmptyString,
  type SkillNativeDiscoveryResult,
  type SkillNativeObservation,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { materializeCodexManagedSkills } from "../provider/Drivers/CodexSkillMaterializer.ts";
import { materializeClaudeManagedPlugin } from "../provider/Drivers/ClaudeSkillMaterializer.ts";
import type { NativeSkillCandidate } from "./NativeSkillObservationService.ts";
import {
  ProviderSkillAdapterError,
  type ProviderSkillAdapter,
  type ProviderSkillPlan,
  type ProviderSkillPrepareRequest,
} from "./ProviderSkillAdapter.ts";
import {
  SkillMaterializationService,
  withSkillMaterializationCleanup,
  type SkillMaterializationServiceShape,
} from "./SkillMaterializationService.ts";
import { SKILL_BODY_FILE } from "./SkillPackage.ts";

type CandidateDiscovery = (
  cwd: string,
) => Effect.Effect<ReadonlyArray<NativeSkillCandidate>, object>;

const adapterError = (code: string, detail: string, cause?: unknown) =>
  new ProviderSkillAdapterError({ code, detail, ...(cause === undefined ? {} : { cause }) });

const observationId = (instanceId: ProviderInstanceId, identity: string) =>
  `native-skill-${NodeCrypto.createHash("sha256").update(instanceId).update("\0").update(identity).digest("hex")}` as SkillNativeObservation["observationId"];

const discover = (
  providerInstanceId: ProviderInstanceId,
  cwd: string,
  source: CandidateDiscovery,
) =>
  Effect.gen(function* () {
    const attemptedAt = DateTime.formatIso(yield* DateTime.now);
    const candidates = yield* source(cwd).pipe(
      Effect.mapError((cause) =>
        adapterError("native_discovery_failed", "Native skill discovery failed.", cause),
      ),
    );
    const observations = candidates.map((candidate): SkillNativeObservation => ({
      observationId: observationId(providerInstanceId, candidate.nativeIdentity),
      providerInstanceId,
      nativeIdentity: candidate.nativeIdentity,
      ...(candidate.contentAccess === undefined ? {} : { contentAccess: candidate.contentAccess }),
      key: candidate.key,
      displayName: candidate.displayName,
      source: candidate.source,
      scopeSummary: candidate.scopeSummary,
      ...(candidate.providerEnabled === undefined
        ? {}
        : { providerEnabled: candidate.providerEnabled }),
      ...(candidate.modelAvailable === undefined
        ? {}
        : { modelAvailable: candidate.modelAvailable }),
      ...(candidate.userInvocable === undefined ? {} : { userInvocable: candidate.userInvocable }),
      freshness: "fresh",
      observedAt: attemptedAt,
      attemptedAt,
    }));
    return {
      providerInstanceId,
      freshness: "fresh",
      attemptedAt,
      observations,
    } satisfies SkillNativeDiscoveryResult;
  });

const supportedCompatibility = (providerInstanceId: ProviderInstanceId) => ({
  providerInstanceId,
  support: "supported" as const,
  applicationMode: "new_session_required" as const,
  reasons: [],
});

export function makeClaudeSkillAdapter(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly discoverCandidates: CandidateDiscovery;
  readonly materialization: SkillMaterializationServiceShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): ProviderSkillAdapter {
  return {
    discoverNative: (cwd) => discover(input.providerInstanceId, cwd, input.discoverCandidates),
    evaluateCompatibility: () => ({
      ...supportedCompatibility(input.providerInstanceId),
      support: "supported_with_limitations",
      reasons: [
        {
          code: "native_source_introspection_partial",
          message:
            "Managed invocations use the t3-managed plugin namespace. Native discovery covers user and repository skills; installed plugins, enterprise sources, and runtime-added directories are not enumerated by the static scanner.",
        },
      ],
    }),
    prepareSession: (request) =>
      Effect.gen(function* () {
        yield* input
          .discoverCandidates(request.runtime.cwd)
          .pipe(
            Effect.mapError((cause) =>
              adapterError(
                "native_discovery_failed",
                "Could not verify native skill collisions.",
                cause,
              ),
            ),
          );
        const payload = yield* materializeClaudeManagedPlugin({
          sessionId: request.runtime.sessionId,
          providerInstanceId: input.providerInstanceId,
          desiredRevision: request.desiredRevision,
          packages: request.skills.map((skill) => ({
            key: skill.key,
            sourcePath: skill.packagePath,
          })),
          // Static discovery is advisory: providers can have plugin, enterprise,
          // or runtime-added sources that are not visible to the scanner. Every
          // managed bare key must therefore be disabled in the session override
          // so a qualified T3 invocation cannot lose to an unseen native skill.
          collidingNativeKeys: [...new Set(request.skills.map((skill) => skill.key))],
        }).pipe(
          Effect.provideService(SkillMaterializationService, input.materialization),
          Effect.provideService(FileSystem.FileSystem, input.fileSystem),
          Effect.provideService(Path.Path, input.path),
        );
        return {
          providerInstanceId: input.providerInstanceId,
          desiredRevision: request.desiredRevision,
          applicationMode: "new_session_required",
          skillKeys: request.skills.map((skill) => skill.key),
          payload,
        } satisfies ProviderSkillPlan;
      }),
    disposeSession: (runtime) =>
      input.materialization
        .disposeSession({
          sessionId: runtime.sessionId,
          providerInstanceId: input.providerInstanceId,
        })
        .pipe(Effect.mapError((cause) => adapterError("cleanup_failed", cause.detail, cause))),
  };
}

export function makeCodexSkillAdapter(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly discoverCandidates: CandidateDiscovery;
  readonly materialization: SkillMaterializationServiceShape;
}): ProviderSkillAdapter {
  return {
    discoverNative: (cwd) => discover(input.providerInstanceId, cwd, input.discoverCandidates),
    evaluateCompatibility: () => supportedCompatibility(input.providerInstanceId),
    prepareSession: (request) =>
      materializeCodexManagedSkills({
        materialization: input.materialization,
        materializationInput: {
          sessionId: request.runtime.sessionId,
          providerInstanceId: input.providerInstanceId,
          desiredRevision: request.desiredRevision,
          packages: request.skills.map((skill) => ({
            key: skill.key,
            sourcePath: skill.packagePath,
          })),
        },
      }).pipe(
        Effect.map((materialized) => {
          return {
            providerInstanceId: input.providerInstanceId,
            desiredRevision: request.desiredRevision,
            applicationMode: "new_session_required",
            skillKeys: request.skills.map((skill) => skill.key),
            payload: {
              kind: "codex-managed-skills",
              extraRoot: materialized.root,
              skills: [...materialized.skillPaths].map(([key, packagePath]) => ({
                key,
                path: `${packagePath}/${SKILL_BODY_FILE}`,
              })),
            },
          } satisfies ProviderSkillPlan;
        }),
      ),
    disposeSession: (runtime) =>
      input.materialization
        .disposeSession({
          sessionId: runtime.sessionId,
          providerInstanceId: input.providerInstanceId,
        })
        .pipe(Effect.mapError((cause) => adapterError("cleanup_failed", cause.detail, cause))),
  };
}

export interface PiManagedSkillsPayload {
  readonly kind: "pi-managed-skills";
  readonly root: string;
  readonly skills: ReadonlyArray<{ readonly key: ManagedSkillKey; readonly path: string }>;
}

export type PiManagedSkillAuthorization = (
  request: ProviderSkillPrepareRequest,
) => Effect.Effect<ReadonlySet<ManagedSkillKey>, ProviderSkillAdapterError>;

const PiRuntimeIdentity = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  sessionId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)),
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
});
const PiSkillPrepareRequest = Schema.Struct({
  runtime: PiRuntimeIdentity,
  desiredRevision: SkillCatalogRevision,
  skills: Schema.Array(Schema.Struct({ key: ManagedSkillKey, packagePath: TrimmedNonEmptyString })),
});
const decodePiRequest = Schema.decodeUnknownEffect(PiSkillPrepareRequest);
const decodePiRuntime = Schema.decodeUnknownEffect(PiRuntimeIdentity);
const PiOwnershipMarker = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.String,
  providerInstanceId: ProviderInstanceId,
  desiredRevision: SkillCatalogRevision,
});
const decodePiOwnershipMarker = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PiOwnershipMarker),
);
const decodePiAllowedKeys = Schema.decodeUnknownEffect(
  Schema.ReadonlySet(ManagedSkillKey).check(Schema.isMaxSize(32)),
);

// Custom output has no service collector. Detach it before removal so an async ownership
// receipt cannot authorize deleting a replacement at the public path. The short final
// metadata/marker check and restore have no async gap; recursive removal stays async.
// The fresh 0700 cleanup directory is private to this preparation, not an adversarial
// cross-process filesystem boundary. A foreign detached entry is restored or retained.
const cleanupPiCustomRoot = async (owned: {
  readonly root: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly marker: string;
}) => {
  const markerName = ".t3-owned.json";
  const markerBytes = Buffer.from(owned.marker);
  if (markerBytes.length > 64 * 1024) throw new Error("Ownership marker exceeds cleanup bound.");
  const matches = async (root: string) => {
    const info = await NodeFSP.lstat(root, { bigint: true });
    const markerPath = NodePath.join(root, markerName);
    const markerInfo = await NodeFSP.lstat(markerPath);
    return (
      info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.dev === owned.dev &&
      info.ino === owned.ino &&
      markerInfo.isFile() &&
      !markerInfo.isSymbolicLink() &&
      (await NodeFSP.readFile(markerPath, "utf8")) === owned.marker
    );
  };
  const matchesNow = (root: string) => {
    let descriptor: number | undefined;
    try {
      const info = NodeFS.lstatSync(root, { bigint: true });
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.dev !== owned.dev ||
        info.ino !== owned.ino
      )
        return false;
      descriptor = NodeFS.openSync(
        NodePath.join(root, markerName),
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
      );
      const markerInfo = NodeFS.fstatSync(descriptor);
      if (!markerInfo.isFile() || markerInfo.size !== markerBytes.length) return false;
      const bytes = Buffer.alloc(markerBytes.length + 1);
      const count = NodeFS.readSync(descriptor, bytes, 0, bytes.length, 0);
      return count === markerBytes.length && bytes.subarray(0, count).equals(markerBytes);
    } catch {
      return false;
    } finally {
      if (descriptor !== undefined) NodeFS.closeSync(descriptor);
    }
  };
  if (!(await matches(owned.root))) return;
  const container = await NodeFSP.mkdtemp(
    NodePath.join(NodePath.dirname(owned.root), ".t3-pi-cleanup-"),
  );
  const detached = NodePath.join(container, "root");
  let failure: unknown;
  try {
    await NodeFSP.chmod(container, 0o700);
    // Inspect the detached path even if a completed rename receipt reports failure.
    let renameFailure: unknown;
    try {
      await NodeFSP.rename(owned.root, detached);
    } catch (cause) {
      renameFailure = cause;
    }
    let verified = false;
    try {
      verified = await matches(detached);
    } catch {}
    if (verified && matchesNow(detached)) {
      await NodeFSP.rm(detached, { recursive: true });
    } else {
      let present = false;
      try {
        NodeFS.lstatSync(detached);
        present = true;
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
      }
      if (present) {
        let occupied = true;
        try {
          NodeFS.lstatSync(owned.root);
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
            occupied = false;
          } else {
            throw cause;
          }
        }
        if (occupied) {
          throw new Error(
            `Foreign cleanup output retained at ${detached}; original path occupied at ${owned.root}.`,
          );
        }
        NodeFS.renameSync(detached, owned.root);
      }
      if (!present && renameFailure !== undefined) throw renameFailure;
    }
  } catch (cause) {
    failure = cause;
  } finally {
    // Never recursively remove a container that might retain a foreign entry.
    try {
      await NodeFSP.rmdir(container);
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOTEMPTY"))
        failure ??= cause;
    }
  }
  if (failure !== undefined) throw failure;
};

/** The runtime must authorize the current managed binding and frozen role/configuration. */
export function makePiSkillAdapter(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly discoverCandidates: CandidateDiscovery;
  readonly materialization: SkillMaterializationServiceShape;
  readonly authorizeManagedRequest: PiManagedSkillAuthorization;
}): ProviderSkillAdapter {
  const authorize = Effect.fn("PiSkillAdapter.authorize")(function* (
    request: ProviderSkillPrepareRequest,
  ) {
    if (typeof input.authorizeManagedRequest !== "function") {
      return yield* adapterError(
        "managed_authorization_required",
        "Pi skill delivery requires managed run authorization.",
      );
    }
    const allowed = yield* input.authorizeManagedRequest(request);
    const keys = yield* decodePiAllowedKeys(allowed).pipe(
      Effect.mapError((cause) =>
        adapterError(
          "managed_authorization_invalid",
          "Managed skill authorization returned invalid keys.",
          cause,
        ),
      ),
    );
    const candidates = new Set(request.skills.map((skill) => skill.key));
    if ([...keys].some((key) => !candidates.has(key))) {
      return yield* adapterError(
        "managed_skill_not_allowed",
        "An authorized skill is missing from the managed catalogue candidates.",
      );
    }
    // A callback may retain and mutate its Set while materialization is in flight.
    return new Set(keys);
  });

  return {
    discoverNative: (cwd) => discover(input.providerInstanceId, cwd, input.discoverCandidates),
    evaluateCompatibility: () => ({
      ...supportedCompatibility(input.providerInstanceId),
      support: "supported_with_limitations",
      reasons: [
        {
          code: "managed-team-runs-only",
          message:
            "Pi skill delivery requires a current managed team run and an explicit resource loader. Skill changes require a new session; native discovery is advisory.",
        },
      ],
    }),
    prepareSession: Effect.fn("PiSkillAdapter.prepareSession")(function* (request) {
      const prepared = yield* decodePiRequest(request).pipe(
        Effect.mapError((cause) =>
          adapterError(
            "invalid_managed_request",
            "Pi skill runtime identity or selection is invalid.",
            cause,
          ),
        ),
      );
      if (prepared.runtime.providerInstanceId !== input.providerInstanceId) {
        return yield* adapterError(
          "provider_instance_mismatch",
          "The runtime belongs to another provider instance.",
        );
      }
      if (new Set(prepared.skills.map((skill) => skill.key)).size !== prepared.skills.length) {
        return yield* adapterError(
          "duplicate_skill_keys",
          "Pi skill delivery contains duplicate managed keys.",
        );
      }
      // Keep the authorization and copied package selection stable across async boundaries.
      Object.freeze(prepared.runtime);
      for (const skill of prepared.skills) Object.freeze(skill);
      Object.freeze(prepared.skills);
      Object.freeze(prepared);
      const allowed = yield* authorize(prepared);
      const selected = Object.freeze({
        ...prepared,
        skills: Object.freeze(prepared.skills.filter((skill) => allowed.has(skill.key))),
      });
      const materializationInput = {
        sessionId: prepared.runtime.sessionId,
        providerInstanceId: input.providerInstanceId,
        desiredRevision: prepared.desiredRevision,
        packages: selected.skills.map((skill) => ({
          key: skill.key,
          sourcePath: skill.packagePath,
        })),
      };
      let fallbackCleanup: Effect.Effect<void> = Effect.void;
      return yield* withSkillMaterializationCleanup(
        Effect.gen(function* () {
          const materialized = yield* input.materialization
            .materialize(materializationInput)
            .pipe(
              Effect.mapError((cause) =>
                adapterError("materialization_failed", cause.detail, cause),
              ),
            );
          if (
            !NodePath.isAbsolute(materialized.root) ||
            NodePath.resolve(materialized.root) !== materialized.root
          ) {
            return yield* adapterError(
              "invalid_materialization",
              "Pi skill delivery returned paths outside the exact managed selection.",
            );
          }

          // Trusted custom materializers must return their acquired generation with its marker.
          // Pin that returned inode; identity-based dispose may resolve a different completed root.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const pinned = yield* Effect.tryPromise({
                try: async () => {
                  const info = await NodeFSP.lstat(materialized.root, { bigint: true });
                  const markerPath = NodePath.join(materialized.root, ".t3-owned.json");
                  const markerInfo = await NodeFSP.lstat(markerPath);
                  if (
                    !info.isDirectory() ||
                    info.isSymbolicLink() ||
                    !markerInfo.isFile() ||
                    markerInfo.isSymbolicLink()
                  )
                    return undefined;
                  const marker = await NodeFSP.readFile(markerPath, "utf8");
                  const current = await NodeFSP.lstat(materialized.root, { bigint: true });
                  if (info.dev !== current.dev || info.ino !== current.ino) return undefined;
                  return { root: materialized.root, dev: info.dev, ino: info.ino, marker };
                },
                catch: (cause) =>
                  adapterError(
                    "cleanup_failed",
                    "Could not retain materialization ownership.",
                    cause,
                  ),
              }).pipe(Effect.option);
              if (pinned._tag === "Some" && pinned.value !== undefined) {
                const owned = pinned.value;
                const marker = yield* decodePiOwnershipMarker(owned.marker).pipe(Effect.option);
                if (
                  marker._tag === "Some" &&
                  marker.value.sessionId === materializationInput.sessionId &&
                  marker.value.providerInstanceId === materializationInput.providerInstanceId &&
                  marker.value.desiredRevision === materializationInput.desiredRevision
                ) {
                  fallbackCleanup = Effect.tryPromise({
                    try: () => cleanupPiCustomRoot(owned),
                    catch: (cause) =>
                      adapterError(
                        "cleanup_failed",
                        "Could not verify materialization ownership.",
                        cause,
                      ),
                  }).pipe(
                    Effect.tapError((cause) => Effect.logWarning(cause)),
                    Effect.ignore,
                  );
                }
              }
            }),
          );
          // Pin custom owned output before rejecting its map so failed preparation cleans it.
          if (
            materialized.skillPaths.size !== selected.skills.length ||
            selected.skills.some(
              (skill) =>
                materialized.skillPaths.get(skill.key) !==
                NodePath.join(materialized.root, skill.key),
            )
          ) {
            return yield* adapterError(
              "invalid_materialization",
              "Pi skill delivery returned paths outside the exact managed selection.",
            );
          }
          // Copying can outlast a lease or role revocation; do not return a stale plan.
          const currentAllowed = yield* authorize(prepared);
          if (
            currentAllowed.size !== allowed.size ||
            [...allowed].some((key) => !currentAllowed.has(key))
          ) {
            return yield* adapterError(
              "managed_skill_not_allowed",
              "The managed run's frozen skill selection changed during copying.",
            );
          }
          const payload: PiManagedSkillsPayload = {
            kind: "pi-managed-skills",
            root: materialized.root,
            skills: selected.skills.map((skill) => ({
              key: skill.key,
              path: NodePath.join(materialized.root, skill.key, SKILL_BODY_FILE),
            })),
          };
          return {
            providerInstanceId: input.providerInstanceId,
            desiredRevision: prepared.desiredRevision,
            applicationMode: "new_session_required",
            skillKeys: selected.skills.map((skill) => skill.key),
            payload,
          } satisfies ProviderSkillPlan;
        }),
        Effect.suspend(() => fallbackCleanup),
      );
    }),
    disposeSession: Effect.fn("PiSkillAdapter.disposeSession")(function* (runtime) {
      const validated = yield* decodePiRuntime(runtime).pipe(
        Effect.mapError((cause) =>
          adapterError("invalid_managed_request", "Pi skill runtime identity is invalid.", cause),
        ),
      );
      if (validated.providerInstanceId !== input.providerInstanceId) {
        return yield* adapterError(
          "provider_instance_mismatch",
          "The runtime belongs to another provider instance.",
        );
      }
      yield* input.materialization
        .disposeSession({
          sessionId: validated.sessionId,
          providerInstanceId: input.providerInstanceId,
        })
        .pipe(Effect.mapError((cause) => adapterError("cleanup_failed", cause.detail, cause)));
    }),
  };
}

export function makeOpenCodeSkillAdapter(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly discoverCandidates: CandidateDiscovery;
  readonly materialization: SkillMaterializationServiceShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly external: boolean;
  readonly customConfigDir: boolean;
}): ProviderSkillAdapter {
  return {
    discoverNative: (cwd) => discover(input.providerInstanceId, cwd, input.discoverCandidates),
    evaluateCompatibility: () =>
      input.external || input.customConfigDir
        ? {
            providerInstanceId: input.providerInstanceId,
            support: "unsupported",
            applicationMode: "unsupported",
            reasons: [
              {
                code: input.external
                  ? "external_skill_delivery_unavailable"
                  : "custom_config_directory_conflict",
                message: input.external
                  ? "OpenCode does not expose an isolated skill source for an already running server."
                  : "An existing OPENCODE_CONFIG_DIR prevents isolated managed skill delivery.",
              },
            ],
          }
        : supportedCompatibility(input.providerInstanceId),
    prepareSession: (request) =>
      input.materialization
        .materialize({
          sessionId: request.runtime.sessionId,
          providerInstanceId: input.providerInstanceId,
          desiredRevision: request.desiredRevision,
          packages: request.skills.map((skill) => ({
            key: skill.key,
            sourcePath: skill.packagePath,
          })),
        })
        .pipe(
          Effect.flatMap((materialized) =>
            Effect.gen(function* () {
              const configDir = input.path.join(materialized.root, ".opencode-config");
              const skillRoot = input.path.join(configDir, "skills");
              yield* input.fileSystem.makeDirectory(skillRoot, { recursive: true });
              for (const [key, packagePath] of materialized.skillPaths) {
                yield* input.fileSystem.rename(packagePath, input.path.join(skillRoot, key));
              }
              return {
                providerInstanceId: input.providerInstanceId,
                desiredRevision: request.desiredRevision,
                applicationMode: "new_session_required" as const,
                skillKeys: request.skills.map((skill) => skill.key),
                payload: {
                  kind: "opencode-managed-skills" as const,
                  root: skillRoot,
                  configDir,
                  skillKeys: request.skills.map((skill) => skill.key),
                },
              } satisfies ProviderSkillPlan;
            }),
          ),
          Effect.mapError((cause) => adapterError("materialization_failed", String(cause), cause)),
        ),
    disposeSession: (runtime) =>
      input.materialization
        .disposeSession({
          sessionId: runtime.sessionId,
          providerInstanceId: input.providerInstanceId,
        })
        .pipe(Effect.mapError((cause) => adapterError("cleanup_failed", cause.detail, cause))),
  };
}

const unsupportedReasons: Readonly<
  Record<string, { readonly code: string; readonly message: string }>
> = {
  cursor: {
    code: "session_isolation_unavailable",
    message: "Cursor does not expose a session-specific managed skill root.",
  },
  grok: {
    code: "session_isolation_unavailable",
    message: "Grok does not expose an isolated session skill profile.",
  },
  opencode: {
    code: "filesystem_boundary_unproven",
    message:
      "OpenCode delivery is discovery-only until local and external server boundaries are isolated.",
  },
  antigravity: {
    code: "instance_profile_not_session_local",
    message: "Antigravity's provider profile is shared by sessions.",
  },
};

export function makeDiscoveryOnlySkillAdapter(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly discoverCandidates: CandidateDiscovery;
}): ProviderSkillAdapter {
  const reason = unsupportedReasons[input.driverKind] ?? {
    code: "unsupported_provider",
    message: "This provider supports native discovery only.",
  };
  return {
    discoverNative: (cwd) => discover(input.providerInstanceId, cwd, input.discoverCandidates),
    evaluateCompatibility: () => ({
      providerInstanceId: input.providerInstanceId,
      support: "unsupported",
      applicationMode: "unsupported",
      reasons: [reason],
    }),
    prepareSession: (request) =>
      Effect.succeed({
        providerInstanceId: input.providerInstanceId,
        desiredRevision: request.desiredRevision,
        applicationMode: "unsupported",
        skillKeys: request.skills.map((skill) => skill.key),
        payload: { kind: "discovery-only", driverKind: input.driverKind, reason },
      }),
    disposeSession: () => Effect.void,
  };
}
