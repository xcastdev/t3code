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

const ManagedProjectMcpUrl = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(PROJECT_MCP_URL_MAX_LENGTH),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username === "" &&
        url.password === "" &&
        url.search === ""
      );
    } catch {
      return false;
    }
  }),
);

export const ProjectMcpManagedServer = Schema.Struct({
  id: McpServerId,
  name: TrimmedNonEmptyString,
  url: ManagedProjectMcpUrl,
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

export class ProjectMcpProviderNotFoundError extends Schema.TaggedErrorClass<ProjectMcpProviderNotFoundError>()(
  "ProjectMcpProviderNotFoundError",
  { providerInstanceId: ProviderInstanceId },
) {
  override get message(): string {
    return `Provider instance '${this.providerInstanceId}' is not configured in this environment.`;
  }
}

export class ProjectMcpServerLimitExceededError extends Schema.TaggedErrorClass<ProjectMcpServerLimitExceededError>()(
  "ProjectMcpServerLimitExceededError",
  { limit: Schema.Int },
) {
  override get message(): string {
    return `This project cannot contain more than ${this.limit} MCP servers.`;
  }
}

export class ProjectMcpServerNotFoundError extends Schema.TaggedErrorClass<ProjectMcpServerNotFoundError>()(
  "ProjectMcpServerNotFoundError",
  { id: McpServerId },
) {
  override get message(): string {
    return `This project does not contain MCP server '${this.id}'.`;
  }
}

export const ProjectMcpCreateError = Schema.Union([
  ProjectMcpNameConflictError,
  ProjectMcpProviderNotFoundError,
  ProjectMcpServerLimitExceededError,
]);
export type ProjectMcpCreateError = typeof ProjectMcpCreateError.Type;

export const ProjectMcpUpdateError = Schema.Union([
  ProjectMcpNameConflictError,
  ProjectMcpProviderNotFoundError,
  ProjectMcpServerNotFoundError,
]);
export type ProjectMcpUpdateError = typeof ProjectMcpUpdateError.Type;

export const ProjectMcpRemoveError = ProjectMcpServerNotFoundError;
export type ProjectMcpRemoveError = typeof ProjectMcpRemoveError.Type;

export const ProjectMcpMutationError = Schema.Union([
  ProjectMcpNameConflictError,
  ProjectMcpProviderNotFoundError,
  ProjectMcpServerLimitExceededError,
  ProjectMcpServerNotFoundError,
]);
export type ProjectMcpMutationError = typeof ProjectMcpMutationError.Type;

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
