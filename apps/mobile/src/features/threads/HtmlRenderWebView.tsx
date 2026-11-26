import { SecureWebView } from "../../native/secureWebView";
import { signedDocumentResources, useVerifiedWebResources } from "../../lib/verifiedWebResources";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  type HtmlRenderReference,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, View, type ColorValue } from "react-native";
import { type WebView, type WebViewMessageEvent } from "react-native-webview";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import {
  framedWebDocument,
  readFramedWebMessage,
  useVerifiedWebDocument,
} from "../../lib/verifiedWebDocument";
import { uuidv4 } from "../../lib/uuid";
import { FilePreviewNotice } from "../files/FilePreviewFeedback";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { webViewDecelerationRate } from "../../lib/webViewDecelerationRate";

const ROW_BOTTOM_MARGIN = 8;
const ACTION_ROW_HEIGHT = 32;
const FULL_SCREEN_GUTTER = 16;

export function htmlRenderRowHeight(frameHeight: number) {
  return ACTION_ROW_HEIGHT + frameHeight + ROW_BOTTOM_MARGIN;
}

function useHtmlRenderTheme() {
  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  return mobileHtmlRenderTheme({
    themeId,
    appearance: themeAppearance,
    variables: themeVariables,
    systemColors: systemColorsActive,
    platform: Platform.OS,
  });
}

function postTheme(view: WebView<object> | null, theme: HtmlRenderTheme, framed: boolean) {
  const message = JSON.stringify(htmlRenderThemeMessage(theme));
  const post = framed
    ? `window.__t3McpAppReceive?.(${message});`
    : `window.postMessage(${message}, "*");`;
  view?.injectJavaScript(`${post} true;`);
}

const OVERFLOW_MESSAGE_TYPE = "t3-html-render-overflow";

const overflowObserver = (post: string) =>
  `function(){var last;function report(){var d=document.documentElement,b=document.body;var x=Math.max(d.scrollWidth,b?b.scrollWidth:0)>window.innerWidth+1,y=Math.max(d.scrollHeight,b?b.scrollHeight:0)>window.innerHeight+1,o=x+","+y;if(o===last)return;last=o;var message={type:${JSON.stringify(OVERFLOW_MESSAGE_TYPE)},x:x,y:y};${post}}report();if(window.ResizeObserver){var r=new ResizeObserver(report);r.observe(document.documentElement);if(document.body)r.observe(document.body);}window.addEventListener("resize",report);}`;
const OVERFLOW_SCRIPT = `(${overflowObserver("window.ReactNativeWebView.postMessage(JSON.stringify(message));")})();true;`;
const FRAMED_OVERFLOW_SCRIPT = `<script>window.addEventListener("DOMContentLoaded",${overflowObserver('window.parent.postMessage(message,"*");')});</script>`;

type Overflow = { readonly x: boolean; readonly y: boolean };

const NO_OVERFLOW: Overflow = { x: false, y: false };

