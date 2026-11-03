import { RegistryContext } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { PluginBridgeOptions } from "@t3tools/client-runtime/plugins/bridge";
import {
  parsePluginPanelKey,
  pluginPanelKey,
  type PluginPanelKey,
} from "@t3tools/client-runtime/plugins/commands";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  PluginRequestError,
  type EnvironmentId,
  type PluginId,
  type PluginManifest,
  type PluginSubscriptionEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useContext, useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAssetUrlState } from "../../state/assets";
import { pluginEnvironment } from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { openSettings } from "../settings/settings-navigation";
import { attachPluginRequestToChat } from "./attachToChat";
import { clientPluginStore } from "./clientPluginStore";
import {
  refreshClientPlugins,
  usePluginPanelInstall,
  type PluginPanelInstall,
} from "./pluginInstalls";
import { PluginWebView } from "./PluginWebView";
import { useRecentPluginChat, type PluginChatThread } from "./recentChat";

type PluginBackend = NonNullable<PluginBridgeOptions["backend"]>;

export type PluginPanelRouteParams = {
  readonly scope: string;
  readonly pluginId: string;
  readonly panelId: string;
};

const isPluginRequestError = Schema.is(PluginRequestError);

const subscriptionClosedReason = (
  error: unknown,
): Extract<PluginSubscriptionEvent, { type: "closed" }>["reason"] => {
  if (!isPluginRequestError(error)) return "worker-failed";
  switch (error.reason) {
    case "disabled":
      return "plugin-disabled";
    case "version-changed":
      return "plugin-updated";
    case "not-installed":
      return "plugin-uninstalled";
    case "too-large":
      return "too-large";
    default:
      return "worker-failed";
  }
};

const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.";
};

/** A plugin panel on its own screen; it never depends on a thread. */
export function PluginPanelRouteScreen(props: StaticScreenProps<PluginPanelRouteParams>) {
  const { scope, pluginId, panelId } = props.route.params;
  const parsed = parsePluginPanelKey(`${scope}:${pluginId}:${panelId}`);
  const panelKey =
    parsed === undefined ? null : pluginPanelKey(parsed.scope, parsed.pluginId, parsed.panelId);
  const install = usePluginPanelInstall(panelKey);
  const chat = useRecentPluginChat(scope);
  const record =
    install.kind === "client" || install.kind === "environment" ? install.record : null;
  const title =
    record?.manifest.ui?.panels.find((panel) => panel.id === panelId)?.title ?? "Plugin";
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title, headerTitle: title }} />
      {panelKey === null ? (
        <PluginPanelMissing />
      ) : (
        <PluginPanelSurface panelKey={panelKey} install={install} chat={chat} />
      )}
    </View>
  );
}

function PluginPanelMissing() {
  const navigation = useNavigation();
  return (
    <View className="flex-1 justify-center">
      <EmptyState
        variant="plain"
        title="This plugin is not installed"
        detail="Install it, or open one that is, from Settings → Plugins."
        actionLabel="Open Settings"
        onAction={() => openSettings(navigation, "SettingsPlugins")}
      />
    </View>
  );
}

