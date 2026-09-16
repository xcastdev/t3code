import type { EnvironmentId } from "@t3tools/contracts";

import { createAtomCommandScheduler, type AtomCommandConcurrency } from "./runtime.ts";
import { normalizeVcsRepositoryRoot } from "./vcsRefInvalidation.ts";

export const vcsCommandScheduler = createAtomCommandScheduler();

export const vcsCommandConcurrency: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
}> = {
  mode: "serial",
  key: ({ environmentId, input }) =>
    JSON.stringify([environmentId, normalizeVcsRepositoryRoot(input.cwd)]),
};
