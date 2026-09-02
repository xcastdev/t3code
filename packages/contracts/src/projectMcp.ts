import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const PROJECT_MCP_NAME_MAX_LENGTH = 120;
const PROJECT_MCP_URL_MAX_LENGTH = 2048;

export const McpServerId = TrimmedNonEmptyString.pipe(Schema.brand("McpServerId"));
export type McpServerId = typeof McpServerId.Type;

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  hostname === "::1" ||
  /^127(?:\.\d{1,3}){3}$/.test(hostname);

const isProjectMcpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    const isAllowedScheme =
      url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname));
    return isAllowedScheme && url.username === "" && url.password === "" && url.search === "";
  } catch {
    return false;
  }
};

export const ProjectMcpUrl = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(PROJECT_MCP_URL_MAX_LENGTH),
  Schema.makeFilter(isProjectMcpUrl, {
    message: "Expected an HTTPS or loopback HTTP MCP URL",
  }),
);
export type ProjectMcpUrl = typeof ProjectMcpUrl.Type;

export const ProjectMcpApplicationMode = Schema.Literals([
  "active-session",
  "next-session",
  "unsupported",
  "unavailable",
]);
export type ProjectMcpApplicationMode = typeof ProjectMcpApplicationMode.Type;

export const ProjectMcpApplication = Schema.Struct({
  serverId: McpServerId,
  providerInstanceId: ProviderInstanceId,
  mode: ProjectMcpApplicationMode,
});
export type ProjectMcpApplication = typeof ProjectMcpApplication.Type;

export const ProjectMcpServer = Schema.Struct({
  id: McpServerId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_MCP_NAME_MAX_LENGTH)),
  url: ProjectMcpUrl,
  enabled: Schema.Boolean,
  providerInstanceIds: Schema.Array(ProviderInstanceId),
});
export type ProjectMcpServer = typeof ProjectMcpServer.Type;

export type ResolvedProjectMcpServer = Pick<ProjectMcpServer, "id" | "name" | "url">;

export const ProjectMcpManagedServer = Schema.Struct({
  id: McpServerId,
  name: TrimmedNonEmptyString,
  url: ProjectMcpUrl,
  providerInstanceIds: Schema.Array(ProviderInstanceId),
});
export type ProjectMcpManagedServer = typeof ProjectMcpManagedServer.Type;

export const ProjectMcpCatalog = Schema.Struct({
  external: Schema.Array(ProjectMcpServer),
  managed: Schema.Array(ProjectMcpManagedServer),
  applications: Schema.Array(ProjectMcpApplication),
});
export type ProjectMcpCatalog = typeof ProjectMcpCatalog.Type;

export class ProjectMcpNameConflictError extends Schema.TaggedErrorClass<ProjectMcpNameConflictError>()(
  "ProjectMcpNameConflictError",
  {
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_MCP_NAME_MAX_LENGTH)),
    message: TrimmedNonEmptyString,
  },
) {}

export const ProjectMcpCreateInput = Schema.Struct({
  projectId: ProjectId,
  name: ProjectMcpServer.fields.name,
  url: ProjectMcpUrl,
  enabled: Schema.Boolean,
  providerInstanceIds: Schema.Array(ProviderInstanceId),
});
export type ProjectMcpCreateInput = typeof ProjectMcpCreateInput.Type;

export const ProjectMcpUpdateInput = Schema.Struct({
  projectId: ProjectId,
  id: McpServerId,
  name: ProjectMcpServer.fields.name,
  url: ProjectMcpUrl,
  enabled: Schema.Boolean,
  providerInstanceIds: Schema.Array(ProviderInstanceId),
});
export type ProjectMcpUpdateInput = typeof ProjectMcpUpdateInput.Type;

export const ProjectMcpListInput = Schema.Struct({ projectId: ProjectId });
export type ProjectMcpListInput = typeof ProjectMcpListInput.Type;

export const ProjectMcpRemoveInput = Schema.Struct({
  projectId: ProjectId,
  id: McpServerId,
});
export type ProjectMcpRemoveInput = typeof ProjectMcpRemoveInput.Type;
