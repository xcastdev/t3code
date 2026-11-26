import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import {
  makeMcpAppHost,
  McpAppHostRefusal,
  mcpAppStyleVariables,
  mcpResourceBytes,
  type McpAppCallToolResult,
  type McpAppDisplayMode,
  type McpAppHost,
  type McpAppHostContext,
} from "@t3tools/client-runtime/mcp-apps";
import type { PreviewAssetWidgetConnection } from "@t3tools/client-runtime/preview/server-browser-stream";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  clampMcpAppHeight,
  MCP_APP_COLOR_SCHEME_PARAM,
  MCP_APP_DEFAULT_HEIGHT,
  MCP_APP_MAX_HEIGHT,
  mcpAppAllowAttribute,
  mcpAppFileName,
  type McpAppReference,
} from "@t3tools/shared/mcpApp";
import { Minimize2Icon } from "lucide-react";
import { useEffect, useRef, useState, type FocusEvent, type ToggleEvent } from "react";
import { flushSync } from "react-dom";

import { useLongLivedAssetUrl } from "~/assets/longLivedAssetUrls";
import { APP_VERSION } from "~/branding";
import { isConfirmDialogActive, requestConfirmDialog } from "~/confirmDialog";
import { HostedAssetDocument } from "~/components/files/HostedAssetDocument";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { useStableCallback } from "~/hooks/useStableCallback";
import { Button } from "~/components/ui/button";
import { isElectron } from "~/env";
import { environmentRelayAdmissionRequired } from "~/connection/environmentTransport";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useTurnItemDetail } from "~/state/queries";
import { mcpAppEnvironment } from "~/state/mcpApps";
import { useAtomCommand } from "~/state/use-atom-command";
import { observeResize } from "~/lib/observeResize";
import { saveBlob } from "~/lib/saveBlob";
import { listenToWidgetFrame } from "../widgetFrameConnection";

const commandFailure = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) => {
  const error = squashAtomCommandFailure(result);
  return new McpAppHostRefusal({
    message:
      error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.",
  });
};

const fullscreenSupported =
  typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
// Exclude activation left by input elsewhere in T3.
const PAGE_ACTIVATION_MS = 5_000;

// Frame input does not bubble here. An app can refocus itself, so focus
// alone cannot exclude activation from input elsewhere in T3.
let lastPageInputAt = Number.NEGATIVE_INFINITY;
if (typeof window !== "undefined") {
  const note = () => {
    lastPageInputAt = performance.now();
  };
  if (navigator.userActivation?.isActive) note();
  for (const type of ["pointerdown", "pointerup", "touchend", "keydown"] as const) {
    window.addEventListener(type, note, true);
  }
}

interface McpAppFrameProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly conversationThreadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
  readonly app: McpAppReference;
  readonly onSendMessage: ((text: string) => Promise<void>) | undefined;
  readonly awaitingUser?: boolean;
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
}

export function McpAppFrame(props: McpAppFrameProps) {
  const owner = JSON.stringify([
    props.environmentId,
    props.threadId,
    props.itemId,
    props.conversationThreadId,
    props.app.attachmentId,
  ]);
  return <McpAppFrameView key={owner} {...props} />;
}

