import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime);
/**
 * Web-only: project content search backs the ⇧⌘F dialog, which has no mobile
 * surface, so the atom family lives here instead of the shared client-runtime
 * project atoms consumed by the mobile app.
 */
export const projectContentSearch = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:search-contents",
  tag: WS_METHODS.projectsSearchContents,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

/** Project-scoped MCP catalog reads and writes for one connected environment. */
export const projectMcpEnvironment = {
  catalog: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:projects:mcp-catalog",
    tag: WS_METHODS.projectMcpList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  }),
  create: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:projects:mcp-create",
    tag: WS_METHODS.projectMcpCreate,
  }),
  update: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:projects:mcp-update",
    tag: WS_METHODS.projectMcpUpdate,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:projects:mcp-remove",
    tag: WS_METHODS.projectMcpRemove,
  }),
  oauthBegin: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:projects:mcp-oauth-begin",
    tag: WS_METHODS.projectMcpOauthBegin,
  }),
  oauthDisconnect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:projects:mcp-oauth-disconnect",
    tag: WS_METHODS.projectMcpOauthDisconnect,
  }),
};

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
