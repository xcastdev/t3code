import { mcpAppStyleVariables } from "@t3tools/client-runtime/mcp-apps";
import {
  makePluginBridge,
  type PluginBridge,
  type PluginBridgeOptions,
  type PluginHostContext,
} from "@t3tools/client-runtime/plugins/bridge";
import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { uuidv4 } from "../../lib/uuid";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  decodePluginRelayMessage,
  pluginOuterDocument,
  type PluginPanelDocument,
} from "./pluginRelay";

type PluginPanelBridgeOptions = Omit<PluginBridgeOptions, "post" | "hostContext">;

/** One panel document and its bridge. Key it by `${panelKey}@${version}` so an update remounts it. */
export function PluginWebView(props: {
  readonly title: string;
  readonly document: PluginPanelDocument;
  readonly bridge: PluginPanelBridgeOptions;
  readonly destination: PluginHostContext["destination"];
  readonly chatTarget: PluginHostContext["chatTarget"];
}) {
  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  const theme = mobileHtmlRenderTheme({
    themeId,
    appearance: themeAppearance,
    variables: themeVariables,
    systemColors: systemColorsActive,
    platform: Platform.OS,
  });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [secret] = useState(uuidv4);
  // The view keeps its first document: a new one would reload the panel.
  const [source] = useState(() => ({ html: pluginOuterDocument(props.document, secret) }));
  const [loaded, setLoaded] = useState(false);
  const [stopped, setStopped] = useState<"navigated" | "crashed" | null>(null);
  const bridgeRef = useRef<PluginBridge | null>(null);
  const live = { theme, size, props };
  const latest = useRef(live);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes theme, size and chat target to the panel's bridge in the WebView
  useEffect(() => {
    latest.current = live;
    bridgeRef.current?.updateHostContext();
  });

  // Per-render values are read through `latest`: a new ref callback would rebuild the bridge.
  const attachWebView = (view: WebView<object> | null) => {
    if (view === null) return;
    const hostContext = (): Omit<PluginHostContext, "apiVersion"> => {
      const current = latest.current;
      return {
        theme: current.theme.appearance,
        styles: { variables: mcpAppStyleVariables(current.theme.variables) },
        containerDimensions: current.size,
        platform: "mobile",
        destination: current.props.destination,
        chatTarget: current.props.chatTarget,
      };
    };
    const options = () => latest.current.props.bridge;
    const backend = () => {
      const current = options().backend;
      if (current === undefined) throw new Error("This panel has no backend.");
      return current;
    };
    const bridge = makePluginBridge({
      manifest: options().manifest,
      panelId: options().panelId,
      pluginVersion: options().pluginVersion,
      post: (message) =>
        view.injectJavaScript(
          `window.__t3PluginReceive&&window.__t3PluginReceive(${JSON.stringify(message)});true;`,
        ),
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
      saveFile: (file) => options().saveFile(file),
      writeClipboard: (text) => options().writeClipboard(text),
      chatTargets: (query) => options().chatTargets(query),
    });
    bridgeRef.current = bridge;
    return () => {
      bridge.dispose();
      if (bridgeRef.current === bridge) bridgeRef.current = null;
    };
  };

  const stop = (reason: "navigated" | "crashed") => {
    bridgeRef.current?.dispose();
    setStopped(reason);
  };

  const onMessage = (event: WebViewMessageEvent) => {
    const relayed = decodePluginRelayMessage(event.nativeEvent.data, secret);
    if (relayed === null) return;
    if (relayed.kind === "navigated") stop("navigated");
    else bridgeRef.current?.receive(relayed.message, relayed.active);
  };

  return (
    <View
      className="flex-1"
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setSize({ width: Math.round(width), height: Math.round(height) });
      }}
    >
      {stopped !== null ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-sm text-foreground-muted">
            {stopped === "navigated"
              ? `${props.title} left its page and was stopped`
              : `${props.title} stopped unexpectedly. Close and reopen it.`}
          </Text>
        </View>
      ) : (
        <WebView<object>
          ref={attachWebView}
          source={source}
          accessibilityLabel={props.title}
          style={{ flex: 1, backgroundColor: "transparent" }}
          originWhitelist={["*"]}
          // Android misreports nested frames as top-level; rely on iframe sandboxing there and gate navigation elsewhere.
          onShouldStartLoadWithRequest={(request) =>
            Platform.OS === "android" ||
            request.isTopFrame === false ||
            request.url === "about:blank"
          }
          setSupportMultipleWindows={false}
          onContentProcessDidTerminate={() => stop("crashed")}
          onRenderProcessGone={() => stop("crashed")}
          onLoadEnd={() => setLoaded(true)}
          onMessage={onMessage}
        />
      )}
      {!loaded && stopped === null ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <AppActivityIndicator />
        </View>
      ) : null}
    </View>
  );
}