function McpAppFrameView(props: McpAppFrameProps) {
  const { app } = props;
  const theme = useHtmlRenderTheme();
  const hostedSlotRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(MCP_APP_DEFAULT_HEIGHT);
  const [navigatedAway, setNavigatedAway] = useState(false);
  const [displayMode, setDisplayMode] = useState<McpAppDisplayMode>("inline");
  const [closed, setClosed] = useState(false);
  const [documentGeneration, setDocumentGeneration] = useState(0);
  // Closing and reopening replaces the box, which re-attaches this.
  const attachBox = (box: HTMLDivElement) => {
    boxRef.current = box;
    setWidth(box.clientWidth);
    const stopResize = observeResize(box, ([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
      // Full screen reports the viewport, which can change height alone.
      if (fullscreenSupported && box.matches(":popover-open")) {
        hostRef.current?.updateHostContext();
      }
    });
    return () => {
      stopResize();
      boxRef.current = null;
    };
  };

  const resource = {
    _tag: "attachment" as const,
    attachmentId: app.attachmentId,
    fileName: mcpAppFileName(app),
    mimeType: "text/html",
    disposition: "inline" as const,
    renderIntent: "mcp-app" as const,
  };
  // The frame keeps its first URL: a re-minted one would reload the app.
  const [pinnedDocument, setPinnedDocument] = useState<{
    readonly src: string;
    readonly hosted: boolean;
  } | null>(null);
  const asset = useLongLivedAssetUrl(
    pinnedDocument === null ? props.environmentId : null,
    resource,
  );
  if (pinnedDocument === null && asset._tag === "Success") {
    if (environmentRelayAdmissionRequired(asset.url)) {
      setPinnedDocument({ src: asset.url, hosted: true });
    } else {
      // The app paints before `ui/initialize`, so it reads the initial scheme from its URL.
      const url = new URL(asset.url);
      url.searchParams.set(MCP_APP_COLOR_SCHEME_PARAM, theme.appearance);
      setPinnedDocument({ src: url.toString(), hosted: false });
    }
  }

  const detail = useTurnItemDetail({
    environmentId: props.environmentId,
    threadId: props.threadId,
    itemId: props.itemId,
    revision: props.revision,
  });
  const storedItem = detail.data?.item;
  // Keep tool-call identity stable for the host's delivery effect.
  const toolCall =
    storedItem?.type === "dynamic_tool"
      ? {
          arguments: storedItem.input,
          result: (storedItem.output as { readonly result?: unknown } | undefined)?.result as
            | McpAppCallToolResult
            | undefined,
        }
      : undefined;

  const callTool = useAtomCommand(mcpAppEnvironment.callTool, { reportFailure: false });
  const toolInfo = useAtomCommand(mcpAppEnvironment.toolInfo, { reportFailure: false });
  const toolDefinition = useEnvironmentQuery(
    mcpAppEnvironment.toolInfoQuery({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, itemId: props.itemId, name: app.tool },
    }),
  ).data?.tool;
  const readResource = useAtomCommand(mcpAppEnvironment.readResource, { reportFailure: false });
  const updateModelContext = useAtomCommand(mcpAppEnvironment.updateModelContext, {
    reportFailure: false,
  });

  // Read live values without rebuilding the host and losing the app session.
  const readLive = useStableCallback(() => ({
    theme,
    width,
    props,
    callTool,
    toolInfo,
    readResource,
    updateModelContext,
    displayMode,
    toolDefinition,
    toolCall,
  }));
  const hostRef = useRef<McpAppHost | null>(null);
  const connectionRef = useRef<PreviewAssetWidgetConnection | null>(null);

  const [stepAsideFor, setStepAsideFor] = useState(props.awaitingUser);
  if (stepAsideFor !== props.awaitingUser) {
    setStepAsideFor(props.awaitingUser);
    if (props.awaitingUser === true) setDisplayMode("inline");
  }
  // The box is in the top layer exactly while its full-screen chrome is
  // mounted, so every way out of full screen (including the step-aside above,
  // decided during render) closes the popover and releases the timeline pin.
  const attachFullscreenChrome = (chrome: HTMLDivElement) => {
    const box = chrome.parentElement;
    if (box === null) return;
    if (!box.matches(":popover-open")) box.showPopover();
    readLive().props.onFullscreenChange?.(true);
    return () => {
      if (box.matches(":popover-open")) box.hidePopover();
      readLive().props.onFullscreenChange?.(false);
    };
  };
  // Light dismiss (Escape) closes the popover without React.
  const onBoxToggle = (event: ToggleEvent<HTMLDivElement>) => {
    if (event.newState === "closed") setDisplayMode("inline");
  };
  const onBoxBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (
      displayMode === "fullscreen" &&
      next instanceof Node &&
      !event.currentTarget.contains(next)
    ) {
      setDisplayMode("inline");
    }
  };

  // Navigation retains the frame window; reject second loads to prevent impersonation.
  const loads = useRef({ generation: 0, count: 0 });
  const onFrameLoad = () => {
    if (loads.current.generation !== documentGeneration) {
      loads.current = { generation: documentGeneration, count: 0 };
    }
    loads.current.count += 1;
    if (loads.current.count > 1) {
      connectionRef.current?.dispose();
      setNavigatedAway(true);
    }
  };

  const connectHost = (
    post: (message: unknown) => void,
    frame?: HTMLIFrameElement,
  ): PreviewAssetWidgetConnection => {
    connectionRef.current?.dispose();
    let rendererActivation = false;
    const frameActivated = () =>
      frame !== undefined &&
      document.activeElement === frame &&
      navigator.userActivation?.isActive === true;
    const requireLiveHost = () => {
      if (hostRef.current !== host) {
        throw new McpAppHostRefusal({ message: "The app was closed." });
      }
    };
    const hostContext = (): McpAppHostContext => {
      const current = readLive();
      const viewport = frame ?? hostedSlotRef.current;
      return {
        theme: current.theme.appearance,
        styles: { variables: mcpAppStyleVariables(current.theme.variables) },
        displayMode: current.displayMode,
        availableDisplayModes: fullscreenSupported ? ["inline", "fullscreen"] : ["inline"],
        containerDimensions:
          current.displayMode === "fullscreen"
            ? {
                width: viewport?.clientWidth || window.innerWidth,
                height: viewport?.clientHeight || window.innerHeight,
              }
            : { width: current.width, maxHeight: MCP_APP_MAX_HEIGHT },
        platform: isElectron ? "desktop" : "web",
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        userAgent: `t3-code/${APP_VERSION}`,
        deviceCapabilities: {
          touch: window.matchMedia("(pointer: coarse)").matches,
          hover: window.matchMedia("(hover: hover)").matches,
        },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        ...(current.toolDefinition === undefined
          ? {}
          : { toolInfo: { tool: current.toolDefinition } }),
      };
    };
    // Return inline so approvals stay visible above the app.
    const ask = async (message: string) => {
      requireLiveHost();
      flushSync(() => setDisplayMode("inline"));
      const approved = await requestConfirmDialog(message);
      requireLiveHost();
      if (approved === undefined) {
        throw new McpAppHostRefusal({ message: "T3 could not ask for approval here." });
      }
      return approved;
    };
    const { environmentId, threadId, itemId, conversationThreadId } = readLive().props;
    const input = { threadId, itemId };
    const host = makeMcpAppHost({
      app,
      hostVersion: APP_VERSION,
      post,
      hostContext,
      callTool: async ({ name, arguments: args }) => {
        const info = await readLive().toolInfo({ environmentId, input: { ...input, name } });
        requireLiveHost();
        if (info._tag !== "Success") throw commandFailure(info);
        if (!info.value.callable)
          throw new McpAppHostRefusal({ message: "This app cannot call that tool." });
        if (!info.value.readOnly) {
          const approved = await ask(
            `Allow ${app.server} to run ${info.value.title ?? name}?\n${JSON.stringify(args, null, 2)}`,
          );
          if (approved !== true) throw new McpAppHostRefusal({ message: "Declined by the user." });
        }
        const result = await readLive().callTool({
          environmentId,
          input: { ...input, name, arguments: args },
        });
        if (result._tag !== "Success") throw commandFailure(result);
        return result.value;
      },
      readResource: async ({ uri }) => {
        const result = await readLive().readResource({
          environmentId,
          input: { ...input, uri },
        });
        if (result._tag !== "Success") throw commandFailure(result);
        return result.value;
      },
      openLink: async (url) => {
        if (!(frame === undefined ? rendererActivation : frameActivated())) {
          throw new McpAppHostRefusal({ message: "Links open only from a click in the app." });
        }
        window.open(url, "_blank", "noopener,noreferrer");
      },
      sendMessage: async (text) => {
        const send = readLive().props.onSendMessage;
        if (send === undefined)
          throw new McpAppHostRefusal({ message: "Messages are not available here." });
        const approved = await ask(`Send this message from ${app.server}?\n${text}`);
        if (approved !== true) throw new McpAppHostRefusal({ message: "Declined by the user." });
        await send(text);
      },
      updateModelContext: async (context) => {
        const result = await readLive().updateModelContext({
          environmentId,
          input: {
            ...input,
            ...context,
            conversationThreadId,
          },
        });
        if (result._tag !== "Success") throw commandFailure(result);
      },
      requestDisplayMode: async (mode) => {
        const otherFullscreen = document.querySelector("[data-mcp-app-fullscreen]");
        if (
          mode === "fullscreen" &&
          (!fullscreenSupported ||
            !(frame === undefined
              ? rendererActivation
              : frameActivated() && performance.now() - lastPageInputAt >= PAGE_ACTIVATION_MS) ||
            readLive().props.awaitingUser === true ||
            isConfirmDialogActive() ||
            (otherFullscreen !== null && otherFullscreen !== boxRef.current))
        ) {
          return readLive().displayMode;
        }
        setDisplayMode(mode);
        return mode;
      },
      downloadFile: async (files) => {
        const names = files.map((file) => file.name).join(", ");
        const approved = await ask(`Save ${names} from ${app.server}?`);
        if (approved !== true) throw new McpAppHostRefusal({ message: "Declined by the user." });
        for (const file of files) {
          let bytes: Uint8Array | undefined;
          let mimeType = file.mimeType ?? "application/octet-stream";
          if (file._tag === "embedded") {
            bytes = file.bytes;
          } else {
            const read = await readLive().readResource({
              environmentId,
              input: { ...input, uri: file.uri },
            });
            requireLiveHost();
            if (read._tag !== "Success") throw commandFailure(read);
            const content = read.value.contents[0];
            bytes = mcpResourceBytes(content);
            const declared = (content as { readonly mimeType?: unknown } | undefined)?.mimeType;
            if (typeof declared === "string") mimeType = declared;
          }
          if (bytes === undefined)
            throw new McpAppHostRefusal({ message: `${file.name} has no contents.` });
          if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
            throw new McpAppHostRefusal({ message: `${file.name} is too large to save.` });
          }
          saveBlob(new Blob([bytes.slice()], { type: mimeType }), file.name);
        }
      },
      onRequestTeardown: () => {
        if (readLive().displayMode === "fullscreen") {
          setDisplayMode("inline");
          return;
        }
        // A replacement document may have mounted while this one wound down.
        void host.teardown().then(() => {
          if (hostRef.current === host) setClosed(true);
        });
      },
      onSizeChanged: (size) => {
        // Ignore fullscreen height when restoring inline sizing.
        if (readLive().displayMode === "fullscreen") return;
        if (size.height !== undefined) setHeight(clampMcpAppHeight(size.height));
      },
    });
    hostRef.current = host;
    const latestToolCall = readLive().toolCall;
    if (latestToolCall !== undefined) host.setToolCall(latestToolCall);
    const connection: PreviewAssetWidgetConnection = {
      receive: (data, activated) => {
        if (hostRef.current !== host) return;
        rendererActivation = activated;
        try {
          host.receive(data);
        } catch (error) {
          rendererActivation = false;
          throw error;
        }
        rendererActivation = false;
      },
      dispose: () => {
        host.dispose();
        if (hostRef.current === host) {
          hostRef.current = null;
          connectionRef.current = null;
        }
      },
    };
    connectionRef.current = connection;
    return connection;
  };
  const connect = useStableCallback(connectHost);

  const attachFrame = useStableCallback((frame: HTMLIFrameElement) => {
    const target = frame.contentWindow;
    // The opaque document has no origin for a narrower postMessage target.
    const connection = connect((message) => target?.postMessage(message, "*"), frame);
    const host = hostRef.current;
    const stopListening = listenToWidgetFrame(frame, connection, () => false);
    return () => {
      stopListening();
      void host?.teardown();
      connection.dispose();
    };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes theme, width, display mode and tool definition to the MCP app host in the iframe
  useEffect(() => {
    hostRef.current?.updateHostContext();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Context changes trigger a resend.
  }, [theme, width, displayMode, toolDefinition]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends the current tool call to the MCP app host, again for each new iframe document
  useEffect(() => {
    if (toolCall !== undefined) hostRef.current?.setToolCall(toolCall);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each new document needs the call.
  }, [toolCall, pinnedDocument, documentGeneration]);

  if (closed) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-muted-foreground text-xs">
        <span>The {app.server} app was closed</span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setPinnedDocument(null);
            setDocumentGeneration((value) => value + 1);
            setClosed(false);
          }}
        >
          Show app
        </Button>
      </div>
    );
  }

  const fullscreen = displayMode === "fullscreen";
  return (
    // Preserve inline row height during fullscreen to prevent timeline jumps.
    <div style={{ height }}>
      <div
        ref={attachBox}
        // Preserve the frame's parent to avoid reloads; the top layer escapes timeline containment.
        {...(fullscreenSupported
          ? { popover: "auto" as const, onToggle: onBoxToggle, onBlur: onBoxBlur }
          : {})}
        data-mcp-app-fullscreen={fullscreen ? "" : undefined}
        className={cn(
          "relative size-full overflow-hidden",
          app.prefersBorder === true && !fullscreen && "rounded-lg border border-border",
          fullscreen
            ? "fixed inset-0 m-0 flex h-dvh max-h-none w-dvw max-w-none flex-col border-0 bg-background p-0"
            : "block! static! m-0 border-0 bg-transparent p-0 text-inherit",
        )}
      >
        {fullscreen ? (
          <div
            ref={attachFullscreenChrome}
            className="flex h-10 shrink-0 items-center justify-between border-border border-b px-3 text-sm"
          >
            <span className="truncate">{app.server}</span>
            <Button
              aria-label="Exit full screen"
              size="icon-sm"
              variant="ghost"
              onClick={() => setDisplayMode("inline")}
            >
              <Minimize2Icon className="size-4" />
            </Button>
          </div>
        ) : null}
        {navigatedAway ? (
          <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
            The {app.server} app left its page and was stopped
          </p>
        ) : pinnedDocument?.hosted ? (
          <div
            ref={hostedSlotRef}
            className={cn("flex w-full flex-col", fullscreen ? "min-h-0 flex-1" : "h-full")}
          >
            <HostedAssetDocument
              environmentId={props.environmentId}
              src={pinnedDocument.src}
              title={`${app.server} app`}
              widget={{ kind: "mcp-app", connect }}
            />
          </div>
        ) : pinnedDocument !== null ? (
          <iframe
            ref={attachFrame}
            src={pinnedDocument.src}
            title={`${app.server} app`}
            // Omitting allow-same-origin isolates the app from the session.
            sandbox="allow-scripts allow-forms"
            allow={mcpAppAllowAttribute(app.permissions)}
            onLoad={onFrameLoad}
            className={cn("block w-full border-0", fullscreen ? "min-h-0 flex-1" : "h-full")}
            style={{ colorScheme: theme.appearance }}
          />
        ) : asset._tag === "Failure" ? (
          <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
            Unable to load the {app.server} app
          </p>
        ) : null}
      </div>
    </div>
  );
}
