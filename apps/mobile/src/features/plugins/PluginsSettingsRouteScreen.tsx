import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  readPluginArchiveManifest,
  type ClientPluginRecord,
} from "@t3tools/client-runtime/plugins/client-packages";
import { issuedMobileTransferUrl } from "../../lib/verifiedAssetUrl";
import { requestVerifiedRoute } from "../../native/verifiedNetwork";
import { attachmentUploadError } from "@t3tools/client-runtime/state/attachment-uploads";
import { runAttachmentUploadCycle } from "@t3tools/client-runtime/state/attachments";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PluginId,
  PluginInstallRecord,
  PluginManifest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { useContext, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { attachmentEnvironment } from "../../state/attachments";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { pluginEnvironment } from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { clientPluginStore } from "./clientPluginStore";
import {
  clientPluginRecordsAtom,
  pluginRegistryAtom,
  refreshClientPlugins,
} from "./pluginInstalls";

const PLUGIN_PACKAGE_MIME = "application/zip";

interface PickedPackage {
  readonly uri: string;
  readonly name: string;
  readonly size: number;
  readonly bytes: ArrayBuffer;
}

const errorText = (error: unknown) =>
  error instanceof Error && error.message.trim() !== "" ? error.message : String(error);

const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0]) =>
  errorText(squashAtomCommandFailure(result));

async function pickPackage(): Promise<PickedPackage | null> {
  const { getDocumentAsync } = await import("expo-document-picker");
  const { File } = await import("expo-file-system");
  const endHandoff = beginForegroundHandoff();
  try {
    const result = await getDocumentAsync({ type: "*/*", copyToCacheDirectory: true });
    const asset = result.canceled ? undefined : result.assets[0];
    if (asset === undefined) return null;
    const bytes = await new File(asset.uri).arrayBuffer();
    return { uri: asset.uri, name: asset.name || "plugin.t3plugin", size: bytes.byteLength, bytes };
  } finally {
    endHandoff();
  }
}

async function uploadPluginPackage(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  picked: PickedPackage,
): Promise<string> {
  const { File, UploadType } = await import("expo-file-system");
  const result = await Effect.runPromise(
    runAttachmentUploadCycle({
      registry,
      createUploadUrl: attachmentEnvironment.createUploadUrl,
      remove: attachmentEnvironment.remove,
      environmentId,
      upload: {
        type: "file",
        name: picked.name,
        mimeType: PLUGIN_PACKAGE_MIME,
        sizeBytes: picked.size,
      },
      resolveUploadUrl: (issuedUrl, verificationRequired) =>
        issuedMobileTransferUrl(environmentId, issuedUrl, verificationRequired),
      transport: (url, verificationRequired) =>
        Effect.tryPromise({
          try: async (signal) => {
            const headers = { "Content-Type": PLUGIN_PACKAGE_MIME };
            const verified = await requestVerifiedRoute(url, {
              method: "POST",
              headers,
              signal,
              uploadFile: picked.uri,
              ...(verificationRequired ? { requireVerified: true } : {}),
            });
            if (verified === null) {
              signal.throwIfAborted();
              if (verificationRequired) throw new Error("The upload route could not be verified.");
            }
            const response =
              verified ??
              (await new File(picked.uri).upload(url, {
                httpMethod: "POST",
                uploadType: UploadType.BINARY_CONTENT,
                headers,
                signal,
              }));
            if (response.status < 200 || response.status >= 300) {
              throw new Error(`Upload rejected (${response.status})`);
            }
          },
          catch: attachmentUploadError,
        }),
    }),
  );
  if (result.status === "uploaded") return result.attachmentId;
  throw result.status === "failed" && result.error instanceof Error
    ? result.error
    : new Error("The upload failed.");
}

const confirm = (input: {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
}) => Dialog.confirm(input);

function useOpenPanel() {
  const navigation = useNavigation();
  return (scope: EnvironmentId | "client", pluginId: PluginId, panelId: string) =>
    navigation.dispatch(StackActions.push("PluginPanel", { scope, pluginId, panelId }));
}

function PanelRows(props: {
  readonly scope: EnvironmentId | "client";
  readonly pluginId: PluginId;
  readonly manifest: PluginManifest;
}) {
  const open = useOpenPanel();
  return (props.manifest.ui?.panels ?? []).map((panel) => (
    <ListRow
      key={panel.id}
      icon="puzzlepiece.extension"
      label={`Open ${panel.title}`}
      onPress={() => open(props.scope, props.pluginId, panel.id)}
    />
  ));
}

export function PluginsSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  return (
    <SettingsScreen title="Plugins">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <DevicePlugins />
        {connected.length === 0 ? (
          <EmptyState
            variant="plain"
            title="No connected environments"
            detail="Connect an environment to install plugins with a backend."
          />
        ) : null}
        {connected.map((environment) => (
          <EnvironmentPlugins key={environment.environmentId} environment={environment} />
        ))}
      </ScrollView>
    </SettingsScreen>
  );
}

