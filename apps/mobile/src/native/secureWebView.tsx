import { requireOptionalNativeModule } from "expo";
import { useRef, useState, type ComponentRef, type Ref } from "react";
import { findNodeHandle, Platform, View } from "react-native";
import { WebView, type WebViewProps } from "react-native-webview";

interface WebViewNetworkFence {
  blockWebViewNetworkLoads?(tag: number): Promise<boolean>;
}

type SecureWebViewProps = WebViewProps & {
  readonly ref?: Ref<WebView<object>>;
  readonly verified: boolean;
  readonly onFenceError?: () => void;
};

const blankSource = { html: "" };
const ignorePopup = () => {};

async function blockNetworkLoads(host: ComponentRef<typeof View>): Promise<boolean> {
  try {
    const tag = findNodeHandle(host);
    if (tag === null || tag === undefined) return false;
    const native = requireOptionalNativeModule<WebViewNetworkFence>(
      Platform.OS === "ios" ? "T3WebSocket" : "T3VerifiedNetwork",
    );
    return (await native?.blockWebViewNetworkLoads?.(tag)) === true;
  } catch {
    return false;
  }
}

export function SecureWebView({ verified, onFenceError, ...props }: SecureWebViewProps) {
  if (!verified) return <WebView<object> {...props} />;
  return <FencedWebView {...props} onFenceError={onFenceError} />;
}

function FencedWebView({
  source,
  onFenceError,
  onLoadEnd,
  onError,
  onMessage,
  injectedJavaScript,
  injectedJavaScriptBeforeContentLoaded,
  ...props
}: Omit<SecureWebViewProps, "verified">) {
  const host = useRef<ComponentRef<typeof View>>(null);
  const started = useRef(false);
  const [ready, setReady] = useState(false);
  const localFile =
    source && "uri" in source && source.uri.startsWith("file:///") ? source.uri : null;
  const baseUrl = source && "html" in source ? source.baseUrl : undefined;
  const localSource =
    source && "html" in source
      ? baseUrl === undefined || baseUrl === "file:///" || baseUrl === "https://localhost/"
        ? source
        : null
      : localFile === null
        ? null
        : { uri: localFile };

  const armFence = async () => {
    if (started.current) return;
    started.current = true;
    const mountedHost = host.current;
    if (mountedHost === null) return;
    const acknowledged = localSource !== null && (await blockNetworkLoads(mountedHost));
    if (host.current !== mountedHost) return;
    if (acknowledged) setReady(true);
    else onFenceError?.();
  };

  return (
    <View ref={host} collapsable={false} style={{ flex: 1 }}>
      <WebView<object>
        {...props}
        source={ready && localSource ? localSource : blankSource}
        originWhitelist={["*"]}
        allowFileAccess={localFile !== null}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        allowsLinkPreview={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        onOpenWindow={ignorePopup}
        onShouldStartLoadWithRequest={({ url }) =>
          url === "about:blank" ||
          url === "about:srcdoc" ||
          (ready && (url === localFile || url === baseUrl))
        }
        onError={(event) => {
          if (ready) onError?.(event);
          else if (!started.current) {
            started.current = true;
            onFenceError?.();
          }
        }}
        onLoadEnd={(event) => {
          if (ready) onLoadEnd?.(event);
          else if (event.nativeEvent.url === "about:blank") void armFence();
        }}
        {...(ready && onMessage ? { onMessage } : {})}
        {...(ready && injectedJavaScript ? { injectedJavaScript } : {})}
        {...(ready && injectedJavaScriptBeforeContentLoaded
          ? { injectedJavaScriptBeforeContentLoaded }
          : {})}
      />
    </View>
  );
}
