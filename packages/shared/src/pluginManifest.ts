import {
  PLUGIN_HOST_API,
  PluginId,
  PluginManifest,
  PluginCapability,
  PluginOperationName,
  type PluginOperationDecl,
  type PluginSettingField,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const decodeManifestResult = Schema.decodeUnknownResult(PluginManifest);
const isPluginId = Schema.is(PluginId);
const isPluginOperationName = Schema.is(PluginOperationName);
const isPluginCapability = Schema.is(PluginCapability);

const PLUGIN_TOOL_PREFIX = "plugin_";
const PLUGIN_RESOURCE_SCHEME = "t3-plugin://";
const HOST_API_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const firstDuplicate = (values: ReadonlyArray<string>): string | undefined => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
};

const settingFieldProblem = (field: PluginSettingField): string | undefined => {
  if (field.type === "enum" && (field.options === undefined || field.options.length === 0)) {
    return `setting "${field.key}" is an enum without options`;
  }
  if (field.type !== "enum" && field.options !== undefined) {
    return `setting "${field.key}" has options but is not an enum`;
  }
  if (field.default === undefined) return undefined;
  if (field.type === "secret")
    return `setting "${field.key}" is a secret and cannot have a default`;
  const expected = field.type === "enum" ? "string" : field.type;
  if (typeof field.default !== expected) {
    return `setting "${field.key}" default is not a ${field.type}`;
  }
  if (field.type === "enum" && !field.options?.includes(field.default as string)) {
    return `setting "${field.key}" default is not one of its options`;
  }
  return undefined;
};

