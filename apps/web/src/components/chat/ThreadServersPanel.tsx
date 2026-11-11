import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, ChevronUpIcon, GlobeIcon } from "lucide-react";
import { type MouseEvent, useState } from "react";

import { resolveDiscoveredServerUrl } from "../../browser/browserTargetResolver";
import { readLocalApi } from "../../localApi";
import { isMacPlatform } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
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
  const { servers } = props;
  const canOpen = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const canStop = useAtomValue(
    previewEnvironment.stopLocalServer.permissionAtom(props.environmentId),
  );
  const supportsStop =
    useEnvironment(props.environmentId)?.serverConfig?.environment.capabilities.localServerStop ===
    true;
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
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const open = async (server: DiscoveredLocalServer, event: MouseEvent<HTMLElement>) => {
    if (event.button > 1) return;
    // Like links: modified and middle clicks go to the system browser.
    if (event.metaKey || event.ctrlKey || event.button === 1) {
      event.preventDefault();
      const url = resolveDiscoveredServerUrl(props.environmentId, server.url);
      await readLocalApi()
        ?.shell.openExternal(url)
        .catch((error: unknown) => reportFailure("Unable to open in browser", error));
      return;
    }
    const result = await openDiscoveredPort({ threadRef, port: server, openPreview });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Unable to open preview", squashAtomCommandFailure(result));
    }
  };

  const stop = async (server: DiscoveredLocalServer) => {
    if (server.pid === null) return;
    const result = await stopServer({
      environmentId: props.environmentId,
      input: { pid: server.pid, port: server.port },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not stop server", squashAtomCommandFailure(result));
    }
  };

  const hiddenCount = Math.max(0, servers.length - visibleCount);
  const row = (server: DiscoveredLocalServer) => (
    <ThreadProcessRow
      key={`${server.pid}:${server.port}`}
      icon={<GlobeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
      title={`localhost:${server.port}`}
      detail={["Server", server.processName].filter(Boolean).join(" · ")}
      open={{
        tooltip: `Open in the browser panel. ${externalClickLabel} for your browser.`,
        disabled: !canOpen,
        onOpen: (event) => void open(server, event),
      }}
      {...(canStop && supportsStop && server.pid !== null
        ? {
            stop: {
              label: `Stop localhost:${server.port}`,
              tooltip: "Stop server",
              onAction: () => stop(server),
            },
          }
        : {})}
    />
  );
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
            {hiddenCount > 0
              ? `Show ${Math.min(hiddenCount, SERVER_PAGE_COUNT)} more`
              : "Show less"}
          </ThreadDetailsControl>
        </li>
      ) : null}
    </>
  );
}
