import { createProjectWorkEnvironmentAtoms } from "@t3tools/client-runtime/project-work";

import { connectionAtomRuntime } from "../connection/runtime";

/** Web and desktop share the same bounded project-work client surface. */
export const projectWorkEnvironment = createProjectWorkEnvironmentAtoms(connectionAtomRuntime);
