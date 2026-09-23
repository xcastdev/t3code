import { createManagedTextResourcesEnvironmentAtoms } from "@t3tools/client-runtime/state/managed-text-resources";

import { connectionAtomRuntime } from "../connection/runtime";

export const managedTextResourcesEnvironment =
  createManagedTextResourcesEnvironmentAtoms(connectionAtomRuntime);
