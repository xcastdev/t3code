import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { T, useGT, Var } from "gt-react";
import { m } from "~/i18n/messages";
import { ChevronDownIcon, ChevronUpIcon, GlobeIcon } from "lucide-react";
import { type MouseEvent, useState } from "react";

import {
  resolveExternalServerUrl,
  tunnelsEnvironmentLoopback,
} from "../../browser/browserTargetResolver";
import { readLocalApi } from "../../localApi";
import { isMacPlatform } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import {
  canForwardPorts,
  findPortForward,
  forwardedUrl,
  forwardPort,
  stopPortForward,
  useForwardLocality,
  usePortForwards,
} from "../../state/portForwards";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { openDiscoveredPort } from "../preview/openDiscoveredPort";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadProcessRow } from "./ThreadProcessRow";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const SERVER_PAGE_COUNT = 4;

interface ThreadServerRowsProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
}

/** Local servers the thread's terminals and agent started, as rows for Processes. */
export function ThreadServerRows(props: ThreadServerRowsProps) {
  return <ThreadServerRowList key={`${props.environmentId}:${props.threadId}`} {...props} />;
}

function ThreadServerRowList(props: ThreadServerRowsProps) {
  const gt = useGT();
  const { servers } = props;
  const canOpen = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const canStop = useAtomValue(
    previewEnvironment.stopLocalServer.permissionAtom(props.environmentId),
  );
  const environment = useEnvironment(props.environmentId);
  const supportsStop = environment?.serverConfig?.environment.capabilities.localServerStop === true;
  const forwards = usePortForwards();
  const forwardable =
    useEnvironmentScope(props.environmentId, AuthTerminalOperateScope) &&
    environment?.connection.phase === "connected" &&
    canForwardPorts(environment);
  const locality = useForwardLocality(forwardable ? props.environmentId : null);
  const canForward = locality === "remote";
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const stopServer = useAtomCommand(previewEnvironment.stopLocalServer, {
    label: "thread server stop",
  });
  const [visibleCount, setVisibleCount] = useState(SERVER_PAGE_COUNT);
  if (servers.length === 0) return null;
  const externalClickLabel = isMacPlatform(navigator.platform) ? "⌘-click" : "Ctrl-click";
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: thrownErrorMessage(error, m) ?? String(error),
      }),
    );
  };

  const open = async (server: DiscoveredLocalServer, event: MouseEvent<HTMLElement>) => {
    if (event.button > 1) return;
    // Like links: modified and middle clicks go to the system browser.
    if (event.metaKey || event.ctrlKey || event.button === 1) {
      event.preventDefault();
      // This machine's browser reaches another environment's loopback only through a forward.
      // Starting a forward runs the probe; only a confirmed local environment opens directly.
      const forwarding = forwardable && locality !== "local";
      const url = forwarding
        ? await forwardPort(props.environmentId, server.port).then(
            (forward) => forwardedUrl(forward, server.url),
            (error: unknown) => {
              reportFailure(gt("Could not forward port {port}", { port: server.port }), error);
              return null;
            },
          )
        : resolveExternalServerUrl(props.environmentId, server.url);
      if (url === null) return;
      // Without a forward, a remote environment's localhost would open this machine's instead.
      if (
        !forwarding &&
        locality !== "local" &&
        tunnelsEnvironmentLoopback(environment?.entry.target) &&
        isLoopbackHost(new URL(url).hostname)
      ) {
        reportFailure(
          gt("Unable to open in browser"),
          new Error(
            gt(
              "localhost:{port} runs on another machine, and port forwarding isn't available for it right now.",
              { port: server.port },
            ),
          ),
        );
        return;
      }
      await readLocalApi()
        ?.shell.openExternal(url)
        .catch((error: unknown) => reportFailure(gt("Unable to open in browser"), error));
      return;
    }
    const result = await openDiscoveredPort({ threadRef, port: server, openPreview });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Unable to open preview"), squashAtomCommandFailure(result));
    }
  };

  const stop = async (server: DiscoveredLocalServer) => {
    if (server.pid === null) return;
    const result = await stopServer({
      environmentId: props.environmentId,
      input: { pid: server.pid, port: server.port },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not stop server"), squashAtomCommandFailure(result));
    }
  };

  const toggleForward = async (server: DiscoveredLocalServer, forwarded: boolean) => {
    await (
      forwarded
        ? stopPortForward(props.environmentId, server.port)
        : forwardPort(props.environmentId, server.port)
    ).then(
      () => undefined,
      (error: unknown) =>
        reportFailure(gt("Could not forward port {port}", { port: server.port }), error),
    );
  };

  const hiddenCount = Math.max(0, servers.length - visibleCount);
  const row = (server: DiscoveredLocalServer) => {
    const forward = findPortForward(forwards, props.environmentId, server.port);
    return (
      <ThreadProcessRow
        key={`${server.pid}:${server.port}`}
        icon={<GlobeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
        title={`localhost:${server.port}`}
        detail={[
          // First, so the narrow panel truncates the less useful parts.
          forward
            ? gt("Forwarded to :{port}", {
                $context: "a remote dev server reachable on this machine's port",
                port: forward.localPort,
              })
            : null,
          gt("Server", { $context: "kind of a running process" }),
          server.processName,
        ]
          .filter(Boolean)
          .join(" · ")}
        open={{
          tooltip: gt("Open in the browser panel. {externalClickLabel} for your browser.", {
            externalClickLabel,
          }),
          disabled: !canOpen,
          onOpen: (event) => void open(server, event),
        }}
        {...(canForward
          ? {
              forward: {
                active: forward !== undefined,
                label: forward
                  ? gt("Stop forwarding localhost:{port}", { port: server.port })
                  : gt("Forward localhost:{port} to this machine", { port: server.port }),
                tooltip: forward
                  ? gt("Forwarded to localhost:{localPort} on this machine. Click to stop.", {
                      localPort: forward.localPort,
                    })
                  : gt("Forward to this machine, for any app here"),
                onAction: () => toggleForward(server, forward !== undefined),
              },
            }
          : {})}
        {...(canStop && supportsStop && server.pid !== null
          ? {
              stop: {
                label: gt("Stop localhost:{port}", { port: server.port }),
                tooltip: gt("Stop server"),
                onAction: () => stop(server),
              },
            }
          : {})}
      />
    );
  };
  const overflow = servers.slice(SERVER_PAGE_COUNT, visibleCount);

  return (
    <>
      {servers.slice(0, SERVER_PAGE_COUNT).map(row)}
      {overflow.length > 0 ? (
        <li data-thread-details-server-overflow>
          <ul className="m-0 list-none p-0">{overflow.map(row)}</ul>
        </li>
      ) : null}
      {servers.length > SERVER_PAGE_COUNT ? (
        <li>
          <ThreadDetailsControl
            variant="ghost"
            size="sm"
            onClick={() =>
              setVisibleCount(
                hiddenCount > 0 ? visibleCount + SERVER_PAGE_COUNT : SERVER_PAGE_COUNT,
              )
            }
            part="row"
            tone="muted"
            className="w-full active:scale-100"
          >
            {hiddenCount > 0 ? (
              <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
            ) : (
              <ChevronUpIcon aria-hidden className="size-4 shrink-0" />
            )}
            {hiddenCount > 0 ? (
              <T>
                Show <Var>{Math.min(hiddenCount, SERVER_PAGE_COUNT)}</Var> more
              </T>
            ) : (
              <T>Show less</T>
            )}
          </ThreadDetailsControl>
        </li>
      ) : null}
    </>
  );
}
