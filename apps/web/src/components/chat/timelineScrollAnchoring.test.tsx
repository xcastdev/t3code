import { describe, expect, it, vi } from "vite-plus/test";
import { keepTimelineEndVisibleAfterOverlayGrowth } from "./timelineScrollAnchoring";

describe("timeline scroll anchoring", () => {
  it("keeps the live edge visible when the composer overlay grows", () => {
    const scrollToEnd = vi.fn();

    keepTimelineEndVisibleAfterOverlayGrowth({
      timeline: { scrollToEnd },
      previousOverlayHeight: 120,
      overlayHeight: 180,
      followingEnd: true,
    });

    expect(scrollToEnd).toHaveBeenCalledOnce();
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it("leaves the scroll position alone while the user reads history", () => {
    const scrollToEnd = vi.fn();

    keepTimelineEndVisibleAfterOverlayGrowth({
      timeline: { scrollToEnd },
      previousOverlayHeight: 120,
      overlayHeight: 180,
      followingEnd: false,
    });

    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});