function DevicePlugins() {
  const records = AsyncResult.getOrElse(useAtomValue(clientPluginRecordsAtom), () => []);
  const [busy, setBusy] = useState(false);
  const install = () => {
    setBusy(true);
    void pickPackage()
      .then(async (picked) => {
        if (picked === null) return;
        const record = await clientPluginStore.install(picked.bytes);
        refreshClientPlugins();
        Dialog.alert(`Installed ${record.name} on this device`);
      })
      .catch((error: unknown) => Dialog.alert("Could not install the plugin", errorText(error)))
      .finally(() => setBusy(false));
  };
  const change = (run: () => Promise<void>) => void run().then(refreshClientPlugins);
  return (
    <>
      <ListSection
        title="On this device"
        footer="Plugins without a backend install on this device and are not shared with other devices."
      >
        <ListActionRow icon="plus" label="Install from file" loading={busy} onPress={install} />
      </ListSection>
      {records.map((record: ClientPluginRecord) => (
        <ListSection key={record.pluginId} title={`${record.name} ${record.version}`}>
          <ListRowLayout label={`By ${record.manifest.author}`} />
          <ListToggleRow
            label="Enabled"
            value={record.enabled}
            onValueChange={(enabled) =>
              change(() => clientPluginStore.setEnabled(record.pluginId, enabled))
            }
          />
          {record.enabled ? (
            <PanelRows scope="client" pluginId={record.pluginId} manifest={record.manifest} />
          ) : null}
          <ListActionRow
            tone="danger"
            label="Uninstall"
            onPress={() =>
              confirm({
                title: `Uninstall ${record.name}?`,
                message: "Its saved panel state stays until you delete its data.",
                confirmText: "Uninstall",
                destructive: true,
                onConfirm: () => change(() => clientPluginStore.uninstall(record.pluginId)),
              })
            }
          />
          <ListActionRow
            tone="danger"
            label="Delete data"
            onPress={() =>
              confirm({
                title: `Delete ${record.name}'s data?`,
                message: "This removes the panel state it saved on this device.",
                confirmText: "Delete data",
                destructive: true,
                onConfirm: () => change(() => clientPluginStore.deleteData(record.pluginId)),
              })
            }
          />
        </ListSection>
      ))}
    </>
  );
}

function statusLabel(record: PluginInstallRecord): string {
  if (!record.enabled) return "Disabled";
  if (record.manifest.backend === undefined) return "Enabled";
  switch (record.status) {
    case "running":
      return "Running";
    case "starting":
      return "Starting";
    case "failed":
      return "Failed";
    case "missing-prerequisite":
      return "Missing prerequisite";
    default:
      return "Stopped";
  }
}

