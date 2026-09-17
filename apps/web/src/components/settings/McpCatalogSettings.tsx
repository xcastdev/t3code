import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  EnvironmentId,
  McpCatalogDefinition,
  McpCatalogOverrideId,
  McpCatalogOverride,
  McpDefinitionId,
  McpServerId,
  ProjectId,
  ServerProvider,
  type ServerSettings,
  ProjectMcpCredentialId,
  ProjectMcpEnvironmentVariableName,
  ProjectMcpHeaderName,
  type ProviderInstanceId,
  type ProjectMcpTransportDraft,
  parseProjectMcpOAuthAuthorizationUrl,
} from "@t3tools/contracts";
import { useMemo, useRef, useState } from "react";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { randomUUID } from "../../lib/utils";
import { mcpCatalogEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { providerSettingsFieldTargetId } from "./ProviderSettingsForm";

type ProviderSettingsSnapshot = Pick<ServerSettings, "providers" | "providerInstances">;

function providerInstanceConfig(
  entry: ProviderInstanceEntry,
  settings: ProviderSettingsSnapshot,
): unknown {
  const explicit = settings.providerInstances[entry.instanceId];
  if (explicit !== undefined) return explicit.config;
  if (!entry.isDefault) return undefined;
  return (settings.providers as Record<string, unknown>)[entry.driverKind];
}

/** OpenCode instances that point at an external server without T3 management. */
export function resolveUnmanagedExternalOpenCodeInstances(
  providers: ReadonlyArray<ServerProvider>,
  settings: ProviderSettingsSnapshot | undefined,
): ReadonlyArray<ProviderInstanceEntry> {
  if (settings === undefined) return [];
  return deriveProviderInstanceEntries(providers).filter((entry) => {
    if (entry.driverKind !== "opencode") return false;
    const config = providerInstanceConfig(entry, settings);
    if (config === null || typeof config !== "object" || Array.isArray(config)) return false;
    const serverUrl = (config as Record<string, unknown>).serverUrl;
    return (
      typeof serverUrl === "string" &&
      serverUrl.trim().length > 0 &&
      (config as Record<string, unknown>).manageExternalMcp !== true
    );
  });
}

/** Pure helper used by the global/project editors to preserve local drafts. */
export function preserveMcpCatalogDraft<A>(draft: A, serverValue: A, dirty: boolean): A {
  return dirty ? draft : serverValue;
}

export interface CatalogCredentialDraft {
  readonly key: number;
  readonly id?: ProjectMcpCredentialId;
  readonly name: string;
  readonly value: string;
}

let nextCatalogCredentialKey = 0;

export const newCatalogCredential = (credential?: {
  readonly id?: ProjectMcpCredentialId;
  readonly name: string;
}): CatalogCredentialDraft => ({
  key: nextCatalogCredentialKey++,
  ...(credential === undefined ? {} : { id: credential.id }),
  name: credential?.name ?? "",
  value: "",
});

export const retainedCatalogCredential = (credential: CatalogCredentialDraft) =>
  credential.id !== undefined && credential.value.length === 0
    ? { id: credential.id, name: credential.name.trim() }
    : { name: credential.name.trim(), value: credential.value };

export function CatalogCredentialFields({
  label,
  entries,
  onChange,
  disabled = false,
}: {
  readonly label: string;
  readonly entries: ReadonlyArray<CatalogCredentialDraft>;
  readonly onChange: (entries: ReadonlyArray<CatalogCredentialDraft>) => void;
  readonly disabled?: boolean;
}) {
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="text-sm font-medium">{label}</legend>
      {entries.map((entry, index) => (
        <div key={entry.key} className="grid gap-1">
          <Input
            aria-label={`${label} name ${index + 1}`}
            value={entry.name}
            placeholder={`${label} name`}
            onChange={(event) =>
              onChange(
                entries.map((current, currentIndex) =>
                  currentIndex === index ? { ...current, name: event.target.value } : current,
                ),
              )
            }
          />
          <Input
            aria-label={`${label} value ${index + 1}`}
            type="password"
            value={entry.value}
            placeholder={entry.id ? "Configured; leave blank to retain" : `${label} value`}
            onChange={(event) =>
              onChange(
                entries.map((current, currentIndex) =>
                  currentIndex === index ? { ...current, value: event.target.value } : current,
                ),
              )
            }
          />
          {entry.id ? (
            <p className="text-xs text-muted-foreground">Configured; value hidden.</p>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="justify-self-start"
            onClick={() => onChange(entries.filter((_, currentIndex) => currentIndex !== index))}
          >
            Remove credential
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="justify-self-start"
        onClick={() => onChange([...entries, newCatalogCredential()])}
      >
        Add credential
      </Button>
    </fieldset>
  );
}

export function McpCatalogSettings({
  environmentId,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const state = useEnvironmentQuery(
    mcpCatalogEnvironment.globalState({
      environmentId,
      input: { scope: "global", scopeId: environmentId },
    }),
  );
  useAtomValue(mcpCatalogEnvironment.changes({ environmentId, input: {} }));
  const create = useAtomCommand(mcpCatalogEnvironment.globalCreate, { reportFailure: false });
  const update = useAtomCommand(mcpCatalogEnvironment.globalUpdate, { reportFailure: false });
  const remove = useAtomCommand(mcpCatalogEnvironment.globalRemove, { reportFailure: false });
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transportType, setTransportType] = useState<"streamable-http" | "legacy-sse" | "stdio">(
    "streamable-http",
  );
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState<ReadonlyArray<{ readonly key: number; readonly value: string }>>(
    [],
  );
  const [cwd, setCwd] = useState("");
  const [headers, setHeaders] = useState<ReadonlyArray<CatalogCredentialDraft>>([]);
  const [env, setEnv] = useState<ReadonlyArray<CatalogCredentialDraft>>([]);
  const [authorization, setAuthorization] = useState<"none" | "oauth">("none");
  const [oauthRegistration, setOauthRegistration] = useState<"automatic" | "pre-registered">(
    "automatic",
  );
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState<CatalogCredentialDraft>(() =>
    newCatalogCredential(),
  );
  const [selectedProviders, setSelectedProviders] = useState<ReadonlyArray<ProviderInstanceId>>([]);
  const [dirty, setDirty] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nextArgumentKey = useRef(0);
  const providerEntries = useMemo(() => deriveProviderInstanceEntries(providers), [providers]);
  const unavailableProviderIds = selectedProviders.filter(
    (id) => !providerEntries.some((entry) => entry.instanceId === id),
  );
  const definitions = state.data?.definitions ?? [];
  const editing = definitions.find((definition) => definition.definitionId === editingId);
  const save = async () => {
    setError(null);
    const persistedHeaders = headers
      .filter(
        (credential) => credential.name.trim() && (credential.id || credential.value.length > 0),
      )
      .map((credential) => ({
        name: ProjectMcpHeaderName.make(credential.name.trim()),
        credential: retainedCatalogCredential(credential),
      }));
    const persistedEnv = env
      .filter(
        (credential) => credential.name.trim() && (credential.id || credential.value.length > 0),
      )
      .map((credential) => ({
        name: ProjectMcpEnvironmentVariableName.make(credential.name.trim()),
        credential: retainedCatalogCredential(credential),
      }));
    const transport: ProjectMcpTransportDraft =
      transportType === "stdio"
        ? {
            type: "stdio",
            command: command.trim(),
            args: args.map((entry) => entry.value),
            ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
            env: persistedEnv,
          }
        : {
            type: transportType,
            url: url.trim(),
            headers: persistedHeaders,
            authorization:
              authorization === "oauth"
                ? {
                    type: "oauth" as const,
                    registration:
                      oauthRegistration === "automatic"
                        ? { type: "automatic" as const }
                        : {
                            type: "pre-registered" as const,
                            clientId: oauthClientId.trim(),
                            ...(oauthClientSecret.id || oauthClientSecret.value.length > 0
                              ? { clientSecret: retainedCatalogCredential(oauthClientSecret) }
                              : {}),
                          },
                  }
                : { type: "none" as const },
          };
    const result = editing
      ? await update({
          environmentId,
          input: {
            scope: "global",
            scopeId: environmentId,
            expectedRevision: state.data?.globalRevision ?? 0,
            logicalServerId: editing.logicalServerId,
            definition: {
              name: name.trim(),
              enabled: editing.enabled,
              providerInstanceIds: selectedProviders,
              transport,
            },
          },
        })
      : await create({
          environmentId,
          input: {
            scope: "global",
            scopeId: environmentId,
            expectedRevision: state.data?.globalRevision ?? 0,
            definition: {
              name: name.trim(),
              enabled: true,
              providerInstanceIds: selectedProviders,
              transport,
            },
          },
        });
    if (result._tag === "Success") {
      setName("");
      setUrl("");
      setCommand("");
      setArgs([]);
      setCwd("");
      setHeaders([]);
      setEnv([]);
      setAuthorization("none");
      setOauthRegistration("automatic");
      setOauthClientId("");
      setOauthClientSecret(newCatalogCredential());
      setTransportType("streamable-http");
      setSelectedProviders([]);
      setDirty(false);
      setEditingId(null);
      return;
    }
    setError(
      editing ? "Could not update the MCP catalog entry." : "Could not add the MCP catalog entry.",
    );
  };
  const toggle = async (definition: (typeof definitions)[number]) => {
    setError(null);
    const result = await update({
      environmentId,
      input: {
        scope: "global",
        scopeId: environmentId,
        expectedRevision: state.data?.globalRevision ?? 0,
        logicalServerId: definition.logicalServerId,
        definition: {
          name: definition.name,
          enabled: !definition.enabled,
          providerInstanceIds: definition.providerInstanceIds,
          transport: definition.transport,
        },
      },
    });
    if (result._tag === "Failure") setError("Could not change the MCP catalog entry.");
  };
  const deleteDefinition = async (definition: (typeof definitions)[number]) => {
    setError(null);
    const result = await remove({
      environmentId,
      input: {
        scope: "global",
        scopeId: environmentId,
        expectedRevision: state.data?.globalRevision ?? 0,
        logicalServerId: definition.logicalServerId,
      },
    });
    if (result._tag === "Failure") setError("Could not remove the MCP catalog entry.");
  };
  return (
    <SettingsSection id="mcp-catalog" title="MCP catalog">
      <SettingsRow
        title="Global MCP servers"
        description="Shared definitions inherited by projects and provider sessions."
      >
        <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
          <Input
            aria-label="MCP server name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setDirty(true);
            }}
            placeholder="Name"
          />
          <Input
            aria-label="MCP server URL"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setDirty(true);
            }}
            placeholder="https://example.com/mcp"
            disabled={transportType === "stdio"}
          />
          <select
            aria-label="MCP transport type"
            value={transportType}
            onChange={(event) =>
              setTransportType(event.target.value as "streamable-http" | "legacy-sse" | "stdio")
            }
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="streamable-http">Streamable HTTP</option>
            <option value="legacy-sse">Legacy SSE</option>
            <option value="stdio">Local command (stdio)</option>
          </select>
          {transportType === "stdio" ? (
            <Input
              aria-label="MCP command"
              value={command}
              onChange={(event) => {
                setCommand(event.target.value);
                setDirty(true);
              }}
              placeholder="Command"
            />
          ) : null}
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={
              !name.trim() ||
              (transportType === "stdio" ? !command.trim() : !url.trim()) ||
              state.isPending
            }
          >
            {editing ? "Save" : "Add"}
          </Button>
          {editing ? (
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                setEditingId(null);
                setName("");
                setUrl("");
                setCommand("");
                setArgs([]);
                setCwd("");
                setHeaders([]);
                setEnv([]);
                setAuthorization("none");
                setOauthRegistration("automatic");
                setOauthClientId("");
                setOauthClientSecret(newCatalogCredential());
                setTransportType("streamable-http");
                setSelectedProviders([]);
                setDirty(false);
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>
        {transportType === "stdio" ? (
          <div className="mt-2 grid gap-2">
            <label className="grid gap-1 text-sm font-medium">
              Working directory
              <Input
                value={cwd}
                aria-label="MCP working directory"
                onChange={(event) => {
                  setCwd(event.target.value);
                  setDirty(true);
                }}
              />
            </label>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Arguments</legend>
              {args.map((argument, index) => (
                <div key={argument.key} className="flex gap-1">
                  <Input
                    aria-label={`MCP argument ${index + 1}`}
                    value={argument.value}
                    onChange={(event) => {
                      setArgs(
                        args.map((current) =>
                          current.key === argument.key
                            ? { ...current, value: event.target.value }
                            : current,
                        ),
                      );
                      setDirty(true);
                    }}
                  />
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setArgs(args.filter((current) => current.key !== argument.key));
                      setDirty(true);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="justify-self-start"
                onClick={() => {
                  setArgs([...args, { key: nextArgumentKey.current++, value: "" }]);
                  setDirty(true);
                }}
              >
                Add argument
              </Button>
            </fieldset>
            <CatalogCredentialFields
              label="Environment variable"
              entries={env}
              onChange={(next) => {
                setEnv(next);
                setDirty(true);
              }}
            />
          </div>
        ) : (
          <div className="mt-2 grid gap-2">
            <CatalogCredentialFields
              label="HTTP header"
              entries={headers}
              onChange={(next) => {
                setHeaders(next);
                setDirty(true);
              }}
            />
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Authorization</legend>
              <select
                aria-label="MCP authorization"
                value={authorization}
                onChange={(event) => {
                  setAuthorization(event.target.value as "none" | "oauth");
                  setDirty(true);
                }}
              >
                <option value="none">None</option>
                <option value="oauth">OAuth</option>
              </select>
              {authorization === "oauth" ? (
                <>
                  <select
                    aria-label="MCP OAuth registration"
                    value={oauthRegistration}
                    onChange={(event) => {
                      setOauthRegistration(event.target.value as "automatic" | "pre-registered");
                      setDirty(true);
                    }}
                  >
                    <option value="automatic">Automatic registration</option>
                    <option value="pre-registered">Pre-registered client</option>
                  </select>
                  {oauthRegistration === "pre-registered" ? (
                    <>
                      <Input
                        aria-label="MCP OAuth client ID"
                        value={oauthClientId}
                        placeholder="Client ID"
                        onChange={(event) => {
                          setOauthClientId(event.target.value);
                          setDirty(true);
                        }}
                      />
                      <CatalogCredentialFields
                        label="OAuth client secret"
                        entries={[oauthClientSecret]}
                        onChange={(next) => {
                          setOauthClientSecret(next[0] ?? newCatalogCredential());
                          setDirty(true);
                        }}
                      />
                    </>
                  ) : null}
                </>
              ) : null}
            </fieldset>
          </div>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <fieldset className="mt-2 flex flex-wrap gap-2 text-xs" disabled={state.isPending}>
          <legend className="sr-only">MCP providers</legend>
          {providerEntries.map((entry) => {
            const id = entry.instanceId as ProviderInstanceId;
            return (
              <label key={entry.instanceId} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={selectedProviders.includes(id)}
                  onChange={(event) =>
                    setSelectedProviders(
                      event.target.checked
                        ? [...selectedProviders, id]
                        : selectedProviders.filter((item) => item !== id),
                    )
                  }
                />
                {entry.displayName}
              </label>
            );
          })}
          {unavailableProviderIds.map((id) => (
            <label key={id} className="flex items-center gap-1 text-muted-foreground">
              <input
                type="checkbox"
                checked
                aria-label={`Select unavailable provider ${id}`}
                onChange={() =>
                  setSelectedProviders(selectedProviders.filter((item) => item !== id))
                }
              />
              {id} (Unavailable)
            </label>
          ))}
        </fieldset>
        {definitions.length > 0 ? (
          <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
            {definitions.map((definition) => (
              <li key={definition.definitionId} className="flex items-center justify-between gap-2">
                <span>
                  {definition.name}
                  {definition.enabled ? "" : " (disabled)"}
                </span>
                <span className="flex gap-1">
                  <Button
                    size="xs"
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setEditingId(definition.definitionId);
                      setName(definition.name);
                      setUrl(definition.transport.type === "stdio" ? "" : definition.transport.url);
                      setCommand(
                        definition.transport.type === "stdio" ? definition.transport.command : "",
                      );
                      setArgs(
                        definition.transport.type === "stdio"
                          ? definition.transport.args.map((value) => ({
                              key: nextArgumentKey.current++,
                              value,
                            }))
                          : [],
                      );
                      setCwd(
                        definition.transport.type === "stdio"
                          ? (definition.transport.cwd ?? "")
                          : "",
                      );
                      setHeaders(
                        definition.transport.type === "stdio"
                          ? []
                          : definition.transport.headers
                              .map((header) => newCatalogCredential(header.credential))
                              .map((credential, index) => ({
                                ...credential,
                                name:
                                  definition.transport.type === "stdio"
                                    ? ""
                                    : definition.transport.headers[index]!.name,
                              })),
                      );
                      setEnv(
                        definition.transport.type === "stdio"
                          ? definition.transport.env.map((variable) => ({
                              ...newCatalogCredential(variable.credential),
                              name: variable.name,
                            }))
                          : [],
                      );
                      setAuthorization(
                        definition.transport.type === "stdio"
                          ? "none"
                          : definition.transport.authorization.type,
                      );
                      setOauthRegistration(
                        definition.transport.type !== "stdio" &&
                          definition.transport.authorization.type === "oauth"
                          ? definition.transport.authorization.registration.type
                          : "automatic",
                      );
                      setOauthClientId(
                        definition.transport.type !== "stdio" &&
                          definition.transport.authorization.type === "oauth" &&
                          definition.transport.authorization.registration.type === "pre-registered"
                          ? definition.transport.authorization.registration.clientId
                          : "",
                      );
                      setOauthClientSecret(
                        definition.transport.type !== "stdio" &&
                          definition.transport.authorization.type === "oauth" &&
                          definition.transport.authorization.registration.type ===
                            "pre-registered" &&
                          definition.transport.authorization.registration.clientSecret !== undefined
                          ? newCatalogCredential(
                              definition.transport.authorization.registration.clientSecret,
                            )
                          : newCatalogCredential(),
                      );
                      setTransportType(
                        definition.transport.type === "stdio" ? "stdio" : definition.transport.type,
                      );
                      setSelectedProviders(definition.providerInstanceIds);
                      setDirty(true);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    type="button"
                    variant="ghost"
                    onClick={() => void toggle(definition)}
                    disabled={state.isPending}
                  >
                    {definition.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    size="xs"
                    type="button"
                    variant="ghost"
                    onClick={() => void deleteDefinition(definition)}
                    disabled={state.isPending}
                  >
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No global MCP servers yet.</p>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

/** Project view showing inherited definitions separately from local entries. */
export function McpCatalogProjectSettings({
  environmentId,
  projectId,
  providers,
  settings,
  canOverride = true,
  canMutate = true,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings?: ProviderSettingsSnapshot | undefined;
  readonly canOverride?: boolean;
  readonly canMutate?: boolean;
}) {
  const state = useEnvironmentQuery(
    mcpCatalogEnvironment.projectState({
      environmentId,
      input: { scope: "project", scopeId: projectId },
    }),
  );
  useAtomValue(mcpCatalogEnvironment.changes({ environmentId, input: {} }));
  const create = useAtomCommand(mcpCatalogEnvironment.projectCreate, { reportFailure: false });
  const update = useAtomCommand(mcpCatalogEnvironment.projectUpdate, { reportFailure: false });
  const remove = useAtomCommand(mcpCatalogEnvironment.projectRemove, { reportFailure: false });
  const override = useAtomCommand(mcpCatalogEnvironment.projectOverride, { reportFailure: false });
  const deleteOverride = useAtomCommand(mcpCatalogEnvironment.projectDeleteOverride, {
    reportFailure: false,
  });
  const oauthBegin = useAtomCommand(mcpCatalogEnvironment.oauthBegin, { reportFailure: false });
  const oauthContinue = useAtomCommand(mcpCatalogEnvironment.oauthContinue, {
    reportFailure: false,
  });
  const oauthDisconnect = useAtomCommand(mcpCatalogEnvironment.oauthDisconnect, {
    reportFailure: false,
  });
  const providerEntries = useMemo(() => deriveProviderInstanceEntries(providers), [providers]);
  const unmanagedExternalOpenCodeInstances = useMemo(
    () => resolveUnmanagedExternalOpenCodeInstances(providers, settings),
    [providers, settings],
  );
  const [draft, setDraft] = useState({ name: "", url: "" });
  const [transportType, setTransportType] = useState<"streamable-http" | "legacy-sse" | "stdio">(
    "streamable-http",
  );
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState<ReadonlyArray<{ readonly key: number; readonly value: string }>>(
    [],
  );
  const [cwd, setCwd] = useState("");
  const [headers, setHeaders] = useState<ReadonlyArray<CatalogCredentialDraft>>([]);
  const [env, setEnv] = useState<ReadonlyArray<CatalogCredentialDraft>>([]);
  const [authorization, setAuthorization] = useState<"none" | "oauth">("none");
  const [oauthRegistration, setOauthRegistration] = useState<"automatic" | "pre-registered">(
    "automatic",
  );
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState<CatalogCredentialDraft>(() =>
    newCatalogCredential({ name: "OAuth client secret" }),
  );
  const [selectedProviders, setSelectedProviders] = useState<ReadonlyArray<ProviderInstanceId>>([]);
  const unavailableProviderIds = selectedProviders.filter(
    (id) => !providerEntries.some((entry) => entry.instanceId === id),
  );
  const [enabled, setEnabled] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingOverrideId, setEditingOverrideId] = useState<McpCatalogOverrideId | null>(null);
  const [overrideTargetId, setOverrideTargetId] = useState<McpServerId | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorizationLink, setAuthorizationLink] = useState<{
    readonly definitionId: McpDefinitionId;
    readonly url: string;
  } | null>(null);
  const nextArgumentKey = useRef(0);
  const resetDraft = () => {
    setDraft({ name: "", url: "" });
    setTransportType("streamable-http");
    setCommand("");
    setArgs([]);
    setCwd("");
    setHeaders([]);
    setEnv([]);
    setAuthorization("none");
    setOauthRegistration("automatic");
    setOauthClientId("");
    setOauthClientSecret(newCatalogCredential({ name: "OAuth client secret" }));
    setSelectedProviders([]);
    setEnabled(true);
    setEditingId(null);
    setEditingOverrideId(null);
    setOverrideTargetId(null);
    setDirty(false);
    setError(null);
    setAuthorizationLink(null);
  };
  const loadDraft = (definition: McpCatalogDefinition) => {
    const transport = definition.transport;
    setEditingId(definition.logicalServerId);
    setEditingOverrideId(null);
    setOverrideTargetId(null);
    setDraft({ name: definition.name, url: transport.type === "stdio" ? "" : transport.url });
    setTransportType(transport.type);
    setCommand(transport.type === "stdio" ? transport.command : "");
    setArgs(
      transport.type === "stdio"
        ? transport.args.map((value) => ({ key: nextArgumentKey.current++, value }))
        : [],
    );
    setCwd(transport.type === "stdio" ? (transport.cwd ?? "") : "");
    setHeaders(
      transport.type === "stdio"
        ? []
        : transport.headers.map((entry) => ({
            ...newCatalogCredential(entry.credential),
            name: entry.name,
          })),
    );
    setEnv(
      transport.type === "stdio"
        ? transport.env.map((entry) => ({
            ...newCatalogCredential(entry.credential),
            name: entry.name,
          }))
        : [],
    );
    setAuthorization(transport.type === "stdio" ? "none" : transport.authorization.type);
    setOauthRegistration(
      transport.type !== "stdio" && transport.authorization.type === "oauth"
        ? transport.authorization.registration.type
        : "automatic",
    );
    setOauthClientId(
      transport.type !== "stdio" &&
        transport.authorization.type === "oauth" &&
        transport.authorization.registration.type === "pre-registered"
        ? transport.authorization.registration.clientId
        : "",
    );
    setOauthClientSecret(
      transport.type !== "stdio" &&
        transport.authorization.type === "oauth" &&
        transport.authorization.registration.type === "pre-registered" &&
        transport.authorization.registration.clientSecret !== undefined
        ? newCatalogCredential(transport.authorization.registration.clientSecret)
        : newCatalogCredential({ name: "OAuth client secret" }),
    );
    setSelectedProviders(definition.providerInstanceIds);
    setEnabled(definition.enabled);
    setDirty(true);
    setError(null);
    setAuthorizationLink(null);
  };
  const buildTransport = (): ProjectMcpTransportDraft => {
    if (transportType === "stdio") {
      return {
        type: "stdio",
        command: command.trim(),
        args: args.map((entry) => entry.value),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        env: env
          .filter((entry) => entry.name.trim() && (entry.id || entry.value.length > 0))
          .map((entry) => ({
            name: ProjectMcpEnvironmentVariableName.make(entry.name.trim()),
            credential: retainedCatalogCredential(entry),
          })),
      };
    }
    return {
      type: transportType,
      url: draft.url.trim(),
      headers: headers
        .filter((entry) => entry.name.trim() && (entry.id || entry.value.length > 0))
        .map((entry) => ({
          name: ProjectMcpHeaderName.make(entry.name.trim()),
          credential: retainedCatalogCredential(entry),
        })),
      authorization:
        authorization === "oauth"
          ? {
              type: "oauth",
              registration:
                oauthRegistration === "automatic"
                  ? { type: "automatic" }
                  : {
                      type: "pre-registered",
                      clientId: oauthClientId.trim(),
                      ...(oauthClientSecret.id || oauthClientSecret.value.length > 0
                        ? { clientSecret: retainedCatalogCredential(oauthClientSecret) }
                        : {}),
                    },
            }
          : { type: "none" },
    };
  };
  const add = async () => {
    if (!draft.name.trim()) {
      setError("A server name is required.");
      return;
    }
    if (transportType === "stdio" ? !command.trim() : !draft.url.trim()) {
      setError(transportType === "stdio" ? "A command is required." : "A URL is required.");
      return;
    }
    setError(null);
    const result = editingOverrideId
      ? await override({
          environmentId,
          input: {
            scope: "project",
            scopeId: projectId,
            expectedRevision: state.data?.projectRevision ?? 0,
            override: {
              id: editingOverrideId,
              scope: "project",
              scopeId: projectId,
              targetId: overrideTargetId!,
              enabled,
              name: draft.name.trim(),
              providerInstanceIds: selectedProviders,
              transport: buildTransport(),
            },
          },
        })
      : editingId
        ? await update({
            environmentId,
            input: {
              scope: "project",
              scopeId: projectId,
              expectedRevision: state.data?.projectRevision ?? 0,
              logicalServerId: editingId as import("@t3tools/contracts").McpServerId,
              definition: {
                name: draft.name.trim(),
                enabled,
                providerInstanceIds: selectedProviders,
                transport: buildTransport(),
              },
            },
          })
        : await create({
            environmentId,
            input: {
              scope: "project",
              scopeId: projectId,
              expectedRevision: state.data?.projectRevision ?? 0,
              definition: {
                name: draft.name.trim(),
                enabled,
                providerInstanceIds: selectedProviders,
                transport: buildTransport(),
              },
            },
          });
    if (result._tag === "Success") {
      resetDraft();
    } else {
      setDirty(true);
    }
  };
  const inherited = state.data?.globalDefinitions ?? [];
  const local = state.data?.projectDefinitions ?? [];
  const overrides = state.data?.projectOverrides ?? [];
  const editLocal = async (definition: (typeof local)[number]) => {
    loadDraft(definition);
  };
  const toggleLocal = async (definition: (typeof local)[number]) => {
    const result = await update({
      environmentId,
      input: {
        scope: "project",
        scopeId: projectId,
        expectedRevision: state.data?.projectRevision ?? 0,
        logicalServerId: definition.logicalServerId,
        definition: {
          name: definition.name,
          enabled: !definition.enabled,
          providerInstanceIds: definition.providerInstanceIds,
          transport: definition.transport,
        },
      },
    });
    if (result._tag === "Failure") setDirty(true);
  };
  const removeLocal = async (definition: (typeof local)[number]) => {
    const result = await remove({
      environmentId,
      input: {
        scope: "project",
        scopeId: projectId,
        expectedRevision: state.data?.projectRevision ?? 0,
        logicalServerId: definition.logicalServerId,
      },
    });
    if (result._tag === "Failure") setDirty(true);
  };
  const createOverride = (definition: (typeof inherited)[number]) => {
    loadDraft(definition);
    setEditingId(null);
    setEditingOverrideId(McpCatalogOverrideId.make(randomUUID()));
    setOverrideTargetId(definition.logicalServerId);
    setEnabled(definition.enabled);
  };
  const editOverride = (entry: McpCatalogOverride) => {
    const target = inherited.find((definition) => definition.logicalServerId === entry.targetId);
    if (!target) {
      setError("The inherited MCP server is no longer available.");
      return;
    }
    const effective: McpCatalogDefinition = {
      ...target,
      name: entry.name ?? target.name,
      enabled: entry.enabled ?? target.enabled,
      providerInstanceIds: entry.providerInstanceIds ?? target.providerInstanceIds,
      transport: entry.transport ?? target.transport,
    };
    loadDraft(effective);
    setEditingId(null);
    setEditingOverrideId(entry.id);
    setOverrideTargetId(entry.targetId);
    setEnabled(effective.enabled);
  };
  const removeOverride = async (entry: (typeof overrides)[number]) => {
    const result = await deleteOverride({
      environmentId,
      input: {
        scope: "project",
        scopeId: projectId,
        expectedRevision: state.data?.projectRevision ?? 0,
        overrideId: entry.id,
      },
    });
    if (result._tag === "Failure") setDirty(true);
  };
  const catalogOauth = async (
    action: "begin" | "continue" | "disconnect",
    definition: { readonly logicalServerId: McpServerId; readonly definitionId: McpDefinitionId },
  ) => {
    setAuthorizationLink(null);
    const input = {
      projectId,
      logicalServerId: definition.logicalServerId,
      transportDefinitionId:
        definition.definitionId as import("@t3tools/contracts").McpDefinitionId,
    };
    const result =
      action === "begin"
        ? await oauthBegin({ environmentId, input })
        : action === "continue"
          ? await oauthContinue({ environmentId, input })
          : await oauthDisconnect({ environmentId, input });
    if (result._tag === "Failure") {
      setDirty(true);
      setError(`Could not ${action} MCP OAuth.`);
      return;
    }
    if (action !== "disconnect") {
      const authorizationUrl = result.value?.authorizationUrl;
      if (authorizationUrl === undefined) {
        setError("OAuth did not return an authorization URL.");
        return;
      }
      const url = parseProjectMcpOAuthAuthorizationUrl(authorizationUrl);
      if (url === undefined) setError("OAuth returned an unsafe authorization URL.");
      else setAuthorizationLink({ definitionId: definition.definitionId, url });
    }
  };
  return (
    <SettingsSection id="mcp-catalog-project" title="MCP catalog">
      <SettingsRow
        title="Inherited servers"
        description="Global definitions apply unless a project override changes them."
      >
        <p className="text-sm text-muted-foreground">
          {inherited.length} inherited · {local.length} local · {overrides.length} overridden
        </p>
        {unmanagedExternalOpenCodeInstances.length > 0 ? (
          <div className="mt-2 grid gap-1 text-sm text-muted-foreground">
            <p>
              OpenCode project MCP is unavailable while an external OpenCode server is unmanaged.
              Enable T3-managed MCP before using this project catalog:
            </p>
            <ul className="list-inside list-disc">
              {unmanagedExternalOpenCodeInstances.map((entry) => (
                <li key={entry.instanceId}>
                  <Link
                    to="/settings/providers"
                    search={{ environmentId, instanceId: entry.instanceId }}
                    hash={providerSettingsFieldTargetId(
                      `provider-instance-${entry.instanceId}`,
                      "manageExternalMcp",
                    )}
                    className="underline"
                  >
                    Enable T3-managed MCP for {entry.displayName}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {inherited.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {inherited.map((entry) => (
              <li key={entry.definitionId} className="flex items-center justify-between gap-2">
                <span>{entry.name}</span>
                <span className="flex gap-1">
                  {entry.transport.type !== "stdio" &&
                  entry.transport.authorization.type === "oauth" ? (
                    <>
                      <Button
                        size="xs"
                        type="button"
                        variant="ghost"
                        onClick={() => void catalogOauth("begin", entry)}
                        disabled={!canMutate || state.isPending}
                      >
                        Connect OAuth
                      </Button>
                      <Button
                        size="xs"
                        type="button"
                        variant="ghost"
                        onClick={() => void catalogOauth("continue", entry)}
                        disabled={!canMutate || state.isPending}
                      >
                        Continue OAuth
                      </Button>
                      <Button
                        size="xs"
                        type="button"
                        variant="ghost"
                        onClick={() => void catalogOauth("disconnect", entry)}
                        disabled={!canMutate || state.isPending}
                      >
                        Disconnect OAuth
                      </Button>
                    </>
                  ) : null}
                  {canOverride ? (
                    <Button
                      size="xs"
                      type="button"
                      variant="ghost"
                      onClick={() => createOverride(entry)}
                      disabled={
                        !canMutate ||
                        state.isPending ||
                        overrides.some((item) => item.targetId === entry.logicalServerId)
                      }
                    >
                      Override
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
          <Input
            aria-label="Project MCP server name"
            value={draft.name}
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
              setDirty(true);
            }}
            placeholder="Name"
            disabled={!canMutate || state.isPending}
          />
          <Input
            aria-label="Project MCP server URL"
            value={draft.url}
            onChange={(event) => {
              setDraft({ ...draft, url: event.target.value });
              setDirty(true);
            }}
            placeholder="https://example.com/mcp"
            disabled={!canMutate || state.isPending || transportType === "stdio"}
          />
          <select
            aria-label="Project MCP transport type"
            value={transportType}
            onChange={(event) => {
              setTransportType(event.target.value as "streamable-http" | "legacy-sse" | "stdio");
              setDirty(true);
            }}
            disabled={!canMutate || state.isPending}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="streamable-http">Streamable HTTP</option>
            <option value="legacy-sse">Legacy SSE</option>
            <option value="stdio">Local command (stdio)</option>
          </select>
          {transportType === "stdio" ? (
            <>
              <Input
                aria-label="Project MCP command"
                value={command}
                onChange={(event) => {
                  setCommand(event.target.value);
                  setDirty(true);
                }}
                placeholder="Command"
                disabled={!canMutate || state.isPending}
              />
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Arguments</legend>
                {args.map((argument, index) => (
                  <div key={argument.key} className="flex items-center gap-2">
                    <Input
                      aria-label={`Project MCP argument ${index + 1}`}
                      value={argument.value}
                      onChange={(event) => {
                        setArgs(
                          args.map((current) =>
                            current.key === argument.key
                              ? { ...current, value: event.target.value }
                              : current,
                          ),
                        );
                        setDirty(true);
                      }}
                      disabled={!canMutate || state.isPending}
                    />
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        setArgs(args.filter((current) => current.key !== argument.key));
                        setDirty(true);
                      }}
                      disabled={!canMutate || state.isPending}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="justify-self-start"
                  onClick={() => {
                    setArgs([...args, { key: nextArgumentKey.current++, value: "" }]);
                    setDirty(true);
                  }}
                  disabled={!canMutate || state.isPending}
                >
                  Add argument
                </Button>
              </fieldset>
              <Input
                aria-label="Project MCP working directory"
                value={cwd}
                onChange={(event) => {
                  setCwd(event.target.value);
                  setDirty(true);
                }}
                placeholder="Working directory (optional)"
                disabled={!canMutate || state.isPending}
              />
              <CatalogCredentialFields
                label="Environment variable"
                entries={env}
                onChange={(next) => {
                  setEnv(next);
                  setDirty(true);
                }}
              />
            </>
          ) : (
            <>
              <CatalogCredentialFields
                label="HTTP header"
                entries={headers}
                onChange={(next) => {
                  setHeaders(next);
                  setDirty(true);
                }}
              />
              <select
                aria-label="Project MCP authorization"
                value={authorization}
                onChange={(event) => {
                  setAuthorization(event.target.value as "none" | "oauth");
                  setDirty(true);
                }}
                disabled={!canMutate || state.isPending}
              >
                <option value="none">No authorization</option>
                <option value="oauth">OAuth</option>
              </select>
              {authorization === "oauth" ? (
                <>
                  <select
                    aria-label="Project MCP OAuth registration"
                    value={oauthRegistration}
                    onChange={(event) => {
                      setOauthRegistration(event.target.value as "automatic" | "pre-registered");
                      setDirty(true);
                    }}
                    disabled={!canMutate || state.isPending}
                  >
                    <option value="automatic">Automatic OAuth registration</option>
                    <option value="pre-registered">Pre-registered OAuth client</option>
                  </select>
                  {oauthRegistration === "pre-registered" ? (
                    <>
                      <Input
                        aria-label="Project MCP OAuth client ID"
                        value={oauthClientId}
                        onChange={(event) => {
                          setOauthClientId(event.target.value);
                          setDirty(true);
                        }}
                        placeholder="OAuth client ID"
                        disabled={!canMutate || state.isPending}
                      />
                      <CatalogCredentialFields
                        label="OAuth client secret"
                        entries={[oauthClientSecret]}
                        onChange={(next) => {
                          setOauthClientSecret(
                            next[0] ?? newCatalogCredential({ name: "OAuth client secret" }),
                          );
                          setDirty(true);
                        }}
                      />
                    </>
                  ) : null}
                </>
              ) : null}
            </>
          )}
          <fieldset
            className="flex flex-wrap gap-2 text-xs"
            disabled={!canMutate || state.isPending}
          >
            <legend className="sr-only">Project MCP providers</legend>
            {providerEntries.map((entry) => {
              const id = entry.instanceId as ProviderInstanceId;
              return (
                <label key={entry.instanceId} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={selectedProviders.includes(id)}
                    onChange={(event) =>
                      setSelectedProviders(
                        event.target.checked
                          ? [...selectedProviders, id]
                          : selectedProviders.filter((item) => item !== id),
                      )
                    }
                  />
                  {entry.displayName}
                </label>
              );
            })}
            {unavailableProviderIds.map((id) => (
              <label key={id} className="flex items-center gap-1 text-muted-foreground">
                <input
                  type="checkbox"
                  checked
                  aria-label={`Select unavailable provider ${id}`}
                  onChange={() =>
                    setSelectedProviders(selectedProviders.filter((item) => item !== id))
                  }
                />
                {id} (Unavailable)
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Project MCP enabled"
              checked={enabled}
              onChange={(event) => {
                setEnabled(event.target.checked);
                setDirty(true);
              }}
              disabled={!canMutate || state.isPending}
            />
            Enabled
          </label>
          <Button
            size="sm"
            onClick={() => void add()}
            disabled={
              !canMutate ||
              !draft.name.trim() ||
              (transportType === "stdio" ? !command.trim() : !draft.url.trim()) ||
              state.isPending
            }
          >
            {editingOverrideId ? "Save override" : editingId ? "Save local" : "Add local"}
          </Button>
          {editingId ? (
            <Button type="button" size="sm" variant="ghost" onClick={resetDraft}>
              Cancel
            </Button>
          ) : null}
          {editingOverrideId ? (
            <Button type="button" size="sm" variant="ghost" onClick={resetDraft}>
              Cancel override
            </Button>
          ) : null}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {local.length > 0 ? (
          <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
            {local.map((entry) => (
              <li key={entry.definitionId} className="flex items-center justify-between gap-2">
                <span>
                  {entry.name}
                  {entry.enabled ? "" : " (disabled)"}
                </span>
                <span className="flex gap-1">
                  <Button
                    size="xs"
                    type="button"
                    variant="ghost"
                    onClick={() => void toggleLocal(entry)}
                    disabled={!canMutate || state.isPending}
                  >
                    {entry.enabled ? "Disable" : "Enable"}
                  </Button>
                  {entry.transport.type !== "stdio" &&
                  entry.transport.authorization.type === "oauth" ? (
                    <>
                      <Button
                        size="xs"
                        type="button"
                        variant="ghost"
                        onClick={() => void catalogOauth("begin", entry)}
                        disabled={!canMutate || state.isPending}
                      >
                        Connect OAuth
                      </Button>
                      <Button
                        size="xs"
                        type="button"
                        variant="ghost"
                        onClick={() => void catalogOauth("continue", entry)}
                        disabled={!canMutate || state.isPending}
                      >
                        Continue OAuth
                      </Button>
                      <Button
                        size="xs"
                        type="button"
                        variant="ghost"
                        onClick={() => void catalogOauth("disconnect", entry)}
                        disabled={!canMutate || state.isPending}
                      >
                        Disconnect OAuth
                      </Button>
                    </>
                  ) : null}
                  <Button
                    size="xs"
                    type="button"
                    variant="ghost"
                    onClick={() => void editLocal(entry)}
                    disabled={!canMutate || state.isPending}
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    type="button"
                    variant="ghost"
                    onClick={() => void removeLocal(entry)}
                    disabled={!canMutate || state.isPending}
                  >
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {overrides.length > 0 ? (
          <div className="mt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Project overrides
            </p>
            <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
              {overrides.map((entry) => {
                const target = inherited.find(
                  (definition) => definition.logicalServerId === entry.targetId,
                );
                const effectiveTransport = entry.transport ?? target?.transport;
                const oauthDefinitionId = entry.transportDefinitionId ?? target?.definitionId;
                const oauthDefinition =
                  effectiveTransport &&
                  effectiveTransport.type !== "stdio" &&
                  effectiveTransport.authorization.type === "oauth" &&
                  oauthDefinitionId !== undefined
                    ? {
                        logicalServerId: entry.targetId,
                        definitionId: oauthDefinitionId,
                      }
                    : null;
                return (
                  <li key={entry.id} className="flex items-center justify-between gap-2">
                    <span>
                      {entry.name ?? entry.targetId}
                      {entry.enabled === false ? " (disabled)" : ""}
                    </span>
                    {canOverride ? (
                      <span className="flex gap-1">
                        {oauthDefinition?.definitionId ? (
                          <>
                            <Button
                              size="xs"
                              type="button"
                              variant="ghost"
                              onClick={() => void catalogOauth("begin", oauthDefinition)}
                              disabled={!canMutate || state.isPending}
                            >
                              Connect OAuth
                            </Button>
                            <Button
                              size="xs"
                              type="button"
                              variant="ghost"
                              onClick={() => void catalogOauth("continue", oauthDefinition)}
                              disabled={!canMutate || state.isPending}
                            >
                              Continue OAuth
                            </Button>
                            <Button
                              size="xs"
                              type="button"
                              variant="ghost"
                              onClick={() => void catalogOauth("disconnect", oauthDefinition)}
                              disabled={!canMutate || state.isPending}
                            >
                              Disconnect OAuth
                            </Button>
                          </>
                        ) : null}
                        <Button
                          size="xs"
                          type="button"
                          variant="ghost"
                          onClick={() => editOverride(entry)}
                          disabled={!canMutate || state.isPending}
                        >
                          Edit override
                        </Button>
                        <Button
                          size="xs"
                          type="button"
                          variant="ghost"
                          onClick={() => void removeOverride(entry)}
                          disabled={!canMutate || state.isPending}
                        >
                          Remove override
                        </Button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {dirty ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Unsaved draft preserved while the catalog refreshes.
          </p>
        ) : null}
        {authorizationLink ? (
          <a
            href={authorizationLink.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm underline"
          >
            Open OAuth authorization
          </a>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
