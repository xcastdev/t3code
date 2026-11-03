import { mcpAppStyleVariables } from "@t3tools/client-runtime/mcp-apps";
import {
  makePluginBridge,
  type PluginBridge,
  type PluginBridgeOptions,
  type PluginHostContext,
} from "@t3tools/client-runtime/plugins/bridge";
import {
  injectMcpAppCookieBootstrap,
  injectMcpAppCsp,
  injectMcpAppThemeBootstrap,
} from "@t3tools/shared/mcpApp";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "~/env";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";

// Exclude activation left by input elsewhere in T3, as MCP app frames do.
const PAGE_ACTIVATION_MS = 5_000;

// Frame input does not bubble here. A panel can refocus itself, so focus alone
// cannot exclude activation from input elsewhere in T3.
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

/** Client panels get the same document the server serves for environment panels. */
const withPanelBootstrap = (html: string) =>
  injectMcpAppCookieBootstrap(injectMcpAppThemeBootstrap(injectMcpAppCsp(html, undefined)));

type PluginPanelDocument =
  | { readonly kind: "src"; readonly url: string }
  | { readonly kind: "srcdoc"; readonly html: string };

type PluginPanelBridgeOptions = Omit<PluginBridgeOptions, "post" | "hostContext">;

export function PluginPanelFrame(props: {
  readonly title: string;
  readonly document: PluginPanelDocument;
  readonly bridge: PluginPanelBridgeOptions;
  readonly destination: PluginHostContext["destination"];
  readonly chatTarget: PluginHostContext["chatTarget"];
}) {
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<PluginBridge | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [navigatedAway, setNavigatedAway] = useState(false);
  const readLive = useStableCallback(() => ({ theme, size, props }));

  const attachBox = (box: HTMLDivElement) =>
    observeResize(box, ([entry]) => {
      if (entry) {
        setSize({
          width: Math.round(entry.contentRect.width),
          height: Math.round(entry.contentRect.height),
        });
      }
    });

  // A frame keeps its window across navigation; a second load could impersonate the panel.
  const loads = useRef(0);
  const onFrameLoad = () => {
    loads.current += 1;
    if (loads.current > 1) {
      bridgeRef.current?.dispose();
      setNavigatedAway(true);
    }
  };

  const attachFrame = (frame: HTMLIFrameElement) => {
    frameRef.current = frame;
    const target = () => frameRef.current?.contentWindow ?? null;
    const hostContext = (): PluginHostContext => {
      const current = readLive();
      return {
        apiVersion: "1.0",
        theme: current.theme.appearance,
        styles: { variables: mcpAppStyleVariables(current.theme.variables) },
        containerDimensions: current.size,
        platform: isElectron ? "desktop" : "web",
        destination: current.props.destination,
        chatTarget:
          current.props.chatTarget === null
            ? null
            : { key: current.props.chatTarget.key, title: current.props.chatTarget.title },
      };
    };
    const options = () => readLive().props.bridge;
    const backend = () => {
      const current = options().backend;
      if (current === undefined) throw new Error("This panel has no backend.");
      return current;
    };
    const bridge = makePluginBridge({
      manifest: options().manifest,
      panelId: options().panelId,
      pluginVersion: options().pluginVersion,
      // Opaque origins require "*"; the window reference scopes delivery to this frame.
      post: (message) => target()?.postMessage(message, "*"),
      hostContext,
      state: { get: () => options().state.get(), set: (value) => options().state.set(value) },
      ...(options().backend === undefined
        ? {}
        : {
            backend: {
              call: (operation, input) => backend().call(operation, input),
              subscribe: (topic, params, onEvent) => backend().subscribe(topic, params, onEvent),
            },
          }),
      openSurface: (contributionId) => options().openSurface(contributionId),
      attach: (request, activated) => options().attach(request, activated),
    });
    bridgeRef.current = bridge;
    // Real input in the frame focuses it and activates this page; recent page input does not count.
    const activated = () =>
      document.activeElement === frameRef.current &&
      navigator.userActivation?.isActive === true &&
      performance.now() - lastPageInputAt >= PAGE_ACTIVATION_MS;
    const receive = (event: MessageEvent) => {
      if (event.source !== null && event.source === target()) {
        bridge.receive(event.data, activated());
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      bridge.dispose();
      bridgeRef.current = null;
      frameRef.current = null;
    };
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes theme, size and chat target to the panel's bridge in the iframe
  useEffect(() => {
    bridgeRef.current?.updateHostContext();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Context changes trigger a resend.
  }, [theme, size, props.chatTarget, props.destination]);

  return (
    <div ref={attachBox} className="relative size-full min-h-0 overflow-hidden">
      {navigatedAway ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
          {props.title} left its page and was stopped
        </p>
      ) : (
        <iframe
          ref={attachFrame}
          title={props.title}
          {...(props.document.kind === "src"
            ? { src: props.document.url }
            : { srcDoc: withPanelBootstrap(props.document.html) })}
          // Omitting allow-same-origin isolates the panel from the session.
          sandbox="allow-scripts allow-forms"
          onLoad={onFrameLoad}
          className="block size-full border-0"
          style={{ colorScheme: theme.appearance }}
        />
      )}
    </div>
  );
}
