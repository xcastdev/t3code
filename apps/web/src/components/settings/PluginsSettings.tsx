import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  readPluginArchiveManifest,
  type ClientPluginRecord,
} from "@t3tools/client-runtime/plugins/client-packages";
import { pluginPanelKey } from "@t3tools/client-runtime/plugins/commands";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAttachmentUploadCycle } from "@t3tools/client-runtime/state/attachments";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PluginConfig,
  PluginId,
  PluginInstallRecord,
  PluginManifest,
  PluginSettingField,
  PluginSettingValue,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { EllipsisIcon, UploadIcon } from "lucide-react";
import { useContext, useRef, useState, type ReactNode } from "react";
import { AsyncResult } from "effect/reactivity";

import { clientPluginStore } from "../../plugins/clientPluginStore";
import { openPluginPanel } from "../../plugins/openPluginPanel";
import {
  clientPluginRecordsAtom,
  leftoverClientPluginStateAtom,
  refreshClientPlugins,
} from "../../plugins/pluginInstalls";
import { usePluginPanelStore } from "../../pluginPanelStore";
import { attachmentEnvironment } from "../../state/attachments";
import type { EnvironmentPresentation } from "../../state/environments";
import { pluginEnvironment } from "../../state/plugins";
import { readPreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { PluginLogsDialog, type PluginLogsView } from "../plugins/PluginLogsDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const PLUGIN_PACKAGE_MIME = "application/zip";

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.";
};

const reportError = (title: string, description: string) =>
  toastManager.add({ type: "error", title, description });

function PackageFileButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onFile: (file: File) => void;
  readonly variant?: "outline" | "ghost";
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".t3plugin"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) props.onFile(file);
        }}
      />
      <Button
        size="xs"
        variant={props.variant ?? "outline"}
        disabled={props.disabled}
        onClick={() => inputRef.current?.click()}
      >
        <UploadIcon className="size-3" aria-hidden />
        {props.label}
      </Button>
    </>
  );
}

