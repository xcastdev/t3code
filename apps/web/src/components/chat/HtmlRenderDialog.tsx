import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFrameHeight,
  htmlRenderFileName,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { DownloadIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { hostedAdmissionRequired } from "~/connection/hostedRelayAdmission";
import { readVerifiedPreviewAsset } from "~/browser/readVerifiedPreviewAsset";
import { saveBlob } from "~/lib/saveBlob";
import { toastManager } from "~/components/ui/toast";
import { observeResize } from "~/lib/observeResize";

import { HtmlRenderDocument, OfflineHtmlFile } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

export type HtmlRenderSource =
  | { readonly src: string; readonly verified?: true }
  | { readonly file: Blob };

export function HtmlRenderDialog(props: {
  readonly source: HtmlRenderSource;
  readonly environmentId?: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly onClose: () => void;
}) {
  const { title } = props.htmlRender;
  const environmentId = props.environmentId ?? props.threadRef?.environmentId;
  const hostedSource =
    "src" in props.source && props.source.verified && hostedAdmissionRequired(props.source.src)
      ? props.source.src
      : null;
  const [zoom, setZoom] = useState(1);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  // A callback ref, since the popup can mount after this component's first commit.
  const measureBox = (box: HTMLDivElement) => {
    setWidth(box.clientWidth);
    return observeResize(box, ([entry]) => {
      // Rounded like clientWidth, so the two writes agree at fractional widths.
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
  };
  const [contentHeight, setContentHeight] = useState<number>();
  // Zoom divides the page's layout width, so the page reflows to fill the card
  // at every level, and the frame is as tall as the page so only the card scrolls.
  const height = htmlRenderFrameHeight(props.htmlRender, width / zoom, contentHeight);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1"
        initialFocus={closeButtonRef}
      >
        <DialogTitle className="sr-only">Expanded {title} preview</DialogTitle>
        {/* 1144px is the widest the server measures a page; pages are written for the reply column and stretch badly beyond it. */}
        <div className="relative w-[min(92vw,1176px)]">
          <Button
            ref={closeButtonRef}
            aria-label="Close"
            size="icon-xs"
            variant="media-close"
            className="absolute right-0 -top-10 z-20"
            onClick={props.onClose}
          >
            <XIcon />
          </Button>
          <div className="max-h-[min(86vh,calc(100vh-160px))] overflow-y-auto overscroll-contain rounded-lg bg-background p-4 shadow-2xl ring-1 ring-border/70">
            <div ref={measureBox}>
              <div style={{ zoom, height }}>
                {"file" in props.source ? (
                  <div className="flex size-full flex-col">
                    <OfflineHtmlFile file={props.source.file} title={title} />
                  </div>
                ) : (
                  <HtmlRenderDocument
                    src={props.source.src}
                    verified={props.source.verified}
                    title={title}
                    threadRef={props.threadRef}
                    environmentId={environmentId}
                    className="block size-full"
                    onContentHeight={setContentHeight}
                  />
                )}
              </div>
            </div>
          </div>
          <div className="mt-2 flex min-w-0 items-center justify-center gap-3 text-xs text-white/80">
            <span className="truncate">{title}</span>
            <div className="flex shrink-0 items-center gap-1">
              {environmentId && hostedSource ? (
                <Button
                  aria-label="Download original"
                  size="icon-sm"
                  variant="overlay"
                  onClick={() => {
                    void readVerifiedPreviewAsset(environmentId, hostedSource)
                      .then((blob) => saveBlob(blob, htmlRenderFileName(title)))
                      .catch(() =>
                        toastManager.add({ type: "error", title: "Unable to download page" }),
                      );
                  }}
                >
                  <DownloadIcon />
                </Button>
              ) : null}
              <Button
                aria-label="Zoom out"
                size="icon-sm"
                variant="overlay"
                disabled={zoom === 0.5}
                onClick={() => setZoom((value) => value - 0.25)}
              >
                <MinusIcon />
              </Button>
              <Button
                aria-label="Reset zoom"
                size="sm"
                variant="overlay"
                onClick={() => setZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </Button>
              <Button
                aria-label="Zoom in"
                size="icon-sm"
                variant="overlay"
                disabled={zoom === 2}
                onClick={() => setZoom((value) => value + 0.25)}
              >
                <PlusIcon />
              </Button>
            </div>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