function PanelState(props: {
  readonly title: string;
  readonly detail: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  return (
    <View className="flex-1 justify-center">
      <EmptyState variant="plain" {...props} />
    </View>
  );
}

function ServerPanelDocument(props: {
  readonly environmentId: EnvironmentId;
  readonly pluginId: PluginId;
  readonly panelId: string;
  readonly version: string;
  readonly title: string;
  readonly children: (url: string) => React.ReactNode;
}) {
  // The view keeps its first URL: a re-minted one would reload the panel.
  const [url, setUrl] = useState<string | null>(null);
  const asset = useAssetUrlState(url === null ? props.environmentId : null, {
    _tag: "plugin-panel",
    pluginId: props.pluginId,
    panelId: props.panelId,
    version: props.version,
  });
  if (url === null && asset._tag === "Success") setUrl(asset.url);
  if (url !== null) return props.children(url);
  return asset._tag === "Failure" ? (
    <PanelState
      title={`Unable to load ${props.title}`}
      detail="Check the connection and reopen it."
    />
  ) : null;
}

/** Shows one panel's install state, and its WebView only when it can run. */
function PluginPanelSurface(props: {
  readonly panelKey: PluginPanelKey;
  readonly install: PluginPanelInstall;
  readonly chat: PluginChatThread | null;
}) {
  const { install, panelKey, chat } = props;
  const registry = useContext(RegistryContext);
  const navigation = useNavigation();
  const setEnabled = useAtomCommand(pluginEnvironment.setEnabled);
  const start = useAtomCommand(pluginEnvironment.start);
  const restart = useAtomCommand(pluginEnvironment.restart);
  const logs = useAtomCommand(pluginEnvironment.logs, { reportFailure: false });

  const parsed = parsePluginPanelKey(panelKey);
  if (install.kind === "loading") return null;
  if (install.kind === "missing" || parsed === undefined) return <PluginPanelMissing />;
  const { record } = install;
  const manifest = record.manifest;
  const panel = manifest.ui?.panels.find((entry) => entry.id === parsed.panelId);
  if (panel === undefined) return <PluginPanelMissing />;
  const environmentTarget =
    install.kind === "environment"
      ? { environmentId: install.environmentId, input: { pluginId: install.record.pluginId } }
      : null;

  if (!record.enabled) {
    return (
      <PanelState
        title={`${manifest.name} is disabled`}
        detail="Enable it to open this panel."
        actionLabel="Enable"
        onAction={() => {
          if (environmentTarget === null) {
            void clientPluginStore.setEnabled(record.pluginId, true).then(refreshClientPlugins);
          } else {
            void setEnabled({
              environmentId: environmentTarget.environmentId,
              input: { ...environmentTarget.input, enabled: true },
            });
          }
        }}
      />
    );
  }
  if (install.kind === "environment" && environmentTarget !== null && manifest.backend) {
    const { status, statusDetail, failedUpdate } = install.record;
    if (status === "stopped" || status === "disabled") {
      return (
        <PanelState
          title={`${manifest.name} is not running`}
          detail={`Its backend on ${install.environmentLabel} is stopped.`}
          actionLabel="Start"
          onAction={() => void start(environmentTarget)}
        />
      );
    }
    if (status === "failed" || status === "missing-prerequisite") {
      const showLogs = () =>
        void logs({
          environmentId: environmentTarget.environmentId,
          input: { ...environmentTarget.input, limit: 200 },
        }).then((result) =>
          Dialog.alert(
            `${manifest.name} logs`,
            result._tag === "Success"
              ? result.value.lines
                  .slice(-40)
                  .map((entry) => entry.line)
                  .join("\n") || "No output yet."
              : failureText(result),
          ),
        );
      return (
        <View className="flex-1 justify-center">
          <EmptyState
            variant="plain"
            title={`${manifest.name} failed`}
            detail={
              [statusDetail, failedUpdate?.reason].filter(Boolean).join("\n\n") ||
              "Its backend stopped with an error."
            }
            action={
              <View className="flex-row gap-3">
                <Button
                  tone="primary"
                  label="Restart"
                  onPress={() => void restart(environmentTarget)}
                />
                <Button label="Logs" onPress={showLogs} />
              </View>
            }
          />
        </View>
      );
    }
  }

  const version = record.version;
  const destination =
    install.kind === "environment"
      ? {
          kind: "environment" as const,
          environmentId: install.environmentId,
          label: install.environmentLabel,
        }
      : { kind: "client" as const };
  const backend = (environmentId: EnvironmentId, manifestValue: PluginManifest): PluginBackend => ({
    call: async (operation, input) => {
      const mutates =
        manifestValue.backend?.operations.find((entry) => entry.name === operation)?.mutates ??
        true;
      const result = await runAtomCommand(
        registry,
        mutates ? pluginEnvironment.mutate : pluginEnvironment.query,
        {
          environmentId,
          input: {
            pluginId: record.pluginId,
            operation,
            input: input as Schema.Json,
            expectedVersion: version,
          },
        },
        { reportFailure: false },
      );
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      return result.value;
    },
    subscribe: (topic, params, onEvent) =>
      pluginEnvironment.events(
        registry,
        {
          environmentId,
          input: {
            pluginId: record.pluginId,
            topic,
            params: params as Schema.Json,
            expectedVersion: version,
          },
        },
        onEvent,
        (error) => onEvent({ type: "closed", reason: subscriptionClosedReason(error) }),
      ),
  });
  const bridge = {
    manifest,
    panelId: panel.id,
    pluginVersion: version,
    state: {
      get: () => clientPluginStore.readState(panelKey),
      set: (value: unknown) => clientPluginStore.writeState(panelKey, value, version),
    },
    ...(install.kind === "environment" && manifest.backend !== undefined
      ? { backend: backend(install.environmentId, manifest) }
      : {}),
    openSurface: async (contributionId: string) => {
      const command = manifest.ui?.commands.find((entry) => entry.id === contributionId);
      const target = command?.opens.panel ?? contributionId;
      if (target === parsed.panelId) return;
      navigation.dispatch(
        StackActions.push("PluginPanel", {
          scope: parsed.scope,
          pluginId: record.pluginId,
          panelId: target,
        }),
      );
    },
    attach: (request: Parameters<PluginBridgeOptions["attach"]>[0]) =>
      attachPluginRequestToChat({ request, chat, manifest, destination }),
  };
  const chatTarget = chat === null ? null : { key: chat.key, title: chat.title };
  const frameKey = `${panelKey}@${version}`;
  if (install.kind === "client") {
    const html = install.record.panelHtml[panel.id];
    if (html === undefined) return <PluginPanelMissing />;
    return (
      <PluginWebView
        key={frameKey}
        title={panel.title}
        document={{ kind: "srcdoc", html }}
        bridge={bridge}
        destination={destination}
        chatTarget={chatTarget}
      />
    );
  }
  return (
    <ServerPanelDocument
      key={frameKey}
      environmentId={install.environmentId}
      pluginId={record.pluginId}
      panelId={panel.id}
      version={version}
      title={panel.title}
    >
      {(url) => (
        <PluginWebView
          title={panel.title}
          document={{ kind: "src", url }}
          bridge={bridge}
          destination={destination}
          chatTarget={chatTarget}
        />
      )}
    </ServerPanelDocument>
  );
}