function OpenPanelsButton(props: {
  readonly scope: EnvironmentId | "client";
  readonly pluginId: PluginId;
  readonly manifest: PluginManifest;
}) {
  const router = useRouter();
  const panels = props.manifest.ui?.panels ?? [];
  const first = panels[0];
  if (first === undefined) return null;
  const open = (panelId: string) =>
    openPluginPanel(router, pluginPanelKey(props.scope, props.pluginId, panelId));
  if (panels.length === 1) {
    return (
      <Button size="xs" variant="outline" onClick={() => open(first.id)}>
        Open
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" />}>Open</MenuTrigger>
      <MenuPopup align="end">
        {panels.map((panel) => (
          <MenuItem key={panel.id} onClick={() => open(panel.id)}>
            {panel.title}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function PinPanelsControl(props: {
  readonly scope: EnvironmentId | "client";
  readonly pluginId: PluginId;
  readonly manifest: PluginManifest;
}) {
  const pinned = usePluginPanelStore((state) => state.pinned);
  const panels = props.manifest.ui?.panels ?? [];
  const first = panels[0];
  if (first === undefined) return null;
  const keyOf = (panelId: string) => pluginPanelKey(props.scope, props.pluginId, panelId);
  const setPinned = (panelId: string, next: boolean) => {
    const store = usePluginPanelStore.getState();
    if (next) store.pin(keyOf(panelId));
    else store.unpin(keyOf(panelId));
  };
  if (panels.length === 1) {
    return (
      <Label>
        <Switch
          size="sm"
          checked={pinned.includes(keyOf(first.id))}
          aria-label={`Pin ${first.title} to right panel`}
          onCheckedChange={(checked) => setPinned(first.id, Boolean(checked))}
        />
        Pin
      </Label>
    );
  }
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" />}>Pin</MenuTrigger>
      <MenuPopup align="end">
        {panels.map((panel) => (
          <MenuCheckboxItem
            key={panel.id}
            checked={pinned.includes(keyOf(panel.id))}
            onCheckedChange={(checked) => setPinned(panel.id, Boolean(checked))}
          >
            {panel.title}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function RowMenu(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-xs" variant="ghost" aria-label={`${props.label} actions`} />}
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">{props.children}</MenuPopup>
    </Menu>
  );
}

function ConfirmDialog(props: {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant={props.destructive ? "destructive" : "default"}
            onClick={() => {
              props.onConfirm();
              props.onClose();
            }}
          >
            {props.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

type PendingConfirm = Omit<Parameters<typeof ConfirmDialog>[0], "onClose">;

export function PluginsSettings() {
  const { environment } = useSettingsScope();
  const connected = environment?.connection.phase === "connected";
  return (
    <SettingsPageContainer>
      <DevicePlugins />
      {connected ? (
        <EnvironmentPlugins key={environment.environmentId} environment={environment} />
      ) : (
        <SettingsSection {...searchableSetting("plugins-environment")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect an environment to install plugins with a backend.
          </p>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function DevicePlugins() {
  const records = AsyncResult.getOrElse(useAtomValue(clientPluginRecordsAtom), () => []);
  const leftovers = AsyncResult.getOrElse(useAtomValue(leftoverClientPluginStateAtom), () => []);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  const install = (file: File) => {
    void file
      .arrayBuffer()
      .then((bytes) => clientPluginStore.install(bytes))
      .then(
        (record) => {
          refreshClientPlugins();
          toastManager.add({ type: "success", title: `Installed ${record.name} on this device` });
        },
        (error: unknown) =>
          reportError(
            "Could not install the plugin",
            error instanceof Error ? error.message : String(error),
          ),
      );
  };
  const change = (run: () => Promise<void>) => void run().then(refreshClientPlugins);

  return (
    <SettingsSection
      {...searchableSetting("plugins-device")}
      headerAction={<PackageFileButton label="Install" onFile={install} />}
    >
      {records.length === 0 && leftovers.length === 0 ? (
        <SettingsRow
          title="No plugins on this device."
          description="Plugins without a backend install into this browser and are not shared with other devices."
        />
      ) : (
        records.map((record: ClientPluginRecord) => (
          <SettingsRow
            key={record.pluginId}
            title={`${record.name} ${record.version}`}
            description={`By ${record.manifest.author}`}
            control={
              <div className="flex items-center gap-2">
                {record.enabled ? (
                  <>
                    <PinPanelsControl
                      scope="client"
                      pluginId={record.pluginId}
                      manifest={record.manifest}
                    />
                    <OpenPanelsButton
                      scope="client"
                      pluginId={record.pluginId}
                      manifest={record.manifest}
                    />
                  </>
                ) : null}
                <Switch
                  checked={record.enabled}
                  aria-label={`Enable ${record.name}`}
                  onCheckedChange={(checked) =>
                    change(() => clientPluginStore.setEnabled(record.pluginId, Boolean(checked)))
                  }
                />
                <RowMenu label={record.name}>
                  <MenuItem
                    onClick={() =>
                      setConfirm({
                        title: `Uninstall ${record.name}?`,
                        description: "Its saved panel state stays until you delete its data.",
                        confirmLabel: "Uninstall",
                        destructive: true,
                        onConfirm: () =>
                          change(async () => {
                            await clientPluginStore.uninstall(record.pluginId);
                            usePluginPanelStore.getState().dropPlugin("client", record.pluginId);
                          }),
                      })
                    }
                  >
                    Uninstall
                  </MenuItem>
                  <MenuItem
                    onClick={() =>
                      setConfirm({
                        title: `Delete ${record.name}'s data?`,
                        description: "This removes the panel state it saved on this device.",
                        confirmLabel: "Delete data",
                        destructive: true,
                        onConfirm: () =>
                          change(() => clientPluginStore.deleteData(record.pluginId)),
                      })
                    }
                  >
                    Delete data
                  </MenuItem>
                </RowMenu>
              </div>
            }
          />
        ))
      )}
      {leftovers.map((pluginId) => (
        <SettingsRow
          key={`leftover:${pluginId}`}
          title={`Data from ${pluginId}`}
          description="Panel state kept on this device after uninstall."
          control={
            <Button
              size="xs"
              variant="destructive-outline"
              onClick={() =>
                setConfirm({
                  title: `Delete ${pluginId}'s data?`,
                  description: "This removes the panel state it saved on this device.",
                  confirmLabel: "Delete data",
                  destructive: true,
                  onConfirm: () => change(() => clientPluginStore.deleteData(pluginId)),
                })
              }
            >
              Delete data
            </Button>
          }
        />
      ))}
      {confirm ? <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} /> : null}
    </SettingsSection>
  );
}

function statusBadge(record: PluginInstallRecord) {
  if (!record.enabled) return <Badge variant="outline">Disabled</Badge>;
  if (record.manifest.backend === undefined) return null;
  switch (record.status) {
    case "running":
      return <Badge variant="success">Running</Badge>;
    case "starting":
      return <Badge variant="info">Starting</Badge>;
    case "failed":
      return <Badge variant="error">Failed</Badge>;
    case "missing-prerequisite":
      return <Badge variant="warning">Missing prerequisite</Badge>;
    default:
      return <Badge variant="outline">Stopped</Badge>;
  }
}

const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function EnvironmentPlugins(props: { readonly environment: EnvironmentPresentation }) {
  const { environmentId, label } = props.environment;
  const registry = useContext(RegistryContext);
  const snapshot = useAtomValue(pluginEnvironment.registry({ environmentId, input: {} }));
  const canMaintain = useAtomValue(pluginEnvironment.install.permissionAtom(environmentId));
  const canConfigure = useAtomValue(pluginEnvironment.setEnabled.permissionAtom(environmentId));
  const canReadLogs = useAtomValue(pluginEnvironment.logs.permissionAtom(environmentId));
  const installCommand = useAtomCommand(pluginEnvironment.install, { reportFailure: false });
  const updateCommand = useAtomCommand(pluginEnvironment.update, { reportFailure: false });
  const uninstall = useAtomCommand(pluginEnvironment.uninstall);
  const deleteData = useAtomCommand(pluginEnvironment.deleteData);
  const setEnabled = useAtomCommand(pluginEnvironment.setEnabled);
  const start = useAtomCommand(pluginEnvironment.start);
  const stop = useAtomCommand(pluginEnvironment.stop);
  const restart = useAtomCommand(pluginEnvironment.restart);
  const logs = useAtomCommand(pluginEnvironment.logs, { reportFailure: false });
  const readConfig = useAtomCommand(pluginEnvironment.readConfig, { reportFailure: false });
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [logsView, setLogsView] = useState<PluginLogsView | null>(null);
  const [configuring, setConfiguring] = useState<{
    readonly record: PluginInstallRecord;
    readonly config: PluginConfig;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File): Promise<string | null> => {
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: attachmentEnvironment.createUploadUrl,
      remove: attachmentEnvironment.remove,
      environmentId,
      upload: {
        type: "file",
        name: file.name,
        mimeType: PLUGIN_PACKAGE_MIME,
        sizeBytes: file.size,
      },
      resolveUploadUrl: (relativeUrl) => {
        const connection = readPreparedConnection(environmentId);
        return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
      },
      transport: (url) => {
        const controller = new AbortController();
        const done = fetch(url, {
          method: "POST",
          body: file,
          headers: { "Content-Type": PLUGIN_PACKAGE_MIME },
          signal: controller.signal,
        }).then((response) => {
          if (!response.ok) throw new Error(`Upload rejected (${response.status})`);
        });
        return { done, abort: () => controller.abort() };
      },
    });
    if (result.status === "uploaded") return result.attachmentId;
    if (result.status === "failed") {
      reportError(
        "Could not upload the plugin",
        result.error instanceof Error ? result.error.message : "The upload failed.",
      );
    }
    return null;
  };

  // Backends run with this account's privileges, so installing one needs the author's trust.
  const submitPackage = (file: File, target: PluginInstallRecord | null) => {
    void file.arrayBuffer().then(async (bytes) => {
      let manifest: PluginManifest;
      try {
        manifest = await readPluginArchiveManifest(bytes);
      } catch (error) {
        reportError(
          "This is not a T3 Code plugin package",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      if (target !== null && manifest.id !== target.pluginId) {
        reportError("Wrong package", `This package is ${manifest.name}, not ${target.name}.`);
        return;
      }
      const send = async (trustBackendAuthor: boolean) => {
        setBusy(true);
        const attachmentId = await upload(file);
        if (attachmentId === null) {
          setBusy(false);
          return;
        }
        const input = { attachmentId, trustBackendAuthor };
        const result =
          target === null
            ? await installCommand({ environmentId, input })
            : await updateCommand({
                environmentId,
                input: { ...input, pluginId: target.pluginId },
              });
        setBusy(false);
        if (result._tag === "Success") {
          toastManager.add({
            type: "success",
            title: `${target === null ? "Installed" : "Updated"} ${result.value.name} ${result.value.version} on ${label}`,
          });
        } else {
          reportError(
            `Could not ${target === null ? "install" : "update"} ${manifest.name}`,
            failureMessage(result),
          );
        }
      };
      if (manifest.backend === undefined) {
        void send(false);
        return;
      }
      setConfirm({
        title: `Trust ${manifest.author}?`,
        description: `${manifest.name} runs a backend on ${label} with the same access as T3 Code there: your files, network, and credentials. Install it only if you trust its author.`,
        confirmLabel: "I trust this author",
        onConfirm: () => void send(true),
      });
    });
  };

  const target = (record: PluginInstallRecord) => ({
    environmentId,
    input: { pluginId: record.pluginId },
  });
  const showLogs = (record: PluginInstallRecord) =>
    void logs({ environmentId, input: { pluginId: record.pluginId, limit: 200 } }).then((result) =>
      setLogsView(
        result._tag === "Success"
          ? { pluginName: record.name, lines: result.value.lines }
          : { pluginName: record.name, error: failureMessage(result) },
      ),
    );
  const configure = (record: PluginInstallRecord) =>
    void readConfig(target(record)).then((result) => {
      if (result._tag === "Success") setConfiguring({ record, config: result.value });
      else reportError(`Could not read ${record.name}'s settings`, failureMessage(result));
    });

  const confirmDeleteData = (pluginId: PluginId, name: string) =>
    setConfirm({
      title: `Delete ${name}'s data?`,
      description: `This permanently removes everything it stored on ${label}, and its panel state on this device.`,
      confirmLabel: "Delete data",
      destructive: true,
      onConfirm: () =>
        void deleteData({ environmentId, input: { pluginId } }).then((result) => {
          if (result._tag === "Success") void clientPluginStore.deleteData(pluginId, environmentId);
        }),
    });

  const installed = AsyncResult.isSuccess(snapshot) ? snapshot.value.installed : [];
  const retained = AsyncResult.isSuccess(snapshot)
    ? snapshot.value.retainedData.filter(
        (entry) => !installed.some((record) => record.pluginId === entry.pluginId),
      )
    : [];

  return (
    <SettingsSection
      {...searchableSetting("plugins-environment")}
      title={`On ${label}`}
      headerAction={
        <PackageFileButton
          label="Install"
          disabled={!canMaintain || busy}
          onFile={(file) => submitPackage(file, null)}
        />
      }
    >
      {AsyncResult.isFailure(snapshot) ? (
        <SettingsRow
          title="Plugins are unavailable here."
          description={`Update T3 Code on ${label} to install plugins there.`}
        />
      ) : installed.length === 0 ? (
        <SettingsRow
          title="No plugins installed."
          description="Install a .t3plugin package. Packages with a backend run on this environment and reach agents as tools."
        />
      ) : (
        installed.map((record) => {
          const hasBackend = record.manifest.backend !== undefined;
          const running = record.status === "running" || record.status === "starting";
          return (
            <SettingsRow
              key={record.pluginId}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 wrap-anywhere">
                    {record.name} {record.version}
                  </span>
                  {statusBadge(record)}
                </span>
              }
              description={
                <span className="flex flex-col gap-0.5">
                  <span>By {record.author}</span>
                  {record.statusDetail ? <span>{record.statusDetail}</span> : null}
                  {record.failedUpdate ? (
                    <span className="text-destructive-foreground">
                      {record.failedUpdate.reason}
                    </span>
                  ) : null}
                </span>
              }
              control={
                <div className="flex flex-wrap items-center gap-2">
                  {record.enabled ? (
                    <>
                      <PinPanelsControl
                        scope={environmentId}
                        pluginId={record.pluginId}
                        manifest={record.manifest}
                      />
                      <OpenPanelsButton
                        scope={environmentId}
                        pluginId={record.pluginId}
                        manifest={record.manifest}
                      />
                    </>
                  ) : null}
                  {record.enabled && hasBackend ? (
                    running ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!canConfigure}
                        onClick={() => void stop(target(record))}
                      >
                        Stop
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!canConfigure}
                        onClick={() => void start(target(record))}
                      >
                        Start
                      </Button>
                    )
                  ) : null}
                  <Switch
                    checked={record.enabled}
                    disabled={!canConfigure}
                    aria-label={`Enable ${record.name}`}
                    onCheckedChange={(checked) =>
                      void setEnabled({
                        environmentId,
                        input: { pluginId: record.pluginId, enabled: Boolean(checked) },
                      })
                    }
                  />
                  <RowMenu label={record.name}>
                    {hasBackend ? (
                      <MenuItem
                        disabled={!canConfigure || !record.enabled}
                        onClick={() => void restart(target(record))}
                      >
                        Restart
                      </MenuItem>
                    ) : null}
                    {hasBackend ? (
                      <MenuItem disabled={!canReadLogs} onClick={() => showLogs(record)}>
                        Logs
                      </MenuItem>
                    ) : null}
                    {(record.manifest.settings?.environment.length ?? 0) > 0 ? (
                      <MenuItem disabled={!canConfigure} onClick={() => configure(record)}>
                        Configure
                      </MenuItem>
                    ) : null}
                    <UpdateMenuItem
                      disabled={!canMaintain || busy}
                      onFile={(file) => submitPackage(file, record)}
                    />
                    <MenuSeparator />
                    <MenuItem
                      disabled={!canMaintain}
                      onClick={() =>
                        setConfirm({
                          title: `Uninstall ${record.name}?`,
                          description: `This stops it on ${label} and removes its tools. Its data stays until you delete it.`,
                          confirmLabel: "Uninstall",
                          destructive: true,
                          onConfirm: () =>
                            void uninstall(target(record)).then((result) => {
                              if (result._tag === "Success") {
                                usePluginPanelStore
                                  .getState()
                                  .dropPlugin(environmentId, record.pluginId);
                              }
                            }),
                        })
                      }
                    >
                      Uninstall
                    </MenuItem>
                    <MenuItem
                      disabled={!canMaintain || record.enabled}
                      onClick={() => confirmDeleteData(record.pluginId, record.name)}
                    >
                      Delete data
                    </MenuItem>
                  </RowMenu>
                </div>
              }
            />
          );
        })
      )}
      {retained.map((entry) => (
        <SettingsRow
          key={`retained:${entry.pluginId}`}
          title={`Data from ${entry.pluginId}`}
          description={`${formatBytes(entry.bytes)} kept after uninstall.`}
          control={
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={!canMaintain}
              onClick={() => confirmDeleteData(entry.pluginId, entry.pluginId)}
            >
              Delete data
            </Button>
          }
        />
      ))}
      {confirm ? <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} /> : null}
      {logsView ? <PluginLogsDialog view={logsView} onClose={() => setLogsView(null)} /> : null}
      {configuring ? (
        <PluginConfigureDialog
          environmentId={environmentId}
          record={configuring.record}
          config={configuring.config}
          onClose={() => setConfiguring(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

function UpdateMenuItem(props: {
  readonly disabled: boolean;
  readonly onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".t3plugin"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) props.onFile(file);
        }}
      />
      <MenuItem
        disabled={props.disabled}
        closeOnClick={false}
        onClick={() => inputRef.current?.click()}
      >
        Update…
      </MenuItem>
    </>
  );
}

type FieldDraft =
  | { readonly kind: "value"; readonly value: PluginSettingValue }
  | { readonly kind: "clear" };

function PluginConfigureDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly record: PluginInstallRecord;
  readonly config: PluginConfig;
  readonly onClose: () => void;
}) {
  const configureCommand = useAtomCommand(pluginEnvironment.configure, { reportFailure: false });
  const fields = props.record.manifest.settings?.environment ?? [];
  const [drafts, setDrafts] = useState<Readonly<Record<string, FieldDraft>>>({});
  const [error, setError] = useState<string | null>(null);
  const setDraft = (key: string, draft: FieldDraft) =>
    setDrafts((current) => ({ ...current, [key]: draft }));

  const save = async () => {
    const values = Object.fromEntries(
      Object.entries(drafts).map(([key, draft]) => [
        key,
        draft.kind === "clear" ? null : draft.value,
      ]),
    );
    const result = await configureCommand({
      environmentId: props.environmentId,
      input: { pluginId: props.record.pluginId, values },
    });
    if (result._tag === "Success") props.onClose();
    else setError(failureMessage(result));
  };

  const currentValue = (field: PluginSettingField): PluginSettingValue | undefined => {
    const draft = drafts[field.key];
    if (draft?.kind === "value") return draft.value;
    if (draft?.kind === "clear") return field.default;
    return props.config.values[field.key] ?? field.default;
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Configure {props.record.name}</DialogTitle>
          <DialogDescription>Changes apply the next time its backend starts.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {fields.map((field) => {
              const id = `plugin-setting-${field.key}`;
              const value = currentValue(field);
              if (field.type === "secret") {
                const set =
                  drafts[field.key]?.kind === "clear"
                    ? false
                    : drafts[field.key]?.kind === "value" ||
                      props.config.secrets[field.key]?.set === true;
                return (
                  <div key={field.key} className="flex flex-col gap-1.5">
                    <Label htmlFor={id}>
                      {field.label}
                      <Badge variant={set ? "success" : "outline"}>{set ? "Set" : "Not set"}</Badge>
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id={id}
                        type="password"
                        autoComplete="off"
                        placeholder={set ? "Enter a new value to replace it" : "Enter a value"}
                        onChange={(event) =>
                          setDraft(field.key, { kind: "value", value: event.currentTarget.value })
                        }
                      />
                      {props.config.secrets[field.key]?.set ? (
                        <Button
                          variant="outline"
                          onClick={() => setDraft(field.key, { kind: "clear" })}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              }
              if (field.type === "boolean") {
                return (
                  <div key={field.key} className="flex items-center justify-between gap-2">
                    <Label htmlFor={id}>{field.label}</Label>
                    <Switch
                      id={id}
                      checked={value === true}
                      onCheckedChange={(checked) =>
                        setDraft(field.key, { kind: "value", value: Boolean(checked) })
                      }
                    />
                  </div>
                );
              }
              if (field.type === "enum") {
                return (
                  <div key={field.key} className="flex flex-col gap-1.5">
                    <Label>{field.label}</Label>
                    <Select
                      value={typeof value === "string" ? value : null}
                      onValueChange={(next) => {
                        if (typeof next === "string")
                          setDraft(field.key, { kind: "value", value: next });
                      }}
                    >
                      <SelectTrigger size="sm" aria-label={field.label}>
                        <SelectValue>{typeof value === "string" ? value : "Choose…"}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {(field.options ?? []).map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                );
              }
              return (
                <div key={field.key} className="flex flex-col gap-1.5">
                  <Label htmlFor={id}>{field.label}</Label>
                  <Input
                    id={id}
                    type={field.type === "number" ? "number" : "text"}
                    value={value === undefined ? "" : String(value)}
                    onChange={(event) => {
                      const raw = event.currentTarget.value;
                      if (raw === "") setDraft(field.key, { kind: "clear" });
                      else if (field.type === "number") {
                        const parsed = Number(raw);
                        if (Number.isFinite(parsed))
                          setDraft(field.key, { kind: "value", value: parsed });
                      } else setDraft(field.key, { kind: "value", value: raw });
                    }}
                  />
                </div>
              );
            })}
            {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={Object.keys(drafts).length === 0} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
