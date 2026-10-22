import { createSourceControlWorkspaceAtoms } from "@t3tools/client-runtime/state/source-control-workspace";

import { connectionAtomRuntime } from "../connection/runtime";

export const sourceControlWorkspaceEnvironment =
  createSourceControlWorkspaceAtoms(connectionAtomRuntime);
