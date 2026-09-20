import { useAtomCommand } from "../state/use-atom-command";
import { useAtomValue } from "@effect/atom-react";
import { useEnvironmentQuery } from "../state/query";
import { mcpCatalogEnvironment } from "../state/projects";
import { Atom } from "effect/unstable/reactivity";
import {
  ProjectMcpEnvironmentVariableName,
  ProjectMcpHeaderName,
  parseProjectMcpOAuthAuthorizationUrl,
} from "@t3tools/contracts";
import type {
  EnvironmentId,
  McpCatalogDefinition,
  McpCatalogSessionId,
  McpServerId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ProjectMcpTransportDraft,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  CatalogCredentialFields,
  newCatalogCredential,
  retainedCatalogCredential,
  type CatalogCredentialDraft,
} from "./settings/McpCatalogSettings";

const EMPTY_CATALOG_CHANGES = Atom.make(null);

/** New session definitions always inherit the owning provider instance. */
export const defaultMcpCatalogProvider = (
  providerInstanceId: ProviderInstanceId,
): ReadonlyArray<ProviderInstanceId> => [providerInstanceId];

/** Inspect the desired/applied session catalog without leaving the chat. */
export function ThreadMcpCatalogDialog({
  environmentId,
  projectId = null,
  threadId,
  mcpCatalogSessionId,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId?: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly mcpCatalogSessionId: McpCatalogSessionId | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const changesAtom = useMemo(
    () =>
      environmentId
        ? mcpCatalogEnvironment.changes({ environmentId, input: { catalog: true } })
        : null,
    [environmentId],
  );
  // Cross-device catalog edits should update the open dialog and its
  // optimistic revision before the next mutation is sent.
  useAtomValue(changesAtom ?? EMPTY_CATALOG_CHANGES);
  const query = useEnvironmentQuery(
    mcpCatalogSessionId && environmentId && threadId
      ? mcpCatalogEnvironment.sessionGet({
          environmentId,
          input: { threadId, mcpCatalogSessionId },
        })
      : null,
  );
  const reset = useAtomCommand(mcpCatalogEnvironment.sessionReset, { reportFailure: false });
  const create = useAtomCommand(mcpCatalogEnvironment.sessionCreate, { reportFailure: false });
  const update = useAtomCommand(mcpCatalogEnvironment.sessionUpdate, { reportFailure: false });
  const remove = useAtomCommand(mcpCatalogEnvironment.sessionRemove, { reportFailure: false });
  const oauthBegin = useAtomCommand(mcpCatalogEnvironment.oauthBegin, { reportFailure: false });
  const oauthContinue = useAtomCommand(mcpCatalogEnvironment.oauthContinue, {
    reportFailure: false,
  });
  const oauthDisconnect = useAtomCommand(mcpCatalogEnvironment.oauthDisconnect, {
    reportFailure: false,
  });
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
    newCatalogCredential({ name: "OAuth client secret" }),
  );
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<McpServerId | null>(null);
  const [authorizationLink, setAuthorizationLink] = useState<{
    readonly definitionId: string;
    readonly url: string;
  } | null>(null);
  const desiredRevision = useRef(0);
  const nextArgumentKey = useRef(0);
  const session = query.data;
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
      url: url.trim(),
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
  useEffect(() => {
    if (session) desiredRevision.current = session.desiredRevision;
  }, [session]);
  const editDefinition = (definition: McpCatalogDefinition) => {
    const transport = definition.transport;
    setEditingId(definition.logicalServerId);
    setName(definition.name);
    setEnabled(definition.enabled);
    setUrl(transport.type === "stdio" ? "" : transport.url);
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
    setError(null);
    setAuthorizationLink(null);
  };
  const mutate = async () => {
    if (!session || !environmentId || !threadId || !mcpCatalogSessionId) return;
    const isStdio = transportType === "stdio";
    if (!name.trim()) {
      setError("A server name is required.");
      return;
    }
    if (isStdio ? !command.trim() : !url.trim()) {
      setError(isStdio ? "A command is required." : "A URL is required.");
      return;
    }
    setError(null);
    const input = {
      environmentId,
      input: {
        scope: "session" as const,
        scopeId: mcpCatalogSessionId,
        threadId,
        mcpCatalogSessionId,
        expectedRevision: desiredRevision.current,
        logicalServerId: editingId ?? undefined,
        definition: {
          name: name.trim(),
          enabled,
          providerInstanceIds:
            editingId === null
              ? defaultMcpCatalogProvider(session.providerInstanceId)
              : (session.desired.find((definition) => definition.logicalServerId === editingId)
                  ?.providerInstanceIds ?? defaultMcpCatalogProvider(session.providerInstanceId)),
          transport: buildTransport(),
        },
      },
    };
    const result = editingId
      ? await update({ ...input, input: { ...input.input, logicalServerId: editingId } })
      : await create(input);
    if (result._tag === "Success") {
      desiredRevision.current = result.value.desiredRevision;
      setName("");
      setEnabled(true);
      setUrl("");
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
      setEditingId(null);
      setAuthorizationLink(null);
      query.refresh();
    } else
      setError(
        editingId
          ? "Could not edit the thread MCP catalog."
          : "Could not add to the thread MCP catalog.",
      );
  };
  const toggle = async (definition: McpCatalogDefinition) => {
    if (!session || !environmentId || !threadId || !mcpCatalogSessionId) return;
    const result = await update({
      environmentId,
      input: {
        scope: "session",
        scopeId: mcpCatalogSessionId,
        threadId,
        mcpCatalogSessionId,
        expectedRevision: desiredRevision.current,
        logicalServerId: definition.logicalServerId,
        definition: {
          name: definition.name,
          enabled: !definition.enabled,
          providerInstanceIds: definition.providerInstanceIds,
          transport: definition.transport,
        },
      },
    });
    if (result._tag === "Success") {
      desiredRevision.current = result.value.desiredRevision;
      query.refresh();
    } else setError("Could not update the thread MCP catalog.");
  };
  const removeDefinition = async (definition: McpCatalogDefinition) => {
    if (!session || !environmentId || !threadId || !mcpCatalogSessionId) return;
    const result = await remove({
      environmentId,
      input: {
        scope: "session",
        scopeId: mcpCatalogSessionId,
        threadId,
        mcpCatalogSessionId,
        expectedRevision: desiredRevision.current,
        logicalServerId: definition.logicalServerId,
      },
    });
    if (result._tag === "Success") {
      desiredRevision.current = result.value.desiredRevision;
      query.refresh();
    } else setError("Could not remove the thread MCP catalog entry.");
  };
  const oauthTarget = (definition: McpCatalogDefinition) =>
    projectId && threadId && mcpCatalogSessionId
      ? {
          projectId,
          logicalServerId: definition.logicalServerId,
          transportDefinitionId: definition.definitionId,
          threadId,
          mcpCatalogSessionId,
        }
      : null;
  const beginOAuth = async (definition: McpCatalogDefinition) => {
    const target = oauthTarget(definition);
    if (!target || !environmentId) {
      setError("This environment did not provide the project for OAuth.");
      return;
    }
    setAuthorizationLink(null);
    const result = await oauthBegin({ environmentId, input: target });
    if (result._tag === "Failure") {
      setError("Could not start MCP OAuth.");
      return;
    }
    const url = parseProjectMcpOAuthAuthorizationUrl(result.value.authorizationUrl);
    if (url === undefined) setError("OAuth returned an unsafe authorization URL.");
    else setAuthorizationLink({ definitionId: definition.definitionId, url });
  };
  const continueOAuth = async (definition: McpCatalogDefinition) => {
    const target = oauthTarget(definition);
    if (!target || !environmentId) return;
    setAuthorizationLink(null);
    const result = await oauthContinue({ environmentId, input: target });
    if (result._tag === "Failure") {
      setError("Could not continue MCP OAuth.");
      return;
    }
    const url = parseProjectMcpOAuthAuthorizationUrl(result.value.authorizationUrl);
    if (url === undefined) setError("OAuth returned an unsafe authorization URL.");
    else setAuthorizationLink({ definitionId: definition.definitionId, url });
  };
  const disconnectOAuth = async (definition: McpCatalogDefinition) => {
    const target = oauthTarget(definition);
    if (!target || !environmentId) return;
    const result = await oauthDisconnect({ environmentId, input: target });
    if (result._tag === "Failure") setError("Could not disconnect MCP OAuth.");
    else setAuthorizationLink(null);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Thread MCP catalog</DialogTitle>
          <DialogDescription>
            Review the desired catalog and the last provider application.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {!mcpCatalogSessionId ? (
            <p className="text-sm text-muted-foreground">This thread has no MCP catalog session.</p>
          ) : null}
          {session ? (
            <>
              <p className="text-sm">
                Desired revision {session.desiredRevision} · applied revision{" "}
                {session.appliedRevision}
              </p>
              <p className="text-sm text-muted-foreground">
                Baseline {session.baseline.length} · desired {session.desired.length} · applied{" "}
                {session.applied.length}
              </p>
              <p className="text-sm text-muted-foreground">
                {session.desired.length} desired server(s)
              </p>
              {session.application?.status === "failed" ? (
                <p className="text-sm text-destructive">{session.application.reason}</p>
              ) : null}
              {session.application?.status === "applied" ? (
                <p className="text-sm text-success">Catalog applied.</p>
              ) : null}
              {session.desired.map((definition) => (
                <div
                  key={definition.logicalServerId}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span>
                    {definition.name}
                    {definition.enabled ? "" : " (disabled)"}
                  </span>
                  <span className="flex gap-1">
                    <Button size="xs" variant="ghost" onClick={() => editDefinition(definition)}>
                      Edit
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => void toggle(definition)}>
                      {definition.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void removeDefinition(definition)}
                    >
                      Remove
                    </Button>
                    {definition.transport.type !== "stdio" &&
                    definition.transport.authorization.type === "oauth" ? (
                      <>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => void beginOAuth(definition)}
                        >
                          Connect OAuth
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => void continueOAuth(definition)}
                        >
                          Continue OAuth
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => void disconnectOAuth(definition)}
                        >
                          Disconnect OAuth
                        </Button>
                      </>
                    ) : null}
                  </span>
                </div>
              ))}
              <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
                <Input
                  aria-label="Session MCP server name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Name"
                />
                <Input
                  aria-label="Session MCP server URL"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com/mcp"
                  disabled={transportType === "stdio"}
                />
                <select
                  aria-label="Session MCP transport type"
                  value={transportType}
                  onChange={(event) =>
                    setTransportType(
                      event.target.value as "streamable-http" | "legacy-sse" | "stdio",
                    )
                  }
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  <option value="streamable-http">Streamable HTTP</option>
                  <option value="legacy-sse">Legacy SSE</option>
                  <option value="stdio">Local command (stdio)</option>
                </select>
                {transportType === "stdio" ? (
                  <>
                    <Input
                      aria-label="Session MCP command"
                      value={command}
                      onChange={(event) => setCommand(event.target.value)}
                      placeholder="Command"
                    />
                    <fieldset className="grid gap-2">
                      <legend className="text-sm font-medium">Arguments</legend>
                      {args.map((argument, index) => (
                        <div key={argument.key} className="flex items-center gap-2">
                          <Input
                            aria-label={`Session MCP argument ${index + 1}`}
                            value={argument.value}
                            onChange={(event) =>
                              setArgs(
                                args.map((current) =>
                                  current.key === argument.key
                                    ? { ...current, value: event.target.value }
                                    : current,
                                ),
                              )
                            }
                          />
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            aria-label={`Remove session argument ${index + 1}`}
                            onClick={() =>
                              setArgs(args.filter((current) => current.key !== argument.key))
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          setArgs([...args, { key: nextArgumentKey.current++, value: "" }])
                        }
                      >
                        Add argument
                      </Button>
                    </fieldset>
                    <Input
                      aria-label="Session MCP working directory"
                      value={cwd}
                      onChange={(event) => setCwd(event.target.value)}
                      placeholder="Working directory (optional)"
                    />
                    <CatalogCredentialFields
                      label="Environment variable"
                      entries={env}
                      onChange={setEnv}
                    />
                  </>
                ) : (
                  <>
                    <CatalogCredentialFields
                      label="HTTP header"
                      entries={headers}
                      onChange={setHeaders}
                    />
                    <select
                      aria-label="Session MCP authorization"
                      value={authorization}
                      onChange={(event) => setAuthorization(event.target.value as "none" | "oauth")}
                    >
                      <option value="none">No authorization</option>
                      <option value="oauth">OAuth</option>
                    </select>
                    {authorization === "oauth" ? (
                      <>
                        <select
                          aria-label="Session MCP OAuth registration"
                          value={oauthRegistration}
                          onChange={(event) =>
                            setOauthRegistration(
                              event.target.value as "automatic" | "pre-registered",
                            )
                          }
                        >
                          <option value="automatic">Automatic OAuth registration</option>
                          <option value="pre-registered">Pre-registered OAuth client</option>
                        </select>
                        {oauthRegistration === "pre-registered" ? (
                          <>
                            <Input
                              aria-label="Session MCP OAuth client ID"
                              value={oauthClientId}
                              onChange={(event) => setOauthClientId(event.target.value)}
                              placeholder="OAuth client ID"
                            />
                            <CatalogCredentialFields
                              label="OAuth client secret"
                              entries={[oauthClientSecret]}
                              onChange={(next) =>
                                setOauthClientSecret(
                                  next[0] ?? newCatalogCredential({ name: "OAuth client secret" }),
                                )
                              }
                            />
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label="Session MCP enabled"
                    checked={enabled}
                    onChange={(event) => setEnabled(event.target.checked)}
                  />
                  Enabled
                </label>
                <Button size="sm" onClick={() => void mutate()} disabled={!session}>
                  {editingId ? "Save changes" : "Add"}
                </Button>
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
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
            </>
          ) : query.error ? (
            <p className="text-sm text-destructive">{query.error}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          {session && mcpCatalogSessionId && environmentId && threadId ? (
            <Button
              onClick={() => {
                void reset({
                  environmentId,
                  input: {
                    threadId,
                    mcpCatalogSessionId,
                    expectedRevision: desiredRevision.current,
                  },
                }).then((result) => {
                  if (result._tag === "Success") {
                    desiredRevision.current = result.value.desiredRevision;
                    query.refresh();
                  } else {
                    setError("Could not reset the thread MCP catalog.");
                  }
                });
              }}
              disabled={query.isPending}
            >
              Reset to current defaults
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
