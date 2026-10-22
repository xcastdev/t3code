import type { ManagedResourceInventoryRow } from "@t3tools/client-runtime/state/managedResources";
import {
  McpCatalogName,
  ProjectMcpCredentialName,
  ProjectMcpEnvironmentVariableName,
  ProjectMcpHeaderName,
  ProjectMcpUrl,
  SecretRef,
  TrimmedNonEmptyString,
  type EnvironmentId,
  type McpCatalogDefinition,
  type McpCatalogOverride,
  type McpCatalogSnapshot,
  type McpCatalogTransportInput,
  type ProjectMcpCredentialId,
  type ProjectMcpCredentialRef,
  type ProjectId,
  type ProjectMcpTransport,
  type ProviderInstanceId,
  type SkillApplicationSummary,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export {
  describeResourceFailure,
  skillActions,
  skillReloadBaseline,
  skillEntryId,
  skillKeyCollisions,
  textResourceActions,
} from "@t3tools/client-runtime/resource-actions";

/** The one destination a resources view reads and writes; never broadened on failure. */
export interface ResourceSettingsTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  /** The thread's provider, which owns its skill session overlay. */
  readonly providerInstanceId: ProviderInstanceId | null;
}

export function resourceCatalogInput(target: ResourceSettingsTarget) {
  return {
    ...(target.projectId === null ? {} : { projectId: target.projectId }),
    ...(target.threadId === null ? {} : { threadId: target.threadId }),
  };
}

/**
 * A credential is kept as stored, typed as a new value, or (only after the
 * server prepared that value) a one-use reference. A typed value lives in this
 * form until save and is never sent with the catalog write itself.
 */
export type McpCredentialField =
  | { readonly kind: "stored"; readonly name: string; readonly id: ProjectMcpCredentialId }
  | { readonly kind: "new-secret"; readonly name: string; readonly value: string }
  | { readonly kind: "secret-ref"; readonly name: string; readonly secretRef: string };

export interface McpNamedCredential {
  /** Stable row identity while editing; never sent to the server. */
  readonly rowId: string;
  readonly name: string;
  readonly credential: McpCredentialField;
}

export type McpAuthorizationForm =
  | { readonly type: "none" }
  | { readonly type: "oauth-automatic" }
  | {
      readonly type: "oauth-pre-registered";
      readonly clientId: string;
      readonly clientSecret: McpCredentialField | null;
    };

export interface McpServerForm {
  readonly name: string;
  readonly enabled: boolean;
  readonly providerInstanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly transport: "streamable-http" | "legacy-sse" | "stdio";
  readonly url: string;
  readonly headers: ReadonlyArray<McpNamedCredential>;
  readonly authorization: McpAuthorizationForm;
  readonly command: string;
  /** One argument per line, so arguments may contain spaces. */
  readonly args: string;
  readonly cwd: string;
  readonly env: ReadonlyArray<McpNamedCredential>;
}

export const EMPTY_MCP_SERVER_FORM: McpServerForm = {
  name: "",
  enabled: true,
  providerInstanceIds: [],
  transport: "streamable-http",
  url: "",
  headers: [],
  authorization: { type: "none" },
  command: "",
  args: "",
  cwd: "",
  env: [],
};

const stored = (ref: ProjectMcpCredentialRef): McpCredentialField => ({
  kind: "stored",
  name: ref.name,
  id: ref.id,
});

export function mcpFormFromDefinition(
  definition: Pick<McpCatalogDefinition, "name" | "enabled" | "providerInstanceIds"> & {
    readonly transport: ProjectMcpTransport;
  },
): McpServerForm {
  const { transport } = definition;
  const base = {
    ...EMPTY_MCP_SERVER_FORM,
    name: definition.name,
    enabled: definition.enabled,
    providerInstanceIds: definition.providerInstanceIds,
  };
  if (transport.type === "stdio") {
    return {
      ...base,
      transport: "stdio",
      command: transport.command,
      args: transport.args.join("\n"),
      cwd: transport.cwd ?? "",
      env: transport.env.map((entry, index) => ({
        rowId: `env:${index}`,
        name: entry.name,
        credential: stored(entry.credential),
      })),
    };
  }
  const authorization: McpAuthorizationForm =
    transport.authorization.type === "none"
      ? { type: "none" }
      : transport.authorization.registration.type === "automatic"
        ? { type: "oauth-automatic" }
        : {
            type: "oauth-pre-registered",
            clientId: transport.authorization.registration.clientId,
            clientSecret: transport.authorization.registration.clientSecret
              ? stored(transport.authorization.registration.clientSecret)
              : null,
          };
  return {
    ...base,
    transport: transport.type,
    url: transport.url,
    headers: transport.headers.map((entry, index) => ({
      rowId: `header:${index}`,
      name: entry.name,
      credential: stored(entry.credential),
    })),
    authorization,
  };
}

type FormResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

const decodeName = Schema.decodeUnknownOption(McpCatalogName);
const decodeCredentialName = Schema.decodeUnknownOption(ProjectMcpCredentialName);
const decodeHeaderName = Schema.decodeUnknownOption(ProjectMcpHeaderName);
const decodeEnvName = Schema.decodeUnknownOption(ProjectMcpEnvironmentVariableName);
const decodeSecretRef = Schema.decodeUnknownOption(SecretRef);
const decodeNonEmpty = Schema.decodeUnknownOption(TrimmedNonEmptyString);
const decodeUrl = Schema.decodeUnknownOption(ProjectMcpUrl);

function credentialInput(
  field: McpCredentialField,
  label: string,
): FormResult<Extract<McpCatalogTransportInput, { type: "stdio" }>["env"][number]["credential"]> {
  const name = decodeCredentialName(field.name.trim());
  if (name._tag === "None") return { ok: false, error: `${label} needs a credential name.` };
  if (field.kind === "stored") return { ok: true, value: { id: field.id, name: name.value } };
  if (field.kind === "new-secret") return { ok: false, error: `${label} has an unsaved secret.` };
  const secretRef = decodeSecretRef(field.secretRef.trim());
  if (secretRef._tag === "None")
    return { ok: false, error: `${label} needs a secret reference from a saved secret request.` };
  return { ok: true, value: { name: name.value, secretRef: secretRef.value } };
}

/**
 * Builds the catalog write shape. Secret bytes never pass through here:
 * a credential is a stored ID or a one-use reference the server consumes.
 */
export function mcpTransportInputFromForm(
  form: McpServerForm,
): FormResult<McpCatalogTransportInput> {
  if (form.transport === "stdio") {
    const command = decodeNonEmpty(form.command.trim());
    if (command._tag === "None")
      return { ok: false, error: "Enter the command that starts the server." };
    const env = [];
    for (const entry of form.env) {
      const name = decodeEnvName(entry.name.trim());
      if (name._tag === "None")
        return { ok: false, error: `"${entry.name}" isn't a valid environment variable name.` };
      const credential = credentialInput(entry.credential, name.value);
      if (!credential.ok) return credential;
      env.push({ name: name.value, credential: credential.value });
    }
    const cwd = decodeNonEmpty(form.cwd.trim());
    return {
      ok: true,
      value: {
        type: "stdio",
        command: command.value,
        args: form.args.split("\n").filter((arg) => arg.length > 0),
        ...(cwd._tag === "Some" ? { cwd: cwd.value } : {}),
        env,
      },
    };
  }
  const url = decodeUrl(form.url.trim());
  if (url._tag === "None")
    return {
      ok: false,
      error: "Enter an https:// URL without credentials or a query (http:// only for localhost).",
    };
  const headers = [];
  for (const entry of form.headers) {
    const name = decodeHeaderName(entry.name.trim());
    if (name._tag === "None")
      return { ok: false, error: `"${entry.name}" isn't a valid header name.` };
    if (form.authorization.type !== "none" && name.value.toLowerCase() === "authorization")
      return {
        ok: false,
        error: "OAuth sets the Authorization header. Remove the header or OAuth.",
      };
    const credential = credentialInput(entry.credential, name.value);
    if (!credential.ok) return credential;
    headers.push({ name: name.value, credential: credential.value });
  }
  const authorization = (() => {
    switch (form.authorization.type) {
      case "none":
        return { ok: true as const, value: { type: "none" as const } };
      case "oauth-automatic":
        return {
          ok: true as const,
          value: { type: "oauth" as const, registration: { type: "automatic" as const } },
        };
      case "oauth-pre-registered": {
        const clientId = decodeNonEmpty(form.authorization.clientId.trim());
        if (clientId._tag === "None")
          return { ok: false as const, error: "Enter the OAuth client ID." };
        const secret = form.authorization.clientSecret;
        if (secret === null)
          return {
            ok: true as const,
            value: {
              type: "oauth" as const,
              registration: { type: "pre-registered" as const, clientId: clientId.value },
            },
          };
        const clientSecret = credentialInput(secret, "Client secret");
        if (!clientSecret.ok) return clientSecret;
        return {
          ok: true as const,
          value: {
            type: "oauth" as const,
            registration: {
              type: "pre-registered" as const,
              clientId: clientId.value,
              clientSecret: clientSecret.value,
            },
          },
        };
      }
    }
  })();
  if (!authorization.ok) return authorization;
  return {
    ok: true,
    value: {
      type: form.transport,
      url: url.value,
      headers,
      authorization: authorization.value,
    },
  };
}

