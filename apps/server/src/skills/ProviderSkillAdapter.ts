import type {
  ManagedSkillKey,
  ProviderInstanceId,
  SkillApplicationMode,
  SkillCatalogRevision,
  SkillCompatibility,
  SkillNativeDiscoveryResult,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface ProviderSkillDefinition {
  readonly key: ManagedSkillKey;
  readonly packagePath: string;
}

export interface ProviderSkillRuntime {
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly sessionId: string;
  readonly threadId?: string;
}

export interface ProviderSkillPrepareRequest {
  readonly runtime: ProviderSkillRuntime;
  readonly desiredRevision: SkillCatalogRevision;
  readonly skills: ReadonlyArray<ProviderSkillDefinition>;
}

/** Core carries this value but only the owning provider may interpret `payload`. */
export interface ProviderSkillPlan {
  readonly providerInstanceId: ProviderInstanceId;
  readonly desiredRevision: SkillCatalogRevision;
  readonly applicationMode: SkillApplicationMode;
  readonly skillKeys: ReadonlyArray<ManagedSkillKey>;
  readonly payload: unknown;
}

export interface ProviderSkillApplyResult {
  readonly applied: boolean;
  readonly appliedRevision: SkillCatalogRevision;
}

export class ProviderSkillAdapterError extends Schema.TaggedError<ProviderSkillAdapterError>()(
  "ProviderSkillAdapterError",
  {
    code: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProviderSkillAdapter {
  readonly discoverNative: (
    cwd: string,
  ) => Effect.Effect<SkillNativeDiscoveryResult, ProviderSkillAdapterError>;
  readonly evaluateCompatibility: (
    skill: ProviderSkillDefinition,
    runtime: ProviderSkillRuntime,
  ) => SkillCompatibility;
  readonly prepareSession: (
    request: ProviderSkillPrepareRequest,
  ) => Effect.Effect<ProviderSkillPlan, ProviderSkillAdapterError>;
  readonly applyLive?: (
    plan: ProviderSkillPlan,
  ) => Effect.Effect<ProviderSkillApplyResult, ProviderSkillAdapterError>;
  readonly disposeSession: (
    runtime: ProviderSkillRuntime,
  ) => Effect.Effect<void, ProviderSkillAdapterError>;
}
