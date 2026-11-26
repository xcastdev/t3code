import type { PreviewAssetWidgetConnection } from "@t3tools/client-runtime/preview/server-browser-stream";
import { MCP_APP_COLOR_SCHEME_PARAM } from "@t3tools/shared/mcpApp";
import type {
  EnvironmentId,
  PreviewAssetStreamOpen,
  PreviewAssetWidgetKind,
} from "@t3tools/contracts";
import { lazy, Suspense, useEffect, useId, useState, useSyncExternalStore } from "react";

import { requiresDesktopRelayTransport } from "~/connection/environmentTransport";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { readOperatorBrowserBinding } from "~/connection/verifiedRoute";
import { cn } from "~/lib/utils";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";

const ServerBrowserSurface = lazy(() =>
  import("~/browser/ServerBrowserSurface").then((module) => ({
    default: module.ServerBrowserSurface,
  })),
);

const subscribeVisibility = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
const documentVisible = () => !document.hidden;

interface HostedAssetDocumentProps {
  readonly environmentId: EnvironmentId;
  readonly src: string;
  readonly title: string;
  readonly htmlRender?: boolean;
  readonly className?: string | undefined;
  readonly visible?: boolean | undefined;
  readonly onContentHeight?: ((height: number) => void) | undefined;
  readonly widget?: {
    readonly kind: PreviewAssetWidgetKind;
    readonly connect: (post: (data: unknown) => void) => PreviewAssetWidgetConnection;
  };
}

export function HostedAssetDocument(props: HostedAssetDocumentProps) {
  const key = props.widget
    ? `${props.environmentId}:${props.widget.kind}:${props.src}`
    : props.environmentId;
  return <HostedAssetView key={key} {...props} />;
}

function HostedAssetView(props: HostedAssetDocumentProps) {
  const theme = useHtmlRenderTheme();
  const viewId = useId();
  const documentIsVisible = useSyncExternalStore(subscribeVisibility, documentVisible, () => true);
  const [failed, setFailed] = useState(false);
  const [painted, setPainted] = useState(false);
  // Pin the grant to this view. Renewals must not reload an open document.
  const [asset] = useState<PreviewAssetStreamOpen>(() => {
    const url = URL.parse(props.src);
    const verifiedAssetUrl =
      props.widget?.kind === "mcp-app" &&
      url !== null &&
      !url.searchParams.has(MCP_APP_COLOR_SCHEME_PARAM)
        ? `${props.src}${url.search ? "&" : "?"}${MCP_APP_COLOR_SCHEME_PARAM}=${theme.appearance}`
        : props.src;
    return {
      type: "openAsset",
      verifiedAssetUrl,
      appearance: theme.appearance,
      ...(props.widget ? { widget: props.widget.kind } : {}),
      ...(props.htmlRender && !props.widget ? { theme: theme.variables } : {}),
    };
  });
  const presentation = {
    type: "assetPresentation" as const,
    visible: documentIsVisible,
    appearance: theme.appearance,
    ...(props.htmlRender && !props.widget ? { theme: theme.variables } : {}),
  };
  const url = URL.parse(asset.verifiedAssetUrl);
  const desktopOrigin =
    url?.protocol === "https:" && requiresDesktopRelayTransport(url.href) ? url.origin : null;
  const [desktopAdmission, setDesktopAdmission] = useState<{
    readonly origin: string;
    readonly allowed: boolean;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the binding owned by Electron main
  useEffect(() => {
    if (desktopOrigin === null) return;
    let stopped = false;
    const check = async () => {
      const binding = await window.desktopBridge
        ?.getVerifiedRouteBinding?.(desktopOrigin)
        .catch(() => null);
      if (stopped) return;
      setDesktopAdmission({
        origin: desktopOrigin,
        allowed:
          binding?.httpsOrigin === desktopOrigin &&
          binding.environmentId === props.environmentId &&
          binding.transportRole === "relay",
      });
    };
    void check();
    return () => {
      stopped = true;
    };
  }, [desktopOrigin, props.environmentId]);

  if (desktopOrigin !== null && desktopAdmission?.origin !== desktopOrigin) {
    return <FileSurfaceLoading />;
  }
  const binding = url === null ? null : readOperatorBrowserBinding(url.origin);
  const admitted =
    desktopOrigin === null
      ? binding?.environmentId === props.environmentId && binding.transportRole === "relay"
      : desktopAdmission?.allowed === true;
  if (failed || !admitted) {
    return <FileSurfaceFailure message="Unable to load file preview." />;
  }

  return (
    <div className={cn("relative flex min-h-0 w-full flex-1 flex-col", props.className)}>
      <Suspense fallback={null}>
        <ServerBrowserSurface
          environmentId={props.environmentId}
          threadId=""
          tabId={viewId}
          visible={props.visible !== false}
          asset={asset}
          assetTitle={props.title}
          assetPresentation={presentation}
          {...(props.widget === undefined ? {} : { connectWidget: props.widget.connect })}
          {...(props.onContentHeight === undefined ? {} : { onAssetHeight: props.onContentHeight })}
          className="min-h-0 w-full flex-1"
          onFirstFrame={() => setPainted(true)}
          onGone={() => setFailed(true)}
        />
      </Suspense>
      {!painted && props.visible !== false ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col">
          <FileSurfaceLoading />
        </div>
      ) : null}
    </div>
  );
}