export function mcpDefinitionInputFromForm(form: McpServerForm) {
  const name = decodeName(form.name.trim());
  if (name._tag === "None")
    return { ok: false as const, error: "Name the server (up to 120 characters)." };
  const transport = mcpTransportInputFromForm(form);
  if (!transport.ok) return transport;
  return {
    ok: true as const,
    value: {
      name: name.value,
      enabled: form.enabled,
      providerInstanceIds: [...form.providerInstanceIds],
      transport: transport.value,
    },
  };
}

export interface McpCatalogRow {
  readonly definition: McpCatalogDefinition;
  /** The destination's override of an inherited definition, if any. */
  readonly override: McpCatalogOverride | null;
  readonly inherited: boolean;
  readonly enabled: boolean;
  readonly name: string;
  readonly providerInstanceIds: ReadonlyArray<ProviderInstanceId>;
  /** The connection this destination uses: its override's, else the definition's. */
  readonly transport: ProjectMcpTransport;
  /** Identifies `transport`; OAuth grants belong to it. */
  readonly transportDefinitionId: McpCatalogDefinition["definitionId"];
}

/**
 * Rows for one destination: inherited definitions with this scope's override
 * applied, then the scope's own definitions. Nothing here resolves delivery.
 */
export function mcpCatalogRows(input: {
  readonly inherited: ReadonlyArray<McpCatalogDefinition>;
  readonly own: ReadonlyArray<McpCatalogDefinition>;
  readonly overrides: ReadonlyArray<McpCatalogOverride>;
}): ReadonlyArray<McpCatalogRow> {
  const overrideFor = (definition: McpCatalogDefinition) =>
    input.overrides.find((override) => override.targetId === definition.logicalServerId) ?? null;
  return [
    ...input.inherited.map((definition) => {
      const override = overrideFor(definition);
      return {
        definition,
        override,
        inherited: true,
        enabled: override?.enabled ?? definition.enabled,
        name: override?.name ?? definition.name,
        providerInstanceIds: override?.providerInstanceIds ?? definition.providerInstanceIds,
        transport: override?.transport ?? definition.transport,
        transportDefinitionId: override?.transportDefinitionId ?? definition.definitionId,
      };
    }),
    ...input.own.map((definition) => ({
      definition,
      override: null,
      inherited: false,
      enabled: definition.enabled,
      name: definition.name,
      providerInstanceIds: definition.providerInstanceIds,
      transport: definition.transport,
      transportDefinitionId: definition.definitionId,
    })),
  ];
}

/** The definitions this destination effectively has, with overrides applied, for read-only views. */
export function effectiveMcpDefinitions(
  rows: ReadonlyArray<McpCatalogRow>,
): ReadonlyArray<McpCatalogDefinition> {
  return rows.map((row) => ({
    ...row.definition,
    name: row.name as McpCatalogDefinition["name"],
    enabled: row.enabled,
    providerInstanceIds: row.providerInstanceIds,
    transport: row.transport,
  }));
}

/** The persisted connection as write input, keeping stored credentials by ID. */
export function mcpTransportInputFromPersisted(
  transport: ProjectMcpTransport,
): FormResult<McpCatalogTransportInput> {
  return mcpTransportInputFromForm(
    mcpFormFromDefinition({ name: "", enabled: true, providerInstanceIds: [], transport }),
  );
}

/**
 * Stored credentials belong to the definition that stored them. A connection
 * copied into an override starts with empty values that must be entered again.
 */
export function withNewCredentialValues(form: McpServerForm): McpServerForm {
  const fresh = (field: McpCredentialField): McpCredentialField =>
    field.kind === "stored" ? { kind: "new-secret", name: field.name, value: "" } : field;
  return {
    ...form,
    headers: form.headers.map((entry) => ({ ...entry, credential: fresh(entry.credential) })),
    env: form.env.map((entry) => ({ ...entry, credential: fresh(entry.credential) })),
    authorization:
      form.authorization.type === "oauth-pre-registered" && form.authorization.clientSecret !== null
        ? { ...form.authorization, clientSecret: fresh(form.authorization.clientSecret) }
        : form.authorization,
  };
}

