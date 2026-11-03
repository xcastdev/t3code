import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  PluginAttachRequest,
  PluginBridgeOptions,
} from "@t3tools/client-runtime/plugins/bridge";
import type { ClientPluginPanelState } from "@t3tools/client-runtime/plugins/client-packages";
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
import { Link, useRouter } from "@tanstack/react-router";
import { PuzzleIcon } from "lucide-react";
import { useContext, useState } from "react";

import { useLongLivedAssetUrl } from "~/assets/longLivedAssetUrls";
import {
  attachPluginRequestToChat,
  type PluginAttachSource,
  type PluginChatTarget,
} from "~/plugins/attachToChat";
import { clientPluginStore } from "~/plugins/clientPluginStore";
import { openPluginPanel } from "~/plugins/openPluginPanel";
import {
  refreshClientPlugins,
  usePluginPanelInstall,
  type PluginPanelInstall,
} from "~/plugins/pluginInstalls";
import { pluginEnvironment } from "~/state/plugins";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { usePluginAttachConfirm } from "./PluginAttachConfirm";
import { PluginLogsDialog, type PluginLogsView } from "./PluginLogsDialog";
import { PluginPanelFrame } from "./PluginPanelFrame";

type PluginBackend = NonNullable<PluginBridgeOptions["backend"]>;

/** What a panel host reaches outside React; tests replace it. */
export interface PluginPanelServices {
  readonly readState: (panelKey: PluginPanelKey) => Promise<ClientPluginPanelState | null>;
  readonly writeState: (panelKey: PluginPanelKey, value: unknown, version: string) => Promise<void>;
  readonly backend: (target: {
    readonly environmentId: EnvironmentId;
    readonly pluginId: PluginId;
    readonly version: string;
    readonly manifest: PluginManifest;
  }) => PluginBackend;
  readonly attach: (
    request: PluginAttachRequest,
    chatTarget: PluginChatTarget,
    source: PluginAttachSource,
  ) => Promise<"inserted" | "cancelled">;
  readonly openPanel: (key: PluginPanelKey) => void;
}

/** `null` when this session lacks the permission, as Settings gates the same controls. */
export interface PluginPanelActions {
  readonly enable: (() => void) | null;
  readonly start: (() => void) | null;
  readonly restart: (() => void) | null;
  readonly showLogs: (() => void) | null;
}

const isPluginRequestError = Schema.is(PluginRequestError);

const clientPackageIds = new WeakMap<object, string>();

/** Names a client package's panel documents, so a same-version reinstall mounts fresh frames. */
function clientPackageId(panelHtml: Readonly<Record<string, string>>): string {
  const cached = clientPackageIds.get(panelHtml);
  if (cached !== undefined) return cached;
  let hash = 0x811c9dc5;
  let length = 0;
  for (const [panelId, html] of Object.entries(panelHtml).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (const text of [panelId, html]) {
      length += text.length;
      for (let index = 0; index < text.length; index += 1) {
        hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
      }
    }
  }
  const id = `${length}:${(hash >>> 0).toString(36)}`;
  clientPackageIds.set(panelHtml, id);
  return id;
}

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

function PluginPanelState(props: {
  readonly title: string;
  readonly description?: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <Empty size="compact" className="size-full">
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.description ? <EmptyDescription>{props.description}</EmptyDescription> : null}
      </EmptyHeader>
      {props.children ? <EmptyContent>{props.children}</EmptyContent> : null}
    </Empty>
  );
}

function SettingsLink() {
  return (
    <Button render={<Link to="/settings/plugins" />} size="sm" variant="outline">
      <PuzzleIcon />
      Settings → Plugins
    </Button>
  );
}

