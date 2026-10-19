import { createProjectWorkEnvironmentAtoms } from "@t3tools/client-runtime/project-work";
import { connectionAtomRuntime } from "../../connection/runtime";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

export const mobileWorkEnvironment = {
  ...createProjectWorkEnvironmentAtoms(connectionAtomRuntime),
  mergePullRequestDetail: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "mobile:work:merge-detail",
    tag: WS_METHODS.pullRequestsDetail,
    staleTimeMs: 0,
  }),
  mergePullRequest: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "mobile:work:merge",
    tag: WS_METHODS.pullRequestsRunAction,
  }),
};
