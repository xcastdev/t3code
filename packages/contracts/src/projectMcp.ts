import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
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
const PROJECT_MCP_HEADER_LIMIT = 64;
const PROJECT_MCP_CREDENTIAL_NAME_MAX_LENGTH = 120;
const PROJECT_MCP_CREDENTIAL_VALUE_MAX_LENGTH = 16 * 1024;
const PROJECT_MCP_APPLICATION_REASON_MAX_LENGTH = 1_000;
const PROJECT_MCP_OAUTH_AUTHORIZATION_URL_MAX_LENGTH = 4_096;

export const ProjectMcpCredentialId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("ProjectMcpCredentialId"),
);
export type ProjectMcpCredentialId = typeof ProjectMcpCredentialId.Type;

export const ProjectMcpCredentialName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_MCP_CREDENTIAL_NAME_MAX_LENGTH),
);
export type ProjectMcpCredentialName = typeof ProjectMcpCredentialName.Type;

export const ProjectMcpCredentialValue = Schema.String.check(
  Schema.isMaxLength(PROJECT_MCP_CREDENTIAL_VALUE_MAX_LENGTH),
);
export type ProjectMcpCredentialValue = typeof ProjectMcpCredentialValue.Type;

export const ProjectMcpCredentialRef = Schema.Struct({
  id: ProjectMcpCredentialId,
  name: ProjectMcpCredentialName,
});
export type ProjectMcpCredentialRef = typeof ProjectMcpCredentialRef.Type;

export const ProjectMcpCredentialDraft = Schema.Struct({
  id: Schema.optional(ProjectMcpCredentialId),
  name: ProjectMcpCredentialName,
  value: Schema.optional(ProjectMcpCredentialValue),
}).check(
  Schema.makeFilter((credential) => credential.id !== undefined || credential.value !== undefined, {
    message: "Expected a credential value when no retained credential ID is supplied",
  }),
);
export type ProjectMcpCredentialDraft = typeof ProjectMcpCredentialDraft.Type;

export const ProjectMcpEnvironmentVariableName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.makeFilter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value), {
    message: "Expected an environment variable name",
  }),
).pipe(Schema.brand("ProjectMcpEnvironmentVariableName"));
export type ProjectMcpEnvironmentVariableName = typeof ProjectMcpEnvironmentVariableName.Type;

const ProjectMcpStdioArgument = Schema.String.check(
  Schema.isMaxLength(PROJECT_MCP_STDIO_ARGUMENT_MAX_LENGTH),
);

const ProjectMcpStdioCommand = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_MCP_STDIO_COMMAND_MAX_LENGTH),
);

const ProjectMcpStdioEnvironmentVariable = Schema.Struct({
  name: ProjectMcpEnvironmentVariableName,
  credential: ProjectMcpCredentialRef,
});
export type ProjectMcpStdioEnvironmentVariable = typeof ProjectMcpStdioEnvironmentVariable.Type;

const ProjectMcpStdioEnvironmentVariableDraft = Schema.Struct({
  name: ProjectMcpEnvironmentVariableName,
  credential: ProjectMcpCredentialDraft,
});

export const ProjectMcpHeaderName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.makeFilter((value) => /^[!#$%&'*+.^_|~0-9A-Za-z-]+$/.test(value), {
    message: "Expected an HTTP header name",
  }),
).pipe(Schema.brand("ProjectMcpHeaderName"));
export type ProjectMcpHeaderName = typeof ProjectMcpHeaderName.Type;

const ProjectMcpHeader = Schema.Struct({
  name: ProjectMcpHeaderName,
  credential: ProjectMcpCredentialRef,
});
export type ProjectMcpHeader = typeof ProjectMcpHeader.Type;

const ProjectMcpHeaderDraft = Schema.Struct({
  name: ProjectMcpHeaderName,
  credential: ProjectMcpCredentialDraft,
});

const ProjectMcpOAuthRegistration = Schema.Union([
  Schema.Struct({ type: Schema.Literal("automatic") }),
  Schema.Struct({
    type: Schema.Literal("pre-registered"),
    clientId: TrimmedNonEmptyString,
    clientSecret: Schema.optional(ProjectMcpCredentialRef),
  }),
]);

const ProjectMcpOAuthRegistrationDraft = Schema.Union([
  Schema.Struct({ type: Schema.Literal("automatic") }),
  Schema.Struct({
    type: Schema.Literal("pre-registered"),
    clientId: TrimmedNonEmptyString,
    clientSecret: Schema.optional(ProjectMcpCredentialDraft),
  }),
]);

export const ProjectMcpHttpAuthorization = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({ type: Schema.Literal("oauth"), registration: ProjectMcpOAuthRegistration }),
]);
export type ProjectMcpHttpAuthorization = typeof ProjectMcpHttpAuthorization.Type;

