import { createProjectWorkEnvironmentAtoms } from "@t3tools/client-runtime/project-work";
import { connectionAtomRuntime } from "../../connection/runtime";

export const mobileWorkEnvironment = createProjectWorkEnvironmentAtoms(connectionAtomRuntime);
