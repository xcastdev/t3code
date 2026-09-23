// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type SkillNativeDiscoveryResult,
  type SkillNativeObservation,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { materializeCodexManagedSkills } from "../provider/Drivers/CodexSkillMaterializer.ts";
import { materializeClaudeManagedPlugin } from "../provider/Drivers/ClaudeSkillMaterializer.ts";
import type { NativeSkillCandidate } from "./NativeSkillObservationService.ts";
import {
  ProviderSkillAdapterError,
  type ProviderSkillAdapter,
  type ProviderSkillPlan,
} from "./ProviderSkillAdapter.ts";
import {
  SkillMaterializationService,
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