const ProjectMcpHttpAuthorizationDraft = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({ type: Schema.Literal("oauth"), registration: ProjectMcpOAuthRegistrationDraft }),
]);

const ProjectMcpHttpAuthorizationDefault = Effect.succeed({ type: "none" } as const);
const ProjectMcpHttpAuthorizationWithDefault = ProjectMcpHttpAuthorization.pipe(
  Schema.withDecodingDefault(ProjectMcpHttpAuthorizationDefault),
);
const ProjectMcpHttpAuthorizationDraftWithDefault = ProjectMcpHttpAuthorizationDraft.pipe(
  Schema.withDecodingDefault(ProjectMcpHttpAuthorizationDefault),
);

const hasDistinctNames = (values: ReadonlyArray<{ readonly name: string }>): boolean =>
  new Set(values.map(({ name }) => name.toLowerCase())).size === values.length;

const hasNoOAuthAuthorizationHeader = (input: {
  readonly authorization: { readonly type: "none" | "oauth" };
  readonly headers: ReadonlyArray<{ readonly name: string }>;
}): boolean =>
  input.authorization.type !== "oauth" ||
  !input.headers.some(({ name }) => name.toLowerCase() === "authorization");

const ProjectMcpHttpTransport = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("streamable-http"),
    url: ProjectMcpUrl,
    headers: Schema.Array(ProjectMcpHeader).check(Schema.isMaxLength(PROJECT_MCP_HEADER_LIMIT)),
    authorization: ProjectMcpHttpAuthorizationWithDefault,
  }).check(
    Schema.makeFilter(
      (transport) =>
        hasDistinctNames(transport.headers) && hasNoOAuthAuthorizationHeader(transport),
      { message: "Expected distinct headers and no Authorization header with OAuth" },
    ),
  ),
  Schema.Struct({
    type: Schema.Literal("legacy-sse"),
    url: ProjectMcpUrl,
    headers: Schema.Array(ProjectMcpHeader).check(Schema.isMaxLength(PROJECT_MCP_HEADER_LIMIT)),
    authorization: ProjectMcpHttpAuthorizationWithDefault,
  }).check(
    Schema.makeFilter(
      (transport) =>
        hasDistinctNames(transport.headers) && hasNoOAuthAuthorizationHeader(transport),
      { message: "Expected distinct headers and no Authorization header with OAuth" },
    ),
  ),
]);

const ProjectMcpHttpTransportDraft = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("streamable-http"),
    url: ProjectMcpUrl,
    headers: Schema.Array(ProjectMcpHeaderDraft).check(
      Schema.isMaxLength(PROJECT_MCP_HEADER_LIMIT),
    ),
    authorization: ProjectMcpHttpAuthorizationDraftWithDefault,
  }).check(
    Schema.makeFilter(
      (transport) =>
        hasDistinctNames(transport.headers) && hasNoOAuthAuthorizationHeader(transport),
      { message: "Expected distinct headers and no Authorization header with OAuth" },
    ),
  ),
  Schema.Struct({
    type: Schema.Literal("legacy-sse"),
    url: ProjectMcpUrl,
    headers: Schema.Array(ProjectMcpHeaderDraft).check(
      Schema.isMaxLength(PROJECT_MCP_HEADER_LIMIT),
    ),
    authorization: ProjectMcpHttpAuthorizationDraftWithDefault,
  }).check(
    Schema.makeFilter(
      (transport) =>
        hasDistinctNames(transport.headers) && hasNoOAuthAuthorizationHeader(transport),
      { message: "Expected distinct headers and no Authorization header with OAuth" },
    ),
  ),
]);

const ProjectMcpStdioTransport = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: ProjectMcpStdioCommand,
  args: Schema.Array(ProjectMcpStdioArgument).check(
    Schema.isMaxLength(PROJECT_MCP_STDIO_ARGUMENT_LIMIT),
  ),
  cwd: Schema.optional(TrimmedNonEmptyString),
  env: Schema.Array(ProjectMcpStdioEnvironmentVariable).check(
    Schema.isMaxLength(PROJECT_MCP_ENVIRONMENT_VARIABLE_LIMIT),
  ),
  authorization: Schema.optional(Schema.Never),
}).check(
  Schema.makeFilter((transport) => hasDistinctNames(transport.env), {
    message: "Expected distinct environment variable names",
  }),
);

