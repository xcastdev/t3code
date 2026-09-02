import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ProjectMcpApplicationMode,
  ProjectMcpManagedServer,
  ProjectMcpServer,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { projectMcpEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { SettingsRow, SettingsSection } from "./settingsLayout";

type CatalogEntry = ProjectMcpServer | ProjectMcpManagedServer;

interface ProjectMcpDraft {
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly providerInstanceIds: ReadonlyArray<ProviderInstanceId>;
}

const EMPTY_DRAFT: ProjectMcpDraft = {
  name: "",
  url: "",
  enabled: true,
  providerInstanceIds: [],
};

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
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ProjectMcpCatalogSettings({
  environmentId,
  projectId,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const catalog = useEnvironmentQuery(
    projectMcpEnvironment.catalog({ environmentId, input: { projectId } }),
  );
  const createEntry = useAtomCommand(projectMcpEnvironment.create, { reportFailure: false });
  const updateEntry = useAtomCommand(projectMcpEnvironment.update, { reportFailure: false });
  const removeEntry = useAtomCommand(projectMcpEnvironment.remove, { reportFailure: false });
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
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const openCreate = useCallback(() => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setFormError(null);
  }, []);
  const openEdit = useCallback((entry: ProjectMcpServer) => {
    setEditing(entry);
    setDraft({
      name: entry.name,
      url: entry.url,
      enabled: entry.enabled,
      providerInstanceIds: entry.providerInstanceIds,
    });
    setFormError(null);
  }, []);
  const closeForm = useCallback(() => {
    setDraft(null);
    setEditing(null);
    setFormError(null);
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
    if (!draft || isSaving) return;
    const name = draft.name.trim();
    const url = draft.url.trim();
    if (!name || !url) {
      setFormError("Name and URL are required.");
      return;
    }

    setIsSaving(true);
    try {
      const input = {
        projectId,
        name,
        url,
        enabled: draft.enabled,
        providerInstanceIds: draft.providerInstanceIds,
      };
      const result = editing
        ? await updateEntry({ environmentId, input: { ...input, id: editing.id } })
        : await createEntry({ environmentId, input });
      if (result._tag === "Success") {
        closeForm();
        catalog.refresh();
        return;
      }
      reportFailure(editing ? "Failed to update MCP server" : "Failed to add MCP server", result);
    } finally {
      setIsSaving(false);
    }
  }, [
    catalog,
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
    async (entry: ProjectMcpServer, changes: Partial<ProjectMcpDraft>) => {
      if (isSaving) return;
      setIsSaving(true);
      try {
        const result = await updateEntry({
          environmentId,
          input: {
            projectId,
            id: entry.id,
            name: entry.name,
            url: entry.url,
            enabled: changes.enabled ?? entry.enabled,
            providerInstanceIds: changes.providerInstanceIds ?? entry.providerInstanceIds,
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
    [catalog, environmentId, isSaving, projectId, reportFailure, updateEntry],
  );
  const removeExisting = useCallback(
    async (entry: ProjectMcpServer) => {
      if (isSaving) return;
      setIsSaving(true);
      try {
        const result = await removeEntry({ environmentId, input: { projectId, id: entry.id } });
        if (result._tag === "Success") {
          catalog.refresh();
          return;
        }
        reportFailure("Failed to remove MCP server", result);
      } finally {
        setIsSaving(false);
      }
    },
    [catalog, environmentId, isSaving, projectId, removeEntry, reportFailure],
  );

  const entries: ReadonlyArray<CatalogEntry> = [
    ...(catalog.data?.external ?? []),
    ...(catalog.data?.managed ?? []),
  ];

  return (
    <SettingsSection
      title="MCP servers"
      headerAction={
        <Button size="xs" variant="outline" type="button" onClick={openCreate}>
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
            description={hostForUrl(entry.url)}
            status={editable ? (entry.enabled ? "Enabled" : "Disabled") : "Managed by T3"}
            control={
              editable ? (
                <>
                  <Switch
                    checked={entry.enabled}
                    disabled={isSaving}
                    aria-label={`Enable ${entry.name}`}
                    onCheckedChange={(enabled) => void updateExisting(entry, { enabled })}
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    type="button"
                    disabled={isSaving}
                    aria-label={`Edit ${entry.name}`}
                    onClick={() => openEdit(entry)}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    type="button"
                    disabled={isSaving}
                    aria-label={`Remove ${entry.name}`}
                    onClick={() => void removeExisting(entry)}
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
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <label className="grid gap-1.5 text-sm font-medium">
                  Name
                  <Input
                    autoFocus
                    aria-label="MCP server name"
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  URL
                  <Input
                    aria-label="MCP server URL"
                    inputMode="url"
                    placeholder="https://mcp.example.com"
                    value={draft.url}
                    onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                  />
                </label>
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
                </fieldset>
                {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
                <DialogFooter>
                  <DialogClose
                    render={<Button variant="outline" type="button" disabled={isSaving} />}
                  >
                    Cancel
                  </DialogClose>
                  <Button type="submit" disabled={isSaving}>
                    {editing ? "Save changes" : "Add server"}
                  </Button>
                </DialogFooter>
              </form>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
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
  if (config?.environment.capabilities.projectMcpCatalog !== true) return null;
  return (
    <ProjectMcpCatalogSettings
      environmentId={environmentId}
      projectId={projectId}
      providers={config.providers}
    />
  );
}
