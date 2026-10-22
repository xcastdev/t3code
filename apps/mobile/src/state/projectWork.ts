import { createProjectWorkEnvironmentAtoms } from "@t3tools/client-runtime/state/project-work";

import { connectionAtomRuntime } from "../connection/runtime";

export const projectWorkEnvironment = createProjectWorkEnvironmentAtoms(connectionAtomRuntime);