const ProjectMcpStdioTransportDraft = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: ProjectMcpStdioCommand,
  args: Schema.Array(ProjectMcpStdioArgument).check(
    Schema.isMaxLength(PROJECT_MCP_STDIO_ARGUMENT_LIMIT),
  ),
  cwd: Schema.optional(TrimmedNonEmptyString),
  env: Schema.Array(ProjectMcpStdioEnvironmentVariableDraft).check(
    Schema.isMaxLength(PROJECT_MCP_ENVIRONMENT_VARIABLE_LIMIT),
  ),
  authorization: Schema.optional(Schema.Never),
}).check(
  Schema.makeFilter((transport) => hasDistinctNames(transport.env), {
    message: "Expected distinct environment variable names",
  }),
);

export const ProjectMcpTransport = Schema.Union([
  ProjectMcpHttpTransport,
  ProjectMcpStdioTransport,
]);
export type ProjectMcpTransport = typeof ProjectMcpTransport.Type;

export const ProjectMcpTransportDraft = Schema.Union([
  ProjectMcpHttpTransportDraft,
  ProjectMcpStdioTransportDraft,
]);
export type ProjectMcpTransportDraft = typeof ProjectMcpTransportDraft.Type;

export const ProjectMcpOAuthStatus = Schema.Literals([
  "not-required",
  "not-connected",
  "authorization-pending",
  "connected",
  "error",
]);
export type ProjectMcpOAuthStatus = typeof ProjectMcpOAuthStatus.Type;

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
  reason: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_MCP_APPLICATION_REASON_MAX_LENGTH)),
  ),
});
export type ProjectMcpApplication = typeof ProjectMcpApplication.Type;

const ProjectMcpServerFields = Schema.Struct({
  id: McpServerId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_MCP_NAME_MAX_LENGTH)),
  /** URL-only records are the persisted compatibility shape from the first catalog release. */
  url: Schema.optional(ProjectMcpUrl),
  /** New records declare the transport explicitly. */
  transport: Schema.optional(ProjectMcpTransport),
  oauthStatus: Schema.optional(ProjectMcpOAuthStatus),
  enabled: Schema.Boolean,
  providerInstanceIds: Schema.Array(ProviderInstanceId),
});
const hasProjectMcpTransport = (server: {
  readonly url?: ProjectMcpUrl | undefined;
  readonly transport?: ProjectMcpTransport | ProjectMcpTransportDraft | undefined;
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
  transport: Schema.optional(ProjectMcpTransportDraft),
  enabled: Schema.Boolean,
  providerInstanceIds: Schema.Array(ProviderInstanceId),
});
const ProjectMcpServerDraft = ProjectMcpServerDraftFields.check(
  Schema.makeFilter(hasProjectMcpTransport, {
    message: "Expected either a legacy URL or an explicit MCP transport",
  }),
);

const hasCredentialValues = (transport: ProjectMcpTransportDraft | undefined): boolean => {
  if (transport === undefined) return true;

  const credentials =
    transport.type === "stdio"
      ? transport.env.map(({ credential }) => credential)
      : [
          ...transport.headers.map(({ credential }) => credential),
          ...(transport.authorization.type === "oauth" &&
          transport.authorization.registration.type === "pre-registered" &&
          transport.authorization.registration.clientSecret !== undefined
            ? [transport.authorization.registration.clientSecret]
            : []),
        ];

  return credentials.every((credential) => credential.value !== undefined);
};

export const getProjectMcpTransport = (server: ProjectMcpServer): ProjectMcpTransport => {
  if (server.transport !== undefined) return server.transport;
  return {
    type: "streamable-http",
    url: server.url!,
    headers: [],
    authorization: { type: "none" },
  };
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
  Schema.makeFilter(
    (input) => hasProjectMcpTransport(input) && hasCredentialValues(input.transport),
    {
      message: "Expected an MCP transport and values for new credentials",
    },
  ),
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

const ProjectMcpOAuthActionInputFields = {
  projectId: ProjectId,
  id: McpServerId,
} as const;

export const ProjectMcpOAuthBeginInput = Schema.Struct({
  ...ProjectMcpOAuthActionInputFields,
  // This intentionally rejects a client-controlled redirect destination.
  redirectUrl: Schema.optional(Schema.Never),
});
export type ProjectMcpOAuthBeginInput = typeof ProjectMcpOAuthBeginInput.Type;

export const ProjectMcpOAuthBeginResult = Schema.Struct({
  authorizationUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_MCP_OAUTH_AUTHORIZATION_URL_MAX_LENGTH),
  ),
  expiresAt: IsoDateTime,
});
export type ProjectMcpOAuthBeginResult = typeof ProjectMcpOAuthBeginResult.Type;

export const ProjectMcpOAuthDisconnectInput = Schema.Struct(ProjectMcpOAuthActionInputFields);
export type ProjectMcpOAuthDisconnectInput = typeof ProjectMcpOAuthDisconnectInput.Type;