function parseRenderMessage(message: unknown): unknown {
  if (typeof message !== "string") return message;
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

function readOverflowMessage(message: unknown): Overflow | null {
  return typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === OVERFLOW_MESSAGE_TYPE &&
    "x" in message &&
    typeof message.x === "boolean" &&
    "y" in message &&
    typeof message.y === "boolean"
    ? { x: message.x, y: message.y }
    : null;
}

const withoutFragment = (url: string) => url.split("#", 1)[0];

export function HtmlRenderWebView(props: {
  readonly uri: string;
  readonly title: string;
  readonly nested: boolean;
  readonly onLoadError?: () => void;
}) {
  const theme = useHtmlRenderTheme();
  const [initialTheme] = useState(theme);
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [overflow, setOverflow] = useState(NO_OVERFLOW);
  const [secret] = useState(uuidv4);
  const webView = useRef<WebView<object>>(null);
  const crashes = useRef(0);
  const shownTheme = useRef<HtmlRenderTheme | null>(null);
  const document = useVerifiedWebDocument(
    props.uri,
    signedDocumentResources,
    props.nested ? FRAMED_OVERFLOW_SCRIPT : undefined,
  );
  const isolated = document.kind === "local";
  const sandbox = isolated ? document.sandbox : undefined;
  const resourceAccess = isolated ? document.resourceAccess : undefined;
  const handleResource = useVerifiedWebResources(
    resourceAccess ? props.uri : null,
    webView,
    generation,
    resourceAccess,
  );
  const source = isolated
    ? { html: sandbox ? framedWebDocument(document, "", secret) : document.html }
    : { uri: props.uri + htmlRenderThemeFragment(initialTheme) };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts theme changes into the already loaded WebView
  useEffect(() => {
    if (shownTheme.current === null || shownTheme.current === theme) return;
    shownTheme.current = theme;
    postTheme(webView.current, theme, sandbox !== undefined);
  }, [theme, sandbox]);
  const restart = () => {
    crashes.current += 1;
    if (crashes.current > 1) {
      props.onLoadError?.();
      return;
    }
    shownTheme.current = null;
    setLoaded(false);
    setOverflow(NO_OVERFLOW);
    setGeneration((value) => value + 1);
  };
  const scrollable = !props.nested || overflow.x || overflow.y;
  if (document.kind === "failed")
    return <FilePreviewNotice>Rendered preview unavailable.</FilePreviewNotice>;
  if (document.kind === "loading") return <AppActivityIndicator />;
  return (
    <View
      style={
        props.nested
          ? { flex: 1 }
          : {
              flex: 1,
              paddingHorizontal: FULL_SCREEN_GUTTER,
              backgroundColor: theme.variables["--background"],
            }
      }
    >
      <SecureWebView
        verified={isolated}
        onFenceError={props.onLoadError}
        key={generation}
        ref={webView}
        source={source}
        accessibilityLabel={props.title}
        style={{ flex: 1, backgroundColor: "transparent" }}
        allowsInlineMediaPlayback
        contentInsetAdjustmentBehavior={props.nested ? "never" : "automatic"}
        bounces={!props.nested}
        showsVerticalScrollIndicator={!props.nested}
        showsHorizontalScrollIndicator={!props.nested}
        scrollEnabled={scrollable}
        decelerationRate={webViewDecelerationRate}
        // Android's patched WebView always keeps horizontal drags. Only pages
        // with vertical overflow hold vertical drags until they reach an edge.
        nestedScrollEnabled={props.nested && overflow.y}
        overScrollMode={props.nested ? "never" : "always"}
        onShouldStartLoadWithRequest={(request) =>
          request.isTopFrame === false ||
          withoutFragment(request.url) === withoutFragment(props.uri)
        }
        onOpenWindow={(event) => {
          const url = event.nativeEvent.targetUrl;
          if (/^https?:/i.test(url)) void tryOpenExternalUrl(url, "html-render");
        }}
        onLoadEnd={() => {
          setLoaded(true);
          shownTheme.current = theme;
          if (isolated || theme !== initialTheme)
            postTheme(webView.current, theme, sandbox !== undefined);
        }}
        onError={props.onLoadError}
        onHttpError={props.onLoadError}
        onContentProcessDidTerminate={restart}
        onRenderProcessGone={restart}
        onMessage={
          isolated || props.nested
            ? (event: WebViewMessageEvent) => {
                const data = event.nativeEvent.data;
                const message: unknown = sandbox
                  ? readFramedWebMessage(data, secret)?.message
                  : data;
                if (handleResource(message) || !props.nested) return;
                const next = readOverflowMessage(parseRenderMessage(message));
                if (next !== null) setOverflow(next);
              }
            : undefined
        }
        {...(props.nested && sandbox === undefined
          ? {
              injectedJavaScript: OVERFLOW_SCRIPT,
            }
          : {})}
      />
      {loaded ? null : (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <AppActivityIndicator />
        </View>
      )}
    </View>
  );
}

export function ThreadHtmlRender(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly render: HtmlRenderReference;
  readonly frameWidth: number;
  readonly iconColor: ColorValue;
}) {
  const navigation = useNavigation();
  const { attachmentId, title } = props.render;
  const height = htmlRenderFrameHeight(props.render, props.frameWidth);
  const fileName = htmlRenderFileName(title);
  const resource = {
    _tag: "attachment" as const,
    attachmentId,
    fileName,
    mimeType: "text/html",
    disposition: "inline" as const,
  };
  const asset = useAssetUrlState(props.environmentId, resource, undefined, "web-document");
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  // Signed URLs are re-minted periodically; following them would reload the page.
  const [uri, setUri] = useState<string | null>(null);
  if (uri === null && asset._tag === "Success") setUri(asset.url);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retried = useRef(false);
  const handleLoadError = () => {
    if (retried.current) {
      setFailed(true);
      return;
    }
    retried.current = true;
    void refresh().then((next) => {
      if (next === null) setFailed(true);
      else if (next !== uri) setUri(next);
      else setAttempt((value) => value + 1);
    });
  };

  return (
    <View style={{ marginBottom: ROW_BOTTOM_MARGIN }}>
      <View style={{ height: ACTION_ROW_HEIGHT }} className="flex-row items-start justify-end">
        {uri !== null && !failed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${title}`}
            hitSlop={8}
            className="h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card/80"
            onPress={() =>
              navigation.navigate("ThreadAttachment", {
                environmentId: String(props.environmentId),
                threadId: String(props.threadId),
                attachmentId,
                name: fileName,
                mimeType: "text/html",
                sizeBytes: "0",
                htmlRender: "1",
              })
            }
          >
            <SymbolView
              name="arrow.up.left.and.arrow.down.right"
              size={12}
              tintColor={props.iconColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </View>
      <View style={{ height }}>
        {uri !== null && !failed ? (
          <HtmlRenderWebView
            key={`${uri}:${attempt}`}
            uri={uri}
            title={title}
            nested
            onLoadError={handleLoadError}
          />
        ) : failed || asset._tag === "Failure" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Reload ${title}`}
            className="flex-1 items-center justify-center"
            onPress={() => {
              retried.current = false;
              setFailed(false);
              if (uri === null) void refresh().then((next) => next !== null && setUri(next));
            }}
          >
            <Text className="text-sm text-foreground-muted">Page unavailable</Text>
          </Pressable>
        ) : (
          <View className="flex-1 items-center justify-center">
            <AppActivityIndicator />
          </View>
        )}
      </View>
    </View>
  );
}