export function PluginPanelMissing() {
  return (
    <PluginPanelState
      title="This plugin is not installed"
      description="Install it, or open one that is, from Settings → Plugins."
    >
      <SettingsLink />
    </PluginPanelState>
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
  // The frame keeps its first URL: a re-minted one would reload the panel.
  const [src, setSrc] = useState<string | null>(null);
  const asset = useLongLivedAssetUrl(src === null ? props.environmentId : null, {
    _tag: "plugin-panel",
    pluginId: props.pluginId,
    panelId: props.panelId,
    version: props.version,
  });
  if (src === null && asset._tag === "Success") setSrc(asset.url);
  if (src !== null) return props.children(src);
  return asset._tag === "Failure" ? (
    <PluginPanelState title={`Unable to load ${props.title}`} />
  ) : null;
}

/** Shows one panel's install state, and its frame only when it can run. */
export function PluginPanelView(props: {
  readonly panelKey: PluginPanelKey;
  readonly install: PluginPanelInstall;
  readonly chatTarget: PluginChatTarget;
  readonly services: PluginPanelServices;
  readonly actions: PluginPanelActions;
}) {
  const { install, panelKey, services } = props;
  const parsed = parsePluginPanelKey(panelKey);
  if (install.kind === "loading") return null;
  if (install.kind === "missing" || parsed === undefined) return <PluginPanelMissing />;
  if (install.kind === "disconnected") {
    return (
      <PluginPanelState
        title={`${install.environmentLabel} is not connected`}
        description="Reconnect it to use this plugin, or manage plugins in Settings → Plugins."
      >
        <SettingsLink />
      </PluginPanelState>
    );
  }
  const { record } = install;
  const manifest = record.manifest;
  const panel = manifest.ui?.panels.find((entry) => entry.id === parsed.panelId);
  if (panel === undefined) return null;
  if (!record.enabled) {
    return (
      <PluginPanelState title={`${manifest.name} is disabled`}>
        <Button
          size="sm"
          disabled={props.actions.enable === null}
          onClick={props.actions.enable ?? undefined}
        >
          Enable
        </Button>
      </PluginPanelState>
    );
  }
  if (install.kind === "environment" && manifest.backend !== undefined) {
    const { status, statusDetail, failedUpdate } = install.record;
    if (status === "stopped" || status === "disabled") {
      return (
        <PluginPanelState
          title={`${manifest.name} is not running`}
          description={`Its backend on ${install.environmentLabel} is stopped.`}
        >
          <Button
            size="sm"
            disabled={props.actions.start === null}
            onClick={props.actions.start ?? undefined}
          >
            Start
          </Button>
        </PluginPanelState>
      );
    }
    if (status === "failed" || status === "missing-prerequisite") {
      return (
        <PluginPanelState
          title={`${manifest.name} failed`}
          {...(statusDetail === undefined ? {} : { description: statusDetail })}
        >
          {failedUpdate ? (
            <p className="text-muted-foreground text-sm">{failedUpdate.reason}</p>
          ) : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={props.actions.restart === null}
              onClick={props.actions.restart ?? undefined}
            >
              Restart
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={props.actions.showLogs === null}
              onClick={props.actions.showLogs ?? undefined}
            >
              Logs
            </Button>
          </div>
        </PluginPanelState>
      );
    }
  }

  const version = record.version;
  const attachSource: PluginAttachSource =
    install.kind === "client"
      ? { kind: "client", pluginId: record.pluginId, pluginName: manifest.name }
      : {
          kind: "environment",
          environmentId: install.environmentId,
          environmentLabel: install.environmentLabel,
          pluginId: record.pluginId,
          pluginName: manifest.name,
        };
  const bridge = {
    manifest,
    panelId: panel.id,
    pluginVersion: version,
    state: {
      get: () => services.readState(panelKey),
      set: (value: unknown) => services.writeState(panelKey, value, version),
    },
    ...(install.kind === "environment" && manifest.backend !== undefined
      ? {
          backend: services.backend({
            environmentId: install.environmentId,
            pluginId: record.pluginId,
            version,
            manifest,
          }),
        }
      : {}),
    openSurface: async (contributionId: string) => {
      const command = manifest.ui?.commands.find((entry) => entry.id === contributionId);
      services.openPanel(
        pluginPanelKey(parsed.scope, record.pluginId, command?.opens.panel ?? contributionId),
      );
    },
    attach: (request: PluginAttachRequest) =>
      services.attach(request, props.chatTarget, attachSource),
  };
  const frameKey = `${panelKey}@${version}`;
  if (install.kind === "client") {
    const html = install.record.panelHtml[panel.id];
    if (html === undefined) return null;
    return (
      <PluginPanelFrame
        key={`${frameKey}#${clientPackageId(install.record.panelHtml)}`}
        title={panel.title}
        document={{ kind: "srcdoc", html }}
        bridge={bridge}
        destination={{ kind: "client" }}
        chatTarget={props.chatTarget}
      />
    );
  }
  const destination = {
    kind: "environment" as const,
    environmentId: install.environmentId,
    label: install.environmentLabel,
  };
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
        <PluginPanelFrame
          title={panel.title}
          document={{ kind: "src", url }}
          bridge={bridge}
          destination={destination}
          chatTarget={props.chatTarget}
        />
      )}
    </ServerPanelDocument>
  );
}

