import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  ProjectId,
  ProjectMcpApplicationMode,
  ProjectMcpCredentialId,
  ProjectMcpEnvironmentVariableName,
  ProjectMcpHeaderName,
  ProjectMcpManagedServer,
  ProjectMcpServer,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import type { ProjectMcpTransportDraft } from "@t3tools/contracts";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { projectMcpEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type CatalogEntry = ProjectMcpServer | ProjectMcpManagedServer;

interface ProjectMcpDraft {
  readonly name: string;
  readonly transportType: "streamable-http" | "legacy-sse" | "stdio" | "legacy-url";
  readonly url: string;
  readonly command: string;
  readonly args: ReadonlyArray<{ readonly key: number; readonly value: string }>;
  readonly cwd: string;
  readonly headers: ReadonlyArray<ProjectMcpCredentialDraft>;
  readonly env: ReadonlyArray<ProjectMcpCredentialDraft>;
  readonly authorization: "none" | "oauth";
  readonly oauthRegistration: "automatic" | "pre-registered";
  readonly oauthClientId: string;
  readonly oauthClientSecret: ProjectMcpCredentialDraft;
  readonly enabled: boolean;
  readonly providerInstanceIds: ReadonlyArray<ProviderInstanceId>;
}

interface ProjectMcpCredentialDraft {
  readonly key: number;
  readonly id?: ProjectMcpCredentialId;
  readonly name: string;
  readonly value: string;
}

type ProjectMcpFieldErrors = Partial<Record<"name" | "url" | "command", string>>;

let nextCredentialKey = 0;

const EMPTY_DRAFT: ProjectMcpDraft = {
  name: "",
  transportType: "streamable-http",
  url: "",
  command: "",
  args: [],
  cwd: "",
  headers: [credentialDraft()],
  env: [credentialDraft()],
  authorization: "none",
  oauthRegistration: "automatic",
  oauthClientId: "",
  oauthClientSecret: { ...credentialDraft(), name: "OAuth client secret" },
  enabled: true,
  providerInstanceIds: [],
};

function credentialDraft(credential?: {
  readonly id: ProjectMcpCredentialId;
  readonly name: string;
}): ProjectMcpCredentialDraft {
  const key = nextCredentialKey++;
  return credential
    ? { key, id: credential.id, name: credential.name, value: "" }
    : { key, name: "", value: "" };
}

function credentialInput(credential: ProjectMcpCredentialDraft): {
  readonly id?: ProjectMcpCredentialId;
  readonly name: string;
  readonly value?: string;
} {
  return credential.id && credential.value === ""
    ? { id: credential.id, name: credential.name }
    : { name: credential.name, value: credential.value };
}

export function applicationLabel(mode: ProjectMcpApplicationMode): string {
  switch (mode) {
    case "active-session":
      return "Applies to this session";
    case "next-session":
      return "Applies to new sessions";
    case "unsupported":
      return "Not supported by this provider";
    case "unavailable":
      return "Provider unavailable";
  }
}

export function canEdit(entry: CatalogEntry): entry is ProjectMcpServer {
  return "enabled" in entry;
}

function hostForUrl(url: string): string {
  return new URL(url).host;
}

function ProjectMcpEntryDetails({
  entry,
  applications,
  providerNameForId,
}: {
  readonly entry: CatalogEntry;
  readonly applications: ReadonlyArray<{
    readonly providerInstanceId: ProviderInstanceId;
    readonly mode: ProjectMcpApplicationMode;
    readonly reason?: string | undefined;
  }>;
  readonly providerNameForId: (providerInstanceId: ProviderInstanceId) => string;
}) {
  const providers = entry.providerInstanceIds.map(providerNameForId);
  return (
    <div className="grid gap-1.5 pt-2 text-xs text-muted-foreground">
      <p>Providers: {providers.length > 0 ? providers.join(", ") : "None selected"}</p>
      {applications.length > 0 ? (
        <ul className="grid gap-1">
          {applications.map((application) => (
            <li key={application.providerInstanceId}>
              {providerNameForId(application.providerInstanceId)} ·{" "}
              {applicationLabel(application.mode)}
              {application.reason ? ` (${application.reason})` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {"oauthStatus" in entry && entry.oauthStatus ? (
        <p>OAuth: {entry.oauthStatus === "connected" ? "Connected" : entry.oauthStatus}</p>
      ) : null}
    </div>
  );
}

function CredentialFields({
  label,
  entries,
  onChange,
}: {
  readonly label: string;
  readonly entries: ReadonlyArray<ProjectMcpCredentialDraft>;
  readonly onChange: (entries: ReadonlyArray<ProjectMcpCredentialDraft>) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">Credentials</legend>
      {entries.map((entry, index) => (
        <div key={entry.key} className="grid gap-1.5">
          <Input
            aria-label={`${label} name ${index + 1}`}
            placeholder={`${label} name`}
            value={entry.name}
            onChange={(event) =>
              onChange(
                entries.map((current, i) =>
                  i === index ? { ...current, name: event.target.value } : current,
                ),
              )
            }
          />
          <Input
            aria-label={`${label} value ${index + 1}`}
            type="password"
            placeholder={entry.id ? "Retained secret (leave blank to keep)" : `${label} value`}
            value={entry.value}
            onChange={(event) =>
              onChange(
                entries.map((current, i) =>
                  i === index ? { ...current, value: event.target.value } : current,
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
            onClick={() => onChange(entries.filter((_, i) => i !== index))}
          >
            Remove credential
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => onChange([...entries, credentialDraft()])}
      >
        Add credential
      </Button>
    </fieldset>
  );
}

function ScopedProjectMcpCatalogSettings({
  environmentId,
  projectId,
  providers,
  canMutate,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly canMutate: boolean;
}) {
  const catalog = useEnvironmentQuery(
    projectMcpEnvironment.catalog({ environmentId, input: { projectId } }),
  );
  const createEntry = useAtomCommand(projectMcpEnvironment.create, { reportFailure: false });
  const updateEntry = useAtomCommand(projectMcpEnvironment.update, { reportFailure: false });
  const removeEntry = useAtomCommand(projectMcpEnvironment.remove, { reportFailure: false });
  const oauthBegin = useAtomCommand(projectMcpEnvironment.oauthBegin, { reportFailure: false });
  const oauthContinue = useAtomCommand(projectMcpEnvironment.oauthContinue, {
    reportFailure: false,
  });
  const oauthDisconnect = useAtomCommand(projectMcpEnvironment.oauthDisconnect, {
    reportFailure: false,
  });
  useEffect(() => {
    const refreshOnFocus = () => catalog.refresh();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [catalog]);
  const providerEntries = useMemo(() => deriveProviderInstanceEntries(providers), [providers]);
  const providerNameById = useMemo(
    () =>
      new Map(
        providerEntries.map((provider) => [provider.instanceId, provider.displayName] as const),
      ),
    [providerEntries],
  );
  const providerNameForId = useCallback(
    (providerInstanceId: ProviderInstanceId) =>
      providerNameById.get(providerInstanceId) ?? providerInstanceId,
    [providerNameById],
  );
  const [editing, setEditing] = useState<ProjectMcpServer | null>(null);
  const [draft, setDraft] = useState<ProjectMcpDraft | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ProjectMcpFieldErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [removalTarget, setRemovalTarget] = useState<ProjectMcpServer | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const commandInputRef = useRef<HTMLInputElement>(null);
  const nextArgumentKey = useRef(0);

  const openCreate = useCallback(() => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setFieldErrors({});
  }, []);
  const openEdit = useCallback((entry: ProjectMcpServer) => {
    setEditing(entry);
    const transport = entry.transport;
    setDraft({
      name: entry.name,
      transportType: transport?.type ?? "legacy-url",
      url: entry.url ?? (transport?.type === "stdio" ? "" : (transport?.url ?? "")),
      command: transport?.type === "stdio" ? transport.command : "",
      args:
        transport?.type === "stdio"
          ? transport.args.map((value) => ({ key: nextArgumentKey.current++, value }))
          : [],
      cwd: transport?.type === "stdio" ? (transport.cwd ?? "") : "",
      headers:
        transport?.type === "streamable-http" || transport?.type === "legacy-sse"
          ? transport.headers.map((header) => ({
              ...credentialDraft(header.credential),
              name: header.name,
            }))
          : [credentialDraft()],
      env:
        transport?.type === "stdio"
          ? transport.env.map((variable) => ({
              ...credentialDraft(variable.credential),
              name: variable.name,
            }))
          : [credentialDraft()],
      authorization:
        transport?.type === "streamable-http" || transport?.type === "legacy-sse"
          ? transport.authorization.type
          : "none",
      oauthRegistration:
        transport?.type === "streamable-http" || transport?.type === "legacy-sse"
          ? transport.authorization.type === "oauth"
            ? transport.authorization.registration.type
            : "automatic"
          : "automatic",
      oauthClientId:
        transport?.type === "streamable-http" || transport?.type === "legacy-sse"
          ? transport.authorization.type === "oauth" &&
            transport.authorization.registration.type === "pre-registered"
            ? transport.authorization.registration.clientId
            : ""
          : "",
      oauthClientSecret:
        transport?.type === "streamable-http" || transport?.type === "legacy-sse"
          ? transport.authorization.type === "oauth" &&
            transport.authorization.registration.type === "pre-registered"
            ? {
                ...credentialDraft(transport.authorization.registration.clientSecret),
                name: "OAuth client secret",
              }
            : { ...credentialDraft(), name: "OAuth client secret" }
          : { ...credentialDraft(), name: "OAuth client secret" },
      enabled: entry.enabled,
      providerInstanceIds: entry.providerInstanceIds,
    });
    setFieldErrors({});
  }, []);
  const closeForm = useCallback(() => {
    setDraft(null);
    setEditing(null);
    setFieldErrors({});
  }, []);
  const reportFailure = useCallback(<A, E>(title: string, result: AtomCommandResult<A, E>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);
  const save = useCallback(async () => {
    if (!draft || isSaving || !canMutate) return;
    const name = draft.name.trim();
    const url = draft.url.trim();
    const isStdio = draft.transportType === "stdio";
    const preserveLegacyUrl =
      draft.transportType === "legacy-url" &&
      draft.authorization === "none" &&
      draft.headers.every(
        (credential) => !credential.name.trim() || (credential.value === "" && !credential.id),
      );
    const httpTransportType =
      draft.transportType === "legacy-url" ? "streamable-http" : draft.transportType;
    const errors: ProjectMcpFieldErrors = {
      ...(!name ? { name: "Name is required." } : {}),
      ...(!isStdio && !url ? { url: "URL is required." } : {}),
      ...(isStdio && !draft.command.trim() ? { command: "Command is required." } : {}),
    };
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      if (errors.name) nameInputRef.current?.focus();
      else if (errors.url) urlInputRef.current?.focus();
      else commandInputRef.current?.focus();
      return;
    }

    setIsSaving(true);
    try {
      const input = {
        projectId,
        name,
        enabled: draft.enabled,
        providerInstanceIds: draft.providerInstanceIds,
        ...(preserveLegacyUrl
          ? { url }
          : {
              transport: (isStdio
                ? {
                    type: "stdio" as const,
                    command: draft.command.trim(),
                    args: draft.args.map((argument) => argument.value),
                    ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
                    env: draft.env
                      .filter(
                        (credential) =>
                          credential.name.trim() && (credential.value !== "" || credential.id),
                      )
                      .map((credential) => ({
                        name: ProjectMcpEnvironmentVariableName.make(credential.name.trim()),
                        credential: credentialInput(credential),
                      })),
                  }
                : {
                    type: httpTransportType as "streamable-http" | "legacy-sse",
                    url,
                    headers: draft.headers
                      .filter(
                        (credential) =>
                          credential.name.trim() && (credential.value !== "" || credential.id),
                      )
                      .map((credential) => ({
                        name: ProjectMcpHeaderName.make(credential.name.trim()),
                        credential: credentialInput(credential),
                      })),
                    authorization:
                      draft.authorization === "oauth"
                        ? {
                            type: "oauth" as const,
                            registration:
                              draft.oauthRegistration === "automatic"
                                ? { type: "automatic" as const }
                                : {
                                    type: "pre-registered" as const,
                                    clientId: draft.oauthClientId.trim(),
                                    ...(draft.oauthClientSecret.value || draft.oauthClientSecret.id
                                      ? {
                                          clientSecret: credentialInput(draft.oauthClientSecret),
                                        }
                                      : {}),
                                  },
                          }
                        : { type: "none" as const },
                  }) as ProjectMcpTransportDraft,
            }),
      };
      if (editing) {
        const result = await updateEntry({
          environmentId,
          input: { ...input, id: editing.id },
        });
        if (result._tag === "Success") {
          closeForm();
          catalog.refresh();
          return;
        }
        reportFailure("Failed to update MCP server", result);
      } else {
        const result = await createEntry({ environmentId, input });
        if (result._tag === "Success") {
          closeForm();
          catalog.refresh();
          return;
        }
        reportFailure("Failed to add MCP server", result);
      }
    } finally {
      setIsSaving(false);
    }
  }, [
    catalog,
    canMutate,
    closeForm,
    createEntry,
    draft,
    editing,
    environmentId,
    isSaving,
    projectId,
    reportFailure,
    updateEntry,
  ]);
  const updateExisting = useCallback(
    async (entry: ProjectMcpServer, enabled: boolean) => {
      if (isSaving || !canMutate) return;
      setIsSaving(true);
      try {
        const result = await updateEntry({
          environmentId,
          input: {
            projectId,
            id: entry.id,
            patch: "enabled",
            enabled,
          },
        });
        if (result._tag === "Success") {
          catalog.refresh();
          return;
        }
        reportFailure("Failed to update MCP server", result);
      } finally {
        setIsSaving(false);
      }
    },
    [canMutate, catalog, environmentId, isSaving, projectId, reportFailure, updateEntry],
  );
  const connectOAuth = useCallback(
    async (entry: ProjectMcpServer) => {
      const result = await oauthBegin({ environmentId, input: { projectId, id: entry.id } });
      if (result._tag === "Success") {
        catalog.refresh();
        window.open(result.value.authorizationUrl, "_blank", "noopener,noreferrer");
      } else {
        reportFailure("Failed to connect MCP OAuth", result);
      }
    },
    [catalog, environmentId, oauthBegin, projectId, reportFailure],
  );
  const disconnectOAuth = useCallback(
    async (entry: ProjectMcpServer) => {
      const result = await oauthDisconnect({ environmentId, input: { projectId, id: entry.id } });
      if (result._tag === "Success") catalog.refresh();
      else reportFailure("Failed to disconnect MCP OAuth", result);
    },
    [catalog, environmentId, oauthDisconnect, projectId, reportFailure],
  );
  const continueOAuth = useCallback(
    async (entry: ProjectMcpServer) => {
      const result = await oauthContinue({ environmentId, input: { projectId, id: entry.id } });
      if (result._tag === "Success") {
        catalog.refresh();
        window.open(result.value.authorizationUrl, "_blank", "noopener,noreferrer");
      } else {
        reportFailure("Failed to continue MCP OAuth", result);
      }
    },
    [catalog, environmentId, oauthContinue, projectId, reportFailure],
  );
  const removeExisting = useCallback(
    async (entry: ProjectMcpServer) => {
      if (isSaving || !canMutate) return false;
      setIsSaving(true);
      try {
        const result = await removeEntry({ environmentId, input: { projectId, id: entry.id } });
        if (result._tag === "Success") {
          catalog.refresh();
          return true;
        }
        reportFailure("Failed to remove MCP server", result);
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [canMutate, catalog, environmentId, isSaving, projectId, removeEntry, reportFailure],
  );
  const confirmRemoval = useCallback(async () => {
    if (removalTarget === null) return;
    if (await removeExisting(removalTarget)) {
      setRemovalTarget(null);
    }
  }, [removalTarget, removeExisting]);

  const entries: ReadonlyArray<CatalogEntry> = [
    ...(catalog.data?.external ?? []),
    ...(catalog.data?.managed ?? []),
  ];
  const currentEditing =
    editing === null
      ? null
      : (catalog.data?.external.find((entry) => entry.id === editing.id) ?? editing);
  const unavailableProviderIds =
    draft?.providerInstanceIds.filter(
      (providerInstanceId) => !providerNameById.has(providerInstanceId),
    ) ?? [];

  return (
    <SettingsSection
      title="MCP servers"
      headerAction={
        <Button
          size="xs"
          variant="outline"
          type="button"
          disabled={!canMutate}
          onClick={openCreate}
        >
          <PlusIcon className="size-3.5" />
          Add server
        </Button>
      }
    >
      <p className="px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        Servers apply only to this checkout. Provider support is shown for each configured server.
      </p>
      {catalog.error ? (
        <SettingsRow
          title="Could not load MCP servers"
          description={catalog.error}
          control={
            <Button size="xs" variant="outline" type="button" onClick={catalog.refresh}>
              Retry
            </Button>
          }
        />
      ) : null}
      {catalog.isPending && catalog.data === null ? (
        <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">Loading MCP servers…</p>
      ) : null}
      {catalog.data !== null && entries.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
          No MCP servers configured for this checkout.
        </p>
      ) : null}
      {entries.map((entry) => {
        const editable = canEdit(entry);
        const applications = (catalog.data?.applications ?? []).filter(
          (application) => application.serverId === entry.id,
        );
        return (
          <SettingsRow
            key={entry.id}
            title={entry.name}
            description={
              editable
                ? (entry.url ??
                  (entry.transport?.type === "stdio"
                    ? `stdio: ${entry.transport.command}`
                    : hostForUrl(entry.transport?.url ?? "")))
                : hostForUrl(entry.url)
            }
            status={editable ? (entry.enabled ? "Enabled" : "Disabled") : "Managed by T3"}
            control={
              editable ? (
                <>
                  <Switch
                    checked={entry.enabled}
                    disabled={isSaving || !canMutate}
                    aria-label={`Enable ${entry.name}`}
                    onCheckedChange={(enabled) => void updateExisting(entry, enabled)}
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    type="button"
                    disabled={isSaving || !canMutate}
                    aria-label={`Edit ${entry.name}`}
                    onClick={() => openEdit(entry)}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    type="button"
                    disabled={isSaving || !canMutate}
                    aria-label={`Remove ${entry.name}`}
                    onClick={() => setRemovalTarget(entry)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </>
              ) : null
            }
          >
            <ProjectMcpEntryDetails
              entry={entry}
              applications={applications}
              providerNameForId={providerNameForId}
            />
          </SettingsRow>
        );
      })}

      <Dialog open={draft !== null} onOpenChange={(open) => !open && closeForm()}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit MCP server" : "Add MCP server"}</DialogTitle>
            <DialogDescription>
              Attach this server to one or more providers for this checkout.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {draft ? (
              <form
                className="grid gap-5"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <label className="grid gap-1.5 text-sm font-medium">
                  Name
                  <Input
                    ref={nameInputRef}
                    autoFocus
                    aria-label="MCP server name"
                    aria-invalid={Boolean(fieldErrors.name)}
                    aria-describedby={fieldErrors.name ? "project-mcp-name-error" : undefined}
                    required
                    value={draft.name}
                    disabled={!canMutate || isSaving}
                    onChange={(event) => {
                      setDraft({ ...draft, name: event.target.value });
                      if (fieldErrors.name) {
                        const { name: _name, ...remainingErrors } = fieldErrors;
                        setFieldErrors(remainingErrors);
                      }
                    }}
                  />
                  {fieldErrors.name ? (
                    <p
                      id="project-mcp-name-error"
                      role="alert"
                      className="text-sm text-destructive"
                    >
                      {fieldErrors.name}
                    </p>
                  ) : null}
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Transport
                  <select
                    aria-label="MCP transport"
                    value={draft.transportType}
                    disabled={!canMutate || isSaving}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        transportType: event.target.value as ProjectMcpDraft["transportType"],
                      })
                    }
                  >
                    <option value="streamable-http">Streamable HTTP</option>
                    <option value="legacy-sse">Legacy SSE</option>
                    <option value="stdio">stdio</option>
                    {draft.transportType === "legacy-url" ? (
                      <option value="legacy-url">Legacy URL</option>
                    ) : null}
                  </select>
                </label>
                {draft.transportType === "stdio" ? (
                  <>
                    <label className="grid gap-1.5 text-sm font-medium">
                      Command
                      <Input
                        ref={commandInputRef}
                        aria-label="MCP server command"
                        aria-invalid={Boolean(fieldErrors.command)}
                        required
                        value={draft.command}
                        disabled={!canMutate || isSaving}
                        onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                      />
                      {fieldErrors.command ? <p role="alert">{fieldErrors.command}</p> : null}
                    </label>
                    <div className="grid gap-1.5 text-sm font-medium">
                      <span>Arguments</span>
                      {draft.args.map((argument, index) => (
                        <div key={argument.key} className="flex items-start gap-2">
                          <textarea
                            aria-label={`MCP server argument ${index + 1}`}
                            value={argument.value}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                args: draft.args.map((item) =>
                                  item.key === argument.key
                                    ? { ...item, value: event.target.value }
                                    : item,
                                ),
                              })
                            }
                            disabled={!canMutate || isSaving}
                          />
                          <Button
                            type="button"
                            aria-label={`Remove argument ${index + 1}`}
                            disabled={!canMutate || isSaving}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                args: draft.args.filter((item) => item.key !== argument.key),
                              })
                            }
                          >
                            <Trash2Icon className="size-4" />
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        disabled={!canMutate || isSaving}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            args: [...draft.args, { key: nextArgumentKey.current++, value: "" }],
                          })
                        }
                      >
                        Add argument
                      </Button>
                    </div>
                    <label className="grid gap-1.5 text-sm font-medium">
                      Working directory{" "}
                      <Input
                        aria-label="MCP server working directory"
                        value={draft.cwd}
                        onChange={(event) => setDraft({ ...draft, cwd: event.target.value })}
                        disabled={!canMutate || isSaving}
                      />
                    </label>
                    <CredentialFields
                      label="Environment variable"
                      entries={draft.env}
                      onChange={(env) => setDraft({ ...draft, env })}
                    />
                  </>
                ) : (
                  <>
                    <label className="grid gap-1.5 text-sm font-medium">
                      URL
                      <Input
                        ref={urlInputRef}
                        aria-label="MCP server URL"
                        aria-invalid={Boolean(fieldErrors.url)}
                        aria-describedby={fieldErrors.url ? "project-mcp-url-error" : undefined}
                        inputMode="url"
                        placeholder="https://mcp.example.com"
                        required
                        value={draft.url}
                        disabled={!canMutate || isSaving}
                        onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                      />
                      {fieldErrors.url ? (
                        <p id="project-mcp-url-error" role="alert">
                          {fieldErrors.url}
                        </p>
                      ) : null}
                    </label>
                    <CredentialFields
                      label="HTTP header"
                      entries={draft.headers}
                      onChange={(headers) => setDraft({ ...draft, headers })}
                    />
                    <fieldset className="grid gap-2">
                      <legend className="text-sm font-medium">Authorization</legend>
                      <select
                        aria-label="MCP authorization"
                        value={draft.authorization}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            authorization: event.target.value as "none" | "oauth",
                          })
                        }
                        disabled={!canMutate || isSaving}
                      >
                        <option value="none">None</option>
                        <option value="oauth">OAuth</option>
                      </select>
                      {draft.authorization === "oauth" ? (
                        <>
                          <select
                            aria-label="OAuth registration"
                            value={draft.oauthRegistration}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                oauthRegistration: event.target.value as
                                  | "automatic"
                                  | "pre-registered",
                              })
                            }
                            disabled={!canMutate || isSaving}
                          >
                            <option value="automatic">Automatic registration</option>
                            <option value="pre-registered">Pre-registered client</option>
                          </select>
                          {draft.oauthRegistration === "pre-registered" ? (
                            <>
                              <Input
                                aria-label="OAuth client ID"
                                placeholder="Client ID"
                                value={draft.oauthClientId}
                                onChange={(event) =>
                                  setDraft({ ...draft, oauthClientId: event.target.value })
                                }
                                disabled={!canMutate || isSaving}
                              />
                              <Input
                                aria-label="OAuth client secret"
                                type="password"
                                placeholder={
                                  draft.oauthClientSecret.id
                                    ? "Retained secret (leave blank to keep)"
                                    : "Client secret"
                                }
                                value={draft.oauthClientSecret.value}
                                onChange={(event) =>
                                  setDraft({
                                    ...draft,
                                    oauthClientSecret: {
                                      ...draft.oauthClientSecret,
                                      value: event.target.value,
                                    },
                                  })
                                }
                                disabled={!canMutate || isSaving}
                              />
                              {draft.oauthClientSecret.id ? (
                                <p className="text-xs text-muted-foreground">
                                  A client secret is configured; its value is never displayed.
                                </p>
                              ) : null}
                            </>
                          ) : null}
                          {currentEditing ? (
                            currentEditing.oauthStatus === "connected" ? (
                              <>
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={isSaving || !canMutate}
                                  onClick={() => void connectOAuth(currentEditing)}
                                >
                                  Reconnect OAuth
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={isSaving || !canMutate}
                                  onClick={() => void disconnectOAuth(currentEditing)}
                                >
                                  Disconnect OAuth
                                </Button>
                              </>
                            ) : currentEditing.oauthStatus === "authorization-pending" ? (
                              <Button
                                type="button"
                                variant="outline"
                                disabled={isSaving || !canMutate}
                                onClick={() => void continueOAuth(currentEditing)}
                              >
                                Continue authorization
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                variant="outline"
                                disabled={isSaving || !canMutate}
                                onClick={() => void connectOAuth(currentEditing)}
                              >
                                Connect OAuth
                              </Button>
                            )
                          ) : null}
                        </>
                      ) : null}
                    </fieldset>
                  </>
                )}
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Enabled</p>
                    <p className="text-xs text-muted-foreground">
                      Attach it to selected providers.
                    </p>
                  </div>
                  <Switch
                    checked={draft.enabled}
                    aria-label="Enable MCP server"
                    disabled={!canMutate || isSaving}
                    onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
                  />
                </div>
                <fieldset className="grid gap-2">
                  <legend className="text-sm font-medium">Providers</legend>
                  <p className="text-xs text-muted-foreground">
                    Leave all unchecked to save the server without attaching it.
                  </p>
                  {providerEntries.map((provider) => {
                    const selected = draft.providerInstanceIds.includes(provider.instanceId);
                    return (
                      <label key={provider.instanceId} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={selected}
                          aria-label={`Select provider ${provider.displayName}`}
                          disabled={!canMutate || isSaving}
                          onCheckedChange={(checked) =>
                            setDraft({
                              ...draft,
                              providerInstanceIds: checked
                                ? [...draft.providerInstanceIds, provider.instanceId]
                                : draft.providerInstanceIds.filter(
                                    (id) => id !== provider.instanceId,
                                  ),
                            })
                          }
                        />
                        {provider.displayName}
                      </label>
                    );
                  })}
                  {unavailableProviderIds.map((providerInstanceId) => (
                    <label
                      key={providerInstanceId}
                      className="flex items-center gap-2 text-sm text-muted-foreground"
                    >
                      <Checkbox
                        checked
                        aria-label={`Select unavailable provider ${providerInstanceId}`}
                        disabled={!canMutate || isSaving}
                        onCheckedChange={(checked) => {
                          if (checked) return;
                          setDraft({
                            ...draft,
                            providerInstanceIds: draft.providerInstanceIds.filter(
                              (id) => id !== providerInstanceId,
                            ),
                          });
                        }}
                      />
                      {providerInstanceId} (Unavailable)
                    </label>
                  ))}
                </fieldset>
                <DialogFooter>
                  <DialogClose
                    render={<Button variant="outline" type="button" disabled={isSaving} />}
                  >
                    Cancel
                  </DialogClose>
                  <Button type="submit" disabled={isSaving || !canMutate}>
                    {editing ? "Save changes" : "Add server"}
                  </Button>
                </DialogFooter>
              </form>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={removalTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemovalTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove "{removalTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the server from this checkout. Existing provider sessions may keep their
              current configuration.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={isSaving} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={isSaving || !canMutate}
              onClick={() => void confirmRemoval()}
            >
              Remove server
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

export function ProjectMcpCatalogSettings({
  environmentId,
  projectId,
  providers,
  canMutate,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly canMutate: boolean;
}) {
  return (
    <ScopedProjectMcpCatalogSettings
      key={`${environmentId}:${projectId}`}
      environmentId={environmentId}
      projectId={projectId}
      providers={providers}
      canMutate={canMutate}
    />
  );
}

function PrimarySessionProjectMcpSettings({
  environmentId,
  projectId,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const session = usePrimarySessionState();
  const operateAccess = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: isElectron,
    session: session.data,
    isPending: session.isPending,
    hasError: session.error !== null,
  });
  return (
    <ProjectMcpCatalogSettings
      environmentId={environmentId}
      projectId={projectId}
      providers={providers}
      canMutate={operateAccess === "granted"}
    />
  );
}

function RemoteSessionProjectMcpSettings({
  environmentId,
  projectId,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const session = useEnvironmentSessionState(environmentId);
  const operateAccess = resolveRemoteOperateAccess({
    session: session.data,
    isPending: session.isPending,
    hasError: session.hasError,
  });
  return (
    <ProjectMcpCatalogSettings
      environmentId={environmentId}
      projectId={projectId}
      providers={providers}
      canMutate={operateAccess === "granted"}
    />
  );
}

/** MCP settings for one physical project, omitted for older environments. */
export function ProjectMcpSettings({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (config?.environment.capabilities.projectMcpCatalog !== true) return null;
  if (environmentId === primaryEnvironmentId) {
    return (
      <PrimarySessionProjectMcpSettings
        environmentId={environmentId}
        projectId={projectId}
        providers={config.providers}
      />
    );
  }
  return (
    <RemoteSessionProjectMcpSettings
      environmentId={environmentId}
      projectId={projectId}
      providers={config.providers}
    />
  );
}
