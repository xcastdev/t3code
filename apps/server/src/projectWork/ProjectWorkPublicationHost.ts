import type {
  ProjectId,
  ProjectTeamIntegrationSource,
  ProjectWorkPublicationOutcome,
  ProjectWorkPublicationRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {
  DeliveryOperation,
  MergeConfirmation,
  PublicationDecision,
  PublicationError,
} from "./ProjectWorkPublicationJournal.ts";

/** Adapter resolves project/workspace and account routing; no transport supplies a cwd or host. */
export class ProjectWorkPublicationHost extends Context.Service<
  ProjectWorkPublicationHost,
  {
    readonly capture: (input: {
      readonly projectId: ProjectId;
      readonly source: ProjectTeamIntegrationSource;
      readonly baseRef: string;
    }) => Effect.Effect<
      {
        readonly cwd: string;
        readonly providerId: string;
        readonly account: PublicationDecision["account"];
        readonly repository: ProjectWorkPublicationRequest["repository"];
        readonly headRepositoryNodeId: string;
        readonly headSelector: string;
        readonly baseRef: string;
      },
      PublicationError
    >;
    readonly assertCurrent: (
      decision: PublicationDecision,
    ) => Effect.Effect<void, PublicationError>;
    readonly create: (
      operation: DeliveryOperation,
      assertHuman: Effect.Effect<void, PublicationError>,
    ) => Effect.Effect<ProjectWorkPublicationOutcome, PublicationError>;
    readonly reconcilePublication: (
      operation: DeliveryOperation,
    ) => Effect.Effect<ProjectWorkPublicationOutcome, PublicationError>;
    readonly supportsExactMerge: (
      operation: DeliveryOperation,
    ) => Effect.Effect<boolean, PublicationError>;
    readonly mergeExact: (
      operation: DeliveryOperation,
      assertHuman: Effect.Effect<void, PublicationError>,
    ) => Effect.Effect<MergeConfirmation, PublicationError>;
    readonly reconcileMerge: (
      operation: DeliveryOperation,
    ) => Effect.Effect<MergeConfirmation | undefined, PublicationError>;
  }
>()("t3/projectWork/ProjectWorkPublicationHost") {}