/**
 * Exchanges each newly typed value for a one-use reference through the
 * protected Settings secret request, in order, before anything is written.
 * The form returned holds references only.
 */
export async function prepareMcpFormSecrets(
  form: McpServerForm,
  prepare: (value: string) => Promise<string | null>,
): Promise<FormResult<McpServerForm>> {
  const swap = async (
    field: McpCredentialField,
    label: string,
  ): Promise<FormResult<McpCredentialField>> => {
    if (field.kind !== "new-secret") return { ok: true, value: field };
    if (field.value.length === 0) return { ok: false, error: `Enter the secret for ${label}.` };
    const secretRef = await prepare(field.value);
    if (secretRef === null) return { ok: false, error: "" };
    return { ok: true, value: { kind: "secret-ref", name: field.name, secretRef } };
  };
  const headers: McpNamedCredential[] = [];
  for (const entry of form.transport === "stdio" ? [] : form.headers) {
    const credential = await swap(entry.credential, entry.name || "a header");
    if (!credential.ok) return credential;
    headers.push({ ...entry, credential: credential.value });
  }
  const env: McpNamedCredential[] = [];
  for (const entry of form.transport === "stdio" ? form.env : []) {
    const credential = await swap(entry.credential, entry.name || "a variable");
    if (!credential.ok) return credential;
    env.push({ ...entry, credential: credential.value });
  }
  let authorization = form.authorization;
  if (
    form.transport !== "stdio" &&
    authorization.type === "oauth-pre-registered" &&
    authorization.clientSecret !== null
  ) {
    const clientSecret = await swap(authorization.clientSecret, "the client secret");
    if (!clientSecret.ok) return clientSecret;
    authorization = { ...authorization, clientSecret: clientSecret.value };
  }
  return { ok: true, value: { ...form, headers, env, authorization } };
}

export interface McpOverridePatch {
  /** A pinned value, or null to follow the definition's again. */
  readonly enabled?: boolean | null;
  /** A pinned provider selection, or null to follow the definition's again. */
  readonly providerInstanceIds?: ReadonlyArray<ProviderInstanceId> | null;
  /** A new name, or null to follow the definition's name again. */
  readonly name?: string | null;
  /** A replacement connection, or null to use the definition's again. */
  readonly transport?: McpCatalogTransportInput | null;
}

/**
 * The complete override to put. A put replaces the stored override, so every
 * field the patch leaves alone is carried over, including a replaced
 * connection with its stored credential IDs and definition ID.
 */
export function mcpOverrideInput(input: {
  readonly scope: "project" | "session";
  readonly scopeId: string;
  readonly row: McpCatalogRow;
  readonly patch: McpOverridePatch;
  readonly newId: McpCatalogOverride["id"];
}) {
  const previous = input.row.override;
  const { patch } = input;
  const nameText = patch.name === undefined ? previous?.name : (patch.name ?? undefined);
  const name = nameText === undefined ? undefined : decodeName(nameText.trim());
  if (name?._tag === "None")
    return { ok: false as const, error: "Name the server (up to 120 characters)." };
  const enabled = patch.enabled === undefined ? previous?.enabled : (patch.enabled ?? undefined);
  const providerInstanceIds =
    patch.providerInstanceIds === undefined
      ? previous?.providerInstanceIds
      : (patch.providerInstanceIds ?? undefined);
  let transport: McpCatalogTransportInput | undefined;
  if (patch.transport !== undefined) transport = patch.transport ?? undefined;
  else if (previous?.transport !== undefined) {
    const kept = mcpTransportInputFromPersisted(previous.transport);
    if (!kept.ok) return { ok: false as const, error: kept.error };
    transport = kept.value;
  }
  return {
    ok: true as const,
    value: {
      id: previous?.id ?? input.newId,
      scope: input.scope,
      scopeId: input.scopeId,
      targetId: input.row.definition.logicalServerId,
      ...(enabled === undefined ? {} : { enabled }),
      ...(name === undefined ? {} : { name: name.value }),
      ...(providerInstanceIds === undefined
        ? {}
        : { providerInstanceIds: [...providerInstanceIds] }),
      ...(transport === undefined
        ? {}
        : {
            transport,
            ...(previous?.transportDefinitionId === undefined
              ? {}
              : { transportDefinitionId: previous.transportDefinitionId }),
          }),
    },
  };
}

/**
 * What an override editor shows and edits. Null means the field follows the
 * definition; showing an inherited value never pins it.
 */
