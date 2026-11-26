import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { Maximize2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { useAssetGrantRefresh } from "~/assets/assetUrls";
import { useLongLivedAssetUrl } from "~/assets/longLivedAssetUrls";
import { hostedAdmissionRequired } from "~/connection/hostedRelayAdmission";
import {
  prepareVerifiedPreviewSource,
  verifyPreviewIssuer,
} from "~/browser/readVerifiedPreviewAsset";

import { HtmlRenderDocument, OfflineHtmlFile } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HtmlRenderDialog, type HtmlRenderSource } from "./HtmlRenderDialog";
import { observeResize } from "~/lib/observeResize";

const MIN_URL_LIFE_MS = 5 * 60_000;

export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
}) {
  const { attachmentId, title } = props.htmlRender;
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  const observeBox = (box: HTMLDivElement) => {
    setWidth(box.clientWidth);
    return observeResize(box, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
  };
  // Client fonts can exceed the server-measured height and cause nested scrolling.
  const [contentHeight, setContentHeight] = useState<number>();
  const height = htmlRenderFrameHeight(props.htmlRender, width, contentHeight);
  const fileName = htmlRenderFileName(title);
  const resource = {
    _tag: "attachment" as const,
    attachmentId,
    fileName,
    mimeType: "text/html",
    disposition: "inline" as const,
  };
  const { environmentId } = props;
  // The frame keeps the first URL it loads, so later mints do not reload the page.
  const [loaded, setLoaded] = useState<{
    url: string;
    expiresAt: number;
    learnedRoute?: true;
  } | null>(null);
  const assetUrl = useLongLivedAssetUrl(loaded === null ? environmentId : null, resource);
  if (loaded === null && assetUrl._tag === "Success") {
    setLoaded({
      url: assetUrl.url,
      expiresAt: assetUrl.expiresAt,
      ...(assetUrl.learnedRoute ? { learnedRoute: true } : {}),
    });
  }
  const [prepared, setPrepared] = useState<{
    readonly environmentId: EnvironmentId;
    readonly grant: NonNullable<typeof loaded>;
    readonly source: HtmlRenderSource | null;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- authorizes the exact issuer before the document can navigate
  useEffect(() => {
    if (!loaded?.learnedRoute) return;
    const controller = new AbortController();
    void prepareHtmlRenderSource(environmentId, loaded, controller.signal)
      .then((source) => {
        if (!controller.signal.aborted) setPrepared({ environmentId, grant: loaded, source });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPrepared({ environmentId, grant: loaded, source: null });
      });
    return () => controller.abort();
  }, [environmentId, loaded]);

  const verified =
    prepared?.grant === loaded && prepared.environmentId === environmentId ? prepared : null;
  const source = loaded?.learnedRoute ? verified?.source : loaded ? { src: loaded.url } : null;
  const failed = (loaded === null && assetUrl._tag === "Failure") || verified?.source === null;
  const refresh = useAssetGrantRefresh(environmentId, resource);
  const [expandedSource, setExpandedSource] = useState<HtmlRenderSource | null>(null);
  const { onFullscreenChange } = props;
  // Tied to the viewer's lifetime: unmounting while expanded must still release
  // the timeline's follow pin, which a close handler alone never reaches.
  const expanded = expandedSource !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the parent's fullscreen pin while expanded and releases it on collapse or unmount
  useEffect(() => {
    if (!expanded) return;
    onFullscreenChange?.(true);
    return () => onFullscreenChange?.(false);
  }, [expanded, onFullscreenChange]);

  return (
    <div ref={observeBox} className="group/html-render relative" style={{ height }}>
      {source ? (
        <>
          {"file" in source ? (
            <div className="flex size-full flex-col">
              <OfflineHtmlFile file={source.file} title={title} />
            </div>
          ) : (
            <HtmlRenderDocument
              src={source.src}
              verified={"verified" in source ? source.verified : undefined}
              title={title}
              threadRef={props.threadRef}
              environmentId={environmentId}
              className="block size-full"
              onContentHeight={setContentHeight}
              onFullscreenChange={onFullscreenChange}
            />
          )}
          <div className="absolute end-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open full screen"
                    size="icon-xs"
                    variant="glass"
                    onClick={async () => {
                      const expanded =
                        "file" in source ||
                        (loaded && loaded.expiresAt - Date.now() > MIN_URL_LIFE_MS)
                          ? source
                          : await refresh()
                              .then(
                                (grant) => grant && prepareHtmlRenderSource(environmentId, grant),
                              )
                              .catch(() => null);
                      if (expanded !== null) setExpandedSource(expanded);
                      else
                        toastManager.add({
                          type: "error",
                          title: "Page unavailable",
                          description: "Reconnect to the environment and try again.",
                        });
                    }}
                  />
                }
              >
                <Maximize2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="left">Open full screen</TooltipPopup>
            </Tooltip>
          </div>
          {expandedSource !== null ? (
            <HtmlRenderDialog
              source={expandedSource}
              environmentId={environmentId}
              htmlRender={props.htmlRender}
              threadRef={props.threadRef}
              onClose={() => setExpandedSource(null)}
            />
          ) : null}
        </>
      ) : failed ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
          Unable to load {title}
        </p>
      ) : null}
    </div>
  );
}

async function prepareHtmlRenderSource(
  environmentId: EnvironmentId,
  grant: { readonly url: string; readonly learnedRoute?: boolean },
  signal?: AbortSignal,
): Promise<HtmlRenderSource> {
  if (!grant.learnedRoute) return { src: grant.url };
  if (hostedAdmissionRequired(grant.url)) {
    await verifyPreviewIssuer(environmentId, grant.url);
    signal?.throwIfAborted();
    return { src: grant.url, verified: true };
  }
  const source = await prepareVerifiedPreviewSource(environmentId, grant.url, {
    html: true,
    ...(signal === undefined ? {} : { signal }),
  });
  return typeof source === "string" ? { src: source, verified: true } : { file: source };
}
