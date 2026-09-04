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

const PROJECT_MCP_STDIO_COMMAND_MAX_LENGTH = 1024;
const PROJECT_MCP_STDIO_ARGUMENT_MAX_LENGTH = 4096;
const PROJECT_MCP_STDIO_ARGUMENT_LIMIT = 128;
const PROJECT_MCP_ENVIRONMENT_VARIABLE_LIMIT = 64;

const ProjectMcpSecretRef = TrimmedNonEmptyString.pipe(Schema.brand("ProjectMcpSecretRef"));
export type ProjectMcpSecretRef = typeof ProjectMcpSecretRef.Type;

const ProjectMcpEnvironmentVariableName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.makeFilter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value), {
    message: "Expected an environment variable name",
  }),
);

const ProjectMcpStdioArgument = Schema.String.check(
  Schema.isMaxLength(PROJECT_MCP_STDIO_ARGUMENT_MAX_LENGTH),
);

const ProjectMcpStdioCommand = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_MCP_STDIO_COMMAND_MAX_LENGTH),
);

const ProjectMcpStdioEnvironmentVariable = Schema.Struct({
  name: ProjectMcpEnvironmentVariableName,
  secretRef: ProjectMcpSecretRef,
});
export type ProjectMcpStdioEnvironmentVariable = typeof ProjectMcpStdioEnvironmentVariable.Type;

const ProjectMcpHeaderName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.makeFilter((value) => /^[!#$%&'*+.^_|~0-9A-Za-z-]+$/.test(value), {
    message: "Expected an HTTP header name",
  }),
);
const ProjectMcpHeader = Schema.Struct({
  name: ProjectMcpHeaderName,
  secretRef: ProjectMcpSecretRef,
});
export type ProjectMcpHeader = typeof ProjectMcpHeader.Type;

export const ProjectMcpTransport = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("streamable-http"),
    url: ProjectMcpUrl,
    headers: Schema.Array(ProjectMcpHeader).check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    type: Schema.Literal("legacy-sse"),
    url: ProjectMcpUrl,
    headers: Schema.Array(ProjectMcpHeader).check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    type: Schema.Literal("stdio"),
    command: ProjectMcpStdioCommand,
    args: Schema.Array(ProjectMcpStdioArgument).check(
      Schema.isMaxLength(PROJECT_MCP_STDIO_ARGUMENT_LIMIT),
    ),
    cwd: Schema.optional(TrimmedNonEmptyString),
    env: Schema.Array(ProjectMcpStdioEnvironmentVariable).check(
      Schema.isMaxLength(PROJECT_MCP_ENVIRONMENT_VARIABLE_LIMIT),
    ),
  }),
]);
export type ProjectMcpTransport = typeof ProjectMcpTransport.Type;

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

const ProjectMcpServerFields = Schema.Struct({
  id: McpServerId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_MCP_NAME_MAX_LENGTH)),
  /** URL-only records are the persisted compatibility shape from the first catalog release. */
  url: Schema.optional(ProjectMcpUrl),
  /** New records declare the transport explicitly. */
  transport: Schema.optional(ProjectMcpTransport),
  enabled: Schema.Boolean,
  providerInstanceIds: Schema.Array(ProviderInstanceId),
});
const hasProjectMcpTransport = (server: {
  readonly url?: ProjectMcpUrl | undefined;
  readonly transport?: ProjectMcpTransport | undefined;
}): boolean => {
  if (server.transport === undefined) return server.url !== undefined;
  return server.url === undefined;
};
export const ProjectMcpServer = ProjectMcpServerFields.check(
  Schema.makeFilter(hasProjectMcpTransport, {
    message: "Expected either a legacy URL or an explicit MCP transport",
  }),
);
export type ProjectMcpServer = typeof ProjectMcpServer.Type;

const ProjectMcpServerDraftFields = Schema.Struct({
  name: ProjectMcpServerFields.fields.name,
  url: Schema.optional(ProjectMcpUrl),
  transport: Schema.optional(ProjectMcpTransport),
  enabled: Schema.Boolean,
  providerInstanceIds: Schema.Array(ProviderInstanceId),
});
const ProjectMcpServerDraft = ProjectMcpServerDraftFields.check(
  Schema.makeFilter(hasProjectMcpTransport, {
    message: "Expected either a legacy URL or an explicit MCP transport",
  }),
);

export const getProjectMcpTransport = (server: ProjectMcpServer): ProjectMcpTransport => {
  if (server.transport !== undefined) return server.transport;
  return { type: "streamable-http", url: server.url!, headers: [] };
};

export interface ResolvedProjectMcpServer {
  readonly id: McpServerId;
  readonly name: string;
  readonly transport: ProjectMcpTransport;
}

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
  ...ProjectMcpServerDraftFields.fields,
}).check(
  Schema.makeFilter((input) => hasProjectMcpTransport(input), {
    message: "Expected either a legacy URL or an explicit MCP transport",
  }),
);
export type ProjectMcpCreateInput = typeof ProjectMcpCreateInput.Type;

export const ProjectMcpUpdateInput = Schema.Struct({
  projectId: ProjectId,
  id: McpServerId,
  ...ProjectMcpServerDraftFields.fields,
}).check(
  Schema.makeFilter((input) => hasProjectMcpTransport(input), {
    message: "Expected either a legacy URL or an explicit MCP transport",
  }),
);
export type ProjectMcpUpdateInput = typeof ProjectMcpUpdateInput.Type;

export const ProjectMcpListInput = Schema.Struct({ projectId: ProjectId });
export type ProjectMcpListInput = typeof ProjectMcpListInput.Type;

export const ProjectMcpRemoveInput = Schema.Struct({
  projectId: ProjectId,
  id: McpServerId,
});
export type ProjectMcpRemoveInput = typeof ProjectMcpRemoveInput.Type;