export interface McpOverrideFields {
  readonly name: string;
  readonly enabled: boolean | null;
  readonly providerInstanceIds: ReadonlyArray<ProviderInstanceId> | null;
}

export function mcpOverrideFieldsFromRow(row: McpCatalogRow): McpOverrideFields {
  return {
    name: row.override?.name ?? "",
    enabled: row.override?.enabled ?? null,
    providerInstanceIds: row.override?.providerInstanceIds ?? null,
  };
}

/**
 * The editor's fields as a patch: only explicitly overridden values are pinned.
 * A blank name follows the definition. A typed name stays pinned even when it
 * equals the inherited one, so a later rename of the definition doesn't flow in.
 */
export function mcpOverridePatchFromFields(
  fields: McpOverrideFields,
): Omit<McpOverridePatch, "transport"> {
  const name = fields.name.trim();
  return {
    name: name.length === 0 ? null : name,
    enabled: fields.enabled,
    providerInstanceIds: fields.providerInstanceIds,
  };
}

/**
 * The one checkout a project view writes to. A project with several
 * checkouts on this environment has no single answer, so the view asks.
 */
export function resolveResourceCheckout<Member extends { readonly id: ProjectId }>(
  members: ReadonlyArray<Member>,
):
  | { readonly kind: "single"; readonly projectId: ProjectId }
  | { readonly kind: "ambiguous"; readonly members: ReadonlyArray<Member> }
  | { readonly kind: "none" } {
  if (members.length === 0) return { kind: "none" };
  if (members.length === 1) return { kind: "single", projectId: members[0]!.id };
  return { kind: "ambiguous", members };
}

/** Desired versus delivered, never inferred: only the gateway's receipt says applied. */
export function mcpApplicationSummary(snapshot: McpCatalogSnapshot): {
  readonly label: string;
  readonly tone: "success" | "warning" | "error" | "info";
} {
  if (snapshot.disposedAt !== undefined) return { label: "Session ended", tone: "info" };
  const revisions = `desired r${snapshot.desiredRevision}, applied r${snapshot.appliedRevision}`;
  const application = snapshot.application;
  if (
    application?.status === "restart-required" &&
    application.revision === snapshot.desiredRevision
  )
    return { label: `Restart required (${revisions}): ${application.reason}`, tone: "warning" };
  if (application?.status === "failed" && application.revision === snapshot.desiredRevision)
    return { label: `Delivery failed (${revisions}): ${application.reason}`, tone: "error" };
  if (application?.status === "applied" && snapshot.appliedRevision === snapshot.desiredRevision)
    return { label: `Applied (${revisions})`, tone: "success" };
  return { label: `Waiting for delivery (${revisions})`, tone: "info" };
}

export type InventoryKindFilter = "all" | ManagedResourceInventoryRow["kind"];

export function filterInventoryRows(
  rows: ReadonlyArray<ManagedResourceInventoryRow>,
  query: string,
  kind: InventoryKindFilter,
): ReadonlyArray<ManagedResourceInventoryRow> {
  const needle = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (kind === "all" || row.kind === kind) &&
      (needle.length === 0 ||
        row.key.toLowerCase().includes(needle) ||
        row.name.toLowerCase().includes(needle)),
  );
}

export const INVENTORY_KIND_LABELS: Readonly<Record<ManagedResourceInventoryRow["kind"], string>> =
  {
    skill: "Skill",
    command: "Command",
    snippet: "Snippet",
    mcp: "MCP server",
  };

export function inventoryScopeLabel(
  row: Pick<ManagedResourceInventoryRow, "kind" | "source" | "scope">,
) {
  if (row.source === "native") return "Provider";
  switch (row.scope) {
    case "global":
    case "environment":
      return "Environment";
    case "project":
      return "Project";
    case "session":
      return "Session";
    default:
      return row.scope;
  }
}

/** Desired versus delivered skill revisions as the catalog reports them. */
export function skillApplicationLabel(application: SkillApplicationSummary): string {
  const revisions = `desired r${application.desiredRevision}, applied r${application.appliedRevision}`;
  switch (application.status) {
    case "applied":
      return application.desiredRevision === application.appliedRevision
        ? `Applied (${revisions})`
        : `Waiting for delivery (${revisions})`;
    case "pending_new_session":
      return `Applies to new sessions (${revisions})`;
    case "pending_restart":
      return `Restart required (${revisions})`;
    case "failed":
      return `Delivery failed (${revisions})${application.failure ? `: ${application.failure.message}` : ""}`;
    case "unsupported":
      return "This provider can't receive managed skills";
  }
}