const JSON_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);
const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions"] as const;
const SCHEMA_KEYWORDS = [
  "items",
  "prefixItems",
  "additionalProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "contains",
  "if",
  "then",
  "else",
] as const;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Providers reject a tool whose input_schema is malformed, which fails the whole turn.
const inputSchemaProblem = (schema: unknown, path: string): string | undefined => {
  if (typeof schema === "boolean") return undefined;
  if (!isObject(schema)) return `${path} is not a schema object`;
  const { type, required } = schema;
  if (
    type !== undefined &&
    !(typeof type === "string" && JSON_SCHEMA_TYPES.has(type)) &&
    !(
      Array.isArray(type) &&
      type.length > 0 &&
      type.every((entry) => typeof entry === "string" && JSON_SCHEMA_TYPES.has(entry))
    )
  ) {
    return `${path}.type is not a JSON Schema type`;
  }
  if (
    required !== undefined &&
    !(Array.isArray(required) && required.every((entry) => typeof entry === "string"))
  ) {
    return `${path}.required is not an array of strings`;
  }
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const map = schema[keyword];
    if (map === undefined) continue;
    if (!isObject(map)) return `${path}.${keyword} is not an object`;
    for (const [key, child] of Object.entries(map)) {
      const problem = inputSchemaProblem(child, `${path}.${keyword}.${key}`);
      if (problem !== undefined) return problem;
    }
  }
  for (const keyword of SCHEMA_KEYWORDS) {
    const child = schema[keyword];
    if (child === undefined) continue;
    const children = Array.isArray(child) ? child : [child];
    for (const [index, entry] of children.entries()) {
      const problem = inputSchemaProblem(
        entry,
        Array.isArray(child) ? `${path}.${keyword}[${index}]` : `${path}.${keyword}`,
      );
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
};

const manifestProblem = (manifest: PluginManifest): string | undefined => {
  const checks: Array<[string, ReadonlyArray<string>]> = [
    ["panel", manifest.ui?.panels.map((panel) => panel.id) ?? []],
    ["command", manifest.ui?.commands.map((command) => command.id) ?? []],
    ["operation", manifest.backend?.operations.map((operation) => operation.name) ?? []],
    ["topic", manifest.backend?.topics.map((topic) => topic.name) ?? []],
    ["resource", manifest.backend?.resources.map((resource) => resource.name) ?? []],
    ["client setting", manifest.settings?.client.map((field) => field.key) ?? []],
    ["environment setting", manifest.settings?.environment.map((field) => field.key) ?? []],
  ];
  for (const [kind, ids] of checks) {
    const duplicate = firstDuplicate(ids);
    if (duplicate !== undefined) return `duplicate ${kind} "${duplicate}"`;
  }

  const panelIds = new Set(manifest.ui?.panels.map((panel) => panel.id));
  for (const command of manifest.ui?.commands ?? []) {
    // t3/surface.open names a panel or a command by id, so the two must not collide.
    if (panelIds.has(command.id)) {
      return `command "${command.id}" has the same id as a panel`;
    }
    if (!panelIds.has(command.opens.panel)) {
      return `command "${command.id}" opens undeclared panel "${command.opens.panel}"`;
    }
  }

  const operations = new Map(
    manifest.backend?.operations.map((operation) => [operation.name, operation]),
  );
  for (const operation of operations.values()) {
    if (!operation.agent) continue;
    if (operation.inputSchema.type !== "object") {
      return `operation "${operation.name}" is agent-visible but its inputSchema.type is not "object"`;
    }
    const problem = inputSchemaProblem(operation.inputSchema, "inputSchema");
    if (problem !== undefined) return `operation "${operation.name}": ${problem}`;
  }
  for (const resource of manifest.backend?.resources ?? []) {
    const operation = operations.get(resource.operation);
    if (operation === undefined || operation.mutates) {
      return `resource "${resource.name}" must name a declared non-mutating operation`;
    }
  }

  if (isHostApiCompatible(manifest.hostApi)) {
    const unknown = manifest.capabilities.find((capability) => !isPluginCapability(capability));
    if (unknown !== undefined) return `unknown capability "${unknown}"`;
  }

  for (const field of [
    ...(manifest.settings?.client ?? []),
    ...(manifest.settings?.environment ?? []),
  ]) {
    const problem = settingFieldProblem(field);
    if (problem !== undefined) return problem;
  }
  return undefined;
};

export const decodePluginManifest = (json: unknown): Result.Result<PluginManifest, string> => {
  const decoded = decodeManifestResult(json);
  if (Result.isFailure(decoded)) {
    return Result.fail(`Invalid plugin manifest: ${decoded.failure.message}`);
  }
  const problem = manifestProblem(decoded.success);
  return problem === undefined
    ? Result.succeed(decoded.success)
    : Result.fail(`Invalid plugin manifest: ${problem}`);
};

export const isHostApiCompatible = (
  hostApi: string,
  host: { readonly major: number; readonly minor: number } = PLUGIN_HOST_API,
): boolean => {
  const match = HOST_API_PATTERN.exec(hostApi);
  if (match === null) return false;
  return Number(match[1]) === host.major && Number(match[2]) <= host.minor;
};

export const pluginToolName = (pluginId: string, operation: string): string =>
  `${PLUGIN_TOOL_PREFIX}${pluginId.replaceAll("-", "_")}__${operation}`;

// A plugin id has no `_` or `--` and no trailing `-`, so the first `__` is the separator.
export const parsePluginToolName = (
  name: string,
): { readonly pluginId: PluginId; readonly operation: string } | undefined => {
  if (!name.startsWith(PLUGIN_TOOL_PREFIX)) return undefined;
  const rest = name.slice(PLUGIN_TOOL_PREFIX.length);
  const separator = rest.indexOf("__");
  if (separator === -1) return undefined;
  const pluginId = rest.slice(0, separator).replaceAll("_", "-");
  const operation = rest.slice(separator + 2);
  if (!isPluginId(pluginId) || !isPluginOperationName(operation)) return undefined;
  if (pluginToolName(pluginId, operation) !== name) return undefined;
  return { pluginId, operation };
};

export const pluginResourceUri = (pluginId: string, name: string): string =>
  `${PLUGIN_RESOURCE_SCHEME}${pluginId}/${name}`;

export const parsePluginResourceUri = (
  uri: string,
): { readonly pluginId: PluginId; readonly name: string } | undefined => {
  if (!uri.startsWith(PLUGIN_RESOURCE_SCHEME)) return undefined;
  const parts = uri.slice(PLUGIN_RESOURCE_SCHEME.length).split("/");
  if (parts.length !== 2) return undefined;
  const [pluginId, name] = parts as [string, string];
  if (!isPluginId(pluginId) || !isPluginOperationName(name)) return undefined;
  return { pluginId, name };
};

export const pluginToolPolicyKey = (pluginId: string, operation: string): string =>
  `plugin:${pluginId}:${operation}`;

export const pluginAgentTools = (manifest: {
  readonly id: string;
  readonly backend?: { readonly operations: ReadonlyArray<PluginOperationDecl> } | undefined;
}) =>
  (manifest.backend?.operations ?? [])
    .filter((operation) => operation.agent)
    .map((operation) => ({
      name: pluginToolName(manifest.id, operation.name),
      description: operation.description,
      inputSchema: operation.inputSchema,
      annotations: {
        title: operation.title,
        readOnlyHint: !operation.mutates,
        destructiveHint: operation.mutates,
      },
    }));
