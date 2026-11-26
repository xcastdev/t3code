import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { requiresAdmittedAsset } from "~/assets/admittedAssetSource";
import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";

import { AudioPreview } from "./AudioPreview";

export function InlineAudioPreview(props: {
  readonly name: string;
  readonly environmentId?: EnvironmentId;
  readonly resource?: AssetResource;
  readonly src?: string;
  readonly copyMarkdown?: string;
  readonly onOpen?: () => void;
  readonly variant?: "chip" | "bubble";
}) {
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const asset = useAssetUrlState(
    visible ? (props.environmentId ?? null) : null,
    visible ? (props.resource ?? null) : null,
    undefined,
    "audio",
  );
  const refresh = useAssetUrlRefresh(props.environmentId ?? null, props.resource ?? null);
  const fallback = props.src && !requiresAdmittedAsset(props.src) ? props.src : undefined;
  const src = visible ? (asset._tag === "Success" ? asset.url : fallback) : undefined;
  const failed = asset._tag === "Failure" || (src !== undefined && failedSrc === src);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- IntersectionObserver defers loading the audio until the element scrolls into view
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <span ref={container} data-markdown-copy={props.copyMarkdown}>
      <AudioPreview
        compact
        variant={props.variant ?? "chip"}
        name={props.name}
        src={src ?? ""}
        revision={
          asset.localSource
            ? (src ?? null)
            : props.resource
              ? JSON.stringify([props.environmentId, props.resource])
              : (props.src ?? null)
        }
        failed={failed}
        onOpen={props.onOpen}
        onRetry={() => {
          setFailedSrc(null);
          void refresh().catch(() => undefined);
        }}
        onError={() => setFailedSrc(src ?? null)}
      />
    </span>
  );
}
