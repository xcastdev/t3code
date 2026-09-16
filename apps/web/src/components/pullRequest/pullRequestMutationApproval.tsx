import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { createContext, useContext } from "react";

/**
 * Provider writes in a pull-request detail surface all cross the panel's one approval gate.
 * Leaves supply their precise operation; the panel captures the checkout and host snapshot
 * before it lets that operation run.
 */
export type ApprovedPullRequestMutationScope = {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
};

export type PullRequestProviderMutation = {
  readonly description: string;
  readonly execute: (scope: ApprovedPullRequestMutationScope) => Promise<boolean>;
};

export type PullRequestMutationApproval = {
  readonly available: boolean;
  readonly request: (mutation: PullRequestProviderMutation) => Promise<boolean>;
};

export const PullRequestMutationApprovalContext = createContext<PullRequestMutationApproval | null>(
  null,
);

/** A leaf outside the detail panel has no write authority. */
export function usePullRequestMutationApproval(): PullRequestMutationApproval | null {
  return useContext(PullRequestMutationApprovalContext);
}
