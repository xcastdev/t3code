import { flushSync } from "react-dom";

import { usePreviewPanelInlineSize } from "../../hooks/usePreviewPanelInlineSize";
import { RightPanelSheet } from "../RightPanelSheet";
import {
  RAIL_FIRST_ACTION_SELECTOR,
  RightPanelTabs,
  type RightPanelTabsProps,
} from "../RightPanelTabs";

type ChatRightPanelProps = Omit<RightPanelTabsProps, "mode" | "inlineSize" | "maximized"> & {
  readonly compact: boolean;
  readonly maximized: boolean;
  readonly workspaceLayoutElement: HTMLElement | null;
  readonly widthStorageKey: string;
  readonly sheetAnimationDurationMs: number;
  readonly onCloseSheet: () => void;
};

// Focuses right away: workspace focus recovery would otherwise land on the moved toggle's copy
// in the overlay header a frame before Base UI's deferred initial focus runs.
const focusFirstLauncherAction = () => {
  const action = document.querySelector<HTMLElement>(RAIL_FIRST_ACTION_SELECTOR);
  action?.focus({ preventScroll: true });
  return action;
};
const rightPanelToggle = () =>
  document.querySelector<HTMLElement>("[data-chat-header] [data-right-panel-toggle]");

/**
 * The right panel, inline beside the chat column, or on compact layouts an
 * overlay: the labeled surface list until a surface opens, then that surface
 * in a wider sheet. Its width follows a resize drag every frame, so the width
 * state lives here rather than in ChatView.
 */
export function ChatRightPanel(props: ChatRightPanelProps) {
  const {
    compact,
    workspaceLayoutElement,
    widthStorageKey,
    sheetAnimationDurationMs,
    onCloseSheet,
    maximized,
    layoutControls,
    ...tabs
  } = props;
  const inlineSize = usePreviewPanelInlineSize({
    container: workspaceLayoutElement,
    widthStorageKey,
  });
  if (!compact) {
    return <RightPanelTabs {...tabs} mode="inline" maximized={maximized} inlineSize={inlineSize} />;
  }
  const open = tabs.open === true;
  const launcher = tabs.activeSurfaceId === null;
  const sheetTabs = (
    <RightPanelTabs
      {...tabs}
      mode="sheet"
      inlineSize={inlineSize}
      layoutControls={layoutControls}
    />
  );
  return (
    <>
      <RightPanelSheet
        launcher
        animationDurationMs={sheetAnimationDurationMs}
        open={open && launcher}
        onClose={() => {
          // Base UI resolves return focus before the panel controls move back to the header,
          // so Escape and backdrop closes hand focus to the header toggle here.
          flushSync(onCloseSheet);
          rightPanelToggle()?.focus({ preventScroll: true });
        }}
        initialFocus={focusFirstLauncherAction}
      >
        {launcher ? sheetTabs : null}
      </RightPanelSheet>
      <RightPanelSheet
        animationDurationMs={sheetAnimationDurationMs}
        open={open && !launcher}
        onClose={onCloseSheet}
      >
        {launcher ? null : sheetTabs}
      </RightPanelSheet>
    </>
  );
}
