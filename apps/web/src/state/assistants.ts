import { createAssistantsEnvironmentAtoms } from "@t3tools/client-runtime/state/assistants";

import { connectionAtomRuntime } from "../connection/runtime";

export const assistantsEnvironment = createAssistantsEnvironmentAtoms(connectionAtomRuntime);