/** A plugin panel in any host. Its UI state lives in bridge state, never in the host. */
export function PluginPanelSurface(props: {
  readonly panelKey: PluginPanelKey;
  readonly chatTarget: PluginChatTarget;
}) {
  const registry = useContext(RegistryContext);
  const router = useRouter();
  const install = usePluginPanelInstall(props.panelKey);
  const installEnvironmentId = install.kind === "environment" ? install.environmentId : null;
  const canConfigure = useAtomValue(
    pluginEnvironment.setEnabled.permissionAtom(installEnvironmentId),
  );
  const canReadLogs = useAtomValue(pluginEnvironment.logs.permissionAtom(installEnvironmentId));
  const setEnabled = useAtomCommand(pluginEnvironment.setEnabled);
  const start = useAtomCommand(pluginEnvironment.start);
  const restart = useAtomCommand(pluginEnvironment.restart);
  const logs = useAtomCommand(pluginEnvironment.logs, { reportFailure: false });
  const [logsView, setLogsView] = useState<PluginLogsView | null>(null);
  const attachConfirm = usePluginAttachConfirm();

  const services: PluginPanelServices = {
    readState: (panelKey) => clientPluginStore.readState(panelKey),
    writeState: (panelKey, value, version) =>
      clientPluginStore.writeState(panelKey, value, version),
    backend: ({ environmentId, pluginId, version, manifest }) => ({
      call: async (operation, input) => {
        const mutates =
          manifest.backend?.operations.find((entry) => entry.name === operation)?.mutates ?? true;
        const result = await runAtomCommand(
          registry,
          mutates ? pluginEnvironment.mutate : pluginEnvironment.query,
          {
            environmentId,
            input: {
              pluginId,
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
            input: { pluginId, topic, params: params as Schema.Json, expectedVersion: version },
          },
          onEvent,
          (error) => onEvent({ type: "closed", reason: subscriptionClosedReason(error) }),
        ),
    }),
    attach: (request, chatTarget, source) =>
      attachPluginRequestToChat(request, { chatTarget, source, confirm: attachConfirm.confirm }),
    openPanel: (key) => openPluginPanel(router, key),
  };

  const environmentTarget =
    install.kind === "environment"
      ? { environmentId: install.environmentId, input: { pluginId: install.record.pluginId } }
      : null;
  const actions: PluginPanelActions = {
    enable:
      install.kind === "client"
        ? () =>
            void clientPluginStore
              .setEnabled(install.record.pluginId, true)
              .then(refreshClientPlugins)
        : environmentTarget !== null && canConfigure
          ? () =>
              void setEnabled({
                environmentId: environmentTarget.environmentId,
                input: { ...environmentTarget.input, enabled: true },
              })
          : null,
    start: environmentTarget !== null && canConfigure ? () => void start(environmentTarget) : null,
    restart:
      environmentTarget !== null && canConfigure ? () => void restart(environmentTarget) : null,
    showLogs:
      install.kind === "environment" && environmentTarget !== null && canReadLogs
        ? () => {
            const pluginName = install.record.manifest.name;
            void logs({
              environmentId: environmentTarget.environmentId,
              input: { ...environmentTarget.input, limit: 200 },
            }).then((result) =>
              setLogsView(
                result._tag === "Success"
                  ? { pluginName, lines: result.value.lines }
                  : { pluginName, error: String(squashAtomCommandFailure(result)) },
              ),
            );
          }
        : null,
  };

  return (
    <>
      <PluginPanelView
        panelKey={props.panelKey}
        install={install}
        chatTarget={props.chatTarget}
        services={services}
        actions={actions}
      />
      {logsView ? <PluginLogsDialog view={logsView} onClose={() => setLogsView(null)} /> : null}
      {attachConfirm.dialog}
    </>
  );
}
