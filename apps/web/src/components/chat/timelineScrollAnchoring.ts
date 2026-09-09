export type TimelineScrollMode = "following-end" | "free-scrolling";

export function keepTimelineEndVisibleAfterOverlayGrowth({
  timeline,
  previousOverlayHeight,
  overlayHeight,
  followingEnd,
}: {
  readonly timeline: { scrollToEnd: (options: { animated: boolean }) => unknown } | null;
  readonly previousOverlayHeight: number;
  readonly overlayHeight: number;
  readonly followingEnd: boolean;
}): void {
  if (timeline && followingEnd && overlayHeight > previousOverlayHeight) {
    void timeline.scrollToEnd({ animated: false });
  }
}