const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function EnvironmentPlugins(props: { readonly environment: EnvironmentPresentation }) {
  const { environmentId, label } = props.environment;
  const registry = useContext(RegistryContext);
  const snapshot = useAtomValue(pluginRegistryAtom(environmentId));
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
  const [busy, setBusy] = useState(false);

  // Backends run with this account's privileges, so installing one needs the author's trust.
  const submitPackage = (target: PluginInstallRecord | null) => {
    void (async () => {
      const picked = await pickPackage();
      if (picked === null) return;
      const manifest = await readPluginArchiveManifest(picked.bytes);
      if (target !== null && manifest.id !== target.pluginId) {
        throw new Error(`This package is ${manifest.name}, not ${target.name}.`);
      }
      const send = (trustBackendAuthor: boolean) => {
        setBusy(true);
        return uploadPluginPackage(registry, environmentId, picked)
          .then(async (attachmentId) => {
            const input = { attachmentId, trustBackendAuthor };
            const result =
              target === null
                ? await installCommand({ environmentId, input })
                : await updateCommand({
                    environmentId,
                    input: { ...input, pluginId: target.pluginId },
                  });
            if (result._tag === "Success") {
              Dialog.alert(
                `${target === null ? "Installed" : "Updated"} ${result.value.name} ${result.value.version} on ${label}`,
              );
            } else {
              Dialog.alert(
                `Could not ${target === null ? "install" : "update"} ${manifest.name}`,
                failureText(result),
              );
            }
          })
          .catch((error: unknown) =>
            Dialog.alert(`Could not upload ${manifest.name}`, errorText(error)),
          )
          .finally(() => setBusy(false));
      };
      if (manifest.backend === undefined) {
        await send(false);
        return;
      }
      confirm({
        title: `Trust ${manifest.author}?`,
        message: `${manifest.name} runs a backend on ${label} with the same access as T3 Code there: your files, network, and credentials. Install it only if you trust its author.`,
        confirmText: "I trust this author",
        onConfirm: () => void send(true),
      });
    })().catch((error: unknown) =>
      Dialog.alert("This is not a T3 Code plugin package", errorText(error)),
    );
  };

  const target = (record: PluginInstallRecord) => ({
    environmentId,
    input: { pluginId: record.pluginId },
  });
  const showLogs = (record: PluginInstallRecord) =>
    void logs({ environmentId, input: { pluginId: record.pluginId, limit: 200 } }).then((result) =>
      Dialog.alert(
        `${record.name} logs`,
        result._tag === "Success"
          ? result.value.lines
              .slice(-40)
              .map((entry) => entry.line)
              .join("\n") || "No output yet."
          : failureText(result),
      ),
    );
  const confirmDeleteData = (pluginId: PluginId, name: string) =>
    confirm({
      title: `Delete ${name}'s data?`,
      message: `This permanently removes everything it stored on ${label}.`,
      confirmText: "Delete data",
      destructive: true,
      onConfirm: () => void deleteData({ environmentId, input: { pluginId } }),
    });

  const installed = AsyncResult.isSuccess(snapshot) ? snapshot.value.installed : [];
  const retained = AsyncResult.isSuccess(snapshot)
    ? snapshot.value.retainedData.filter(
        (entry) => !installed.some((record) => record.pluginId === entry.pluginId),
      )
    : [];

  return (
    <>
      <ListSection
        title={`On ${label}`}
        footer={
          AsyncResult.isFailure(snapshot)
            ? `Plugins are unavailable here. Update T3 Code on ${label} to install plugins there.`
            : "Packages with a backend run on this environment and reach agents as tools."
        }
      >
        <ListActionRow
          icon="plus"
          label="Install from file"
          disabled={!canMaintain || AsyncResult.isFailure(snapshot)}
          loading={busy}
          onPress={() => submitPackage(null)}
        />
      </ListSection>
      {installed.map((record) => {
        const hasBackend = record.manifest.backend !== undefined;
        const running = record.status === "running" || record.status === "starting";
        const detail = [record.statusDetail, record.failedUpdate?.reason]
          .filter(Boolean)
          .join("\n");
        return (
          <ListSection key={record.pluginId} title={`${record.name} ${record.version}`}>
            <ListRowLayout
              label={statusLabel(record)}
              description={[`By ${record.author}`, detail].filter(Boolean).join("\n")}
            />
            <ListToggleRow
              label="Enabled"
              disabled={!canConfigure}
              value={record.enabled}
              onValueChange={(enabled) =>
                void setEnabled({ environmentId, input: { pluginId: record.pluginId, enabled } })
              }
            />
            {record.enabled ? (
              <PanelRows
                scope={environmentId}
                pluginId={record.pluginId}
                manifest={record.manifest}
              />
            ) : null}
            {record.enabled && hasBackend ? (
              <ListActionRow
                label={running ? "Stop" : "Start"}
                disabled={!canConfigure}
                onPress={() => void (running ? stop(target(record)) : start(target(record)))}
              />
            ) : null}
            {hasBackend ? (
              <ListActionRow
                label="Restart"
                disabled={!canConfigure || !record.enabled}
                onPress={() => void restart(target(record))}
              />
            ) : null}
            {hasBackend ? (
              <ListActionRow
                label="Logs"
                disabled={!canReadLogs}
                onPress={() => showLogs(record)}
              />
            ) : null}
            <ListActionRow
              label="Update from file"
              disabled={!canMaintain || busy}
              onPress={() => submitPackage(record)}
            />
            <ListActionRow
              tone="danger"
              label="Uninstall"
              disabled={!canMaintain}
              onPress={() =>
                confirm({
                  title: `Uninstall ${record.name}?`,
                  message: `This stops it on ${label} and removes its tools. Its data stays until you delete it.`,
                  confirmText: "Uninstall",
                  destructive: true,
                  onConfirm: () => void uninstall(target(record)),
                })
              }
            />
            <ListActionRow
              tone="danger"
              label="Delete data"
              description={record.enabled ? "Disable it first." : undefined}
              disabled={!canMaintain || record.enabled}
              onPress={() => confirmDeleteData(record.pluginId, record.name)}
            />
          </ListSection>
        );
      })}
      {retained.length > 0 ? (
        <ListSection title={`Data kept on ${label}`}>
          {retained.map((entry) => (
            <ListActionRow
              key={entry.pluginId}
              tone="danger"
              label={`Delete data from ${entry.pluginId}`}
              description={`${formatBytes(entry.bytes)} kept after uninstall.`}
              disabled={!canMaintain}
              onPress={() => confirmDeleteData(entry.pluginId, entry.pluginId)}
            />
          ))}
        </ListSection>
      ) : null}
    </>
  );
}
