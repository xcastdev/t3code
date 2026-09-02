import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";
import { resolveWorkspaceHeaderRightInsetMode } from "../workspacePaneLayout";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

/** Shared workspace top-bar geometry. */
export function WorkspacePageHeader({
  electron = false,
  reserveNativeControls = electron,
  rightPanelRailAligned = false,
  rightPanelControlInset = false,
  rightPanelRailInline = false,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & {
  readonly electron?: boolean;
  readonly reserveNativeControls?: boolean;
  /** Align the header's right controls with the visible right-panel rail. */
  readonly rightPanelRailAligned?: boolean;
  /** Keep header-owned panel controls on the same right anchor without a rail. */
  readonly rightPanelControlInset?: boolean;
  /** Extend the pane header across an inline rail so the controls can occupy its column. */
  readonly rightPanelRailInline?: boolean;
}) {
  const rightInsetMode = resolveWorkspaceHeaderRightInsetMode({
    rightPanelRailAligned,
    rightPanelControlInset,
    reserveNativeControls,
  });

  return (
    <header
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+0.75rem)]",
        electron && "drag-region",
        rightInsetMode === "native-controls" && "wco:pr-[var(--workspace-native-controls-inset)]",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        rightInsetMode === "right-panel-control" &&
          "pr-[calc(env(safe-area-inset-right)+var(--workspace-right-panel-rail-control-inset))] sm:pr-[calc(env(safe-area-inset-right)+var(--workspace-right-panel-rail-control-inset))] wco:pr-[calc(env(safe-area-inset-right)+var(--workspace-right-panel-rail-control-inset))]",
        rightPanelRailInline && "mr-[calc(var(--workspace-right-panel-rail-width)*-1)]",
        className,
      )}
      {...props}
    />
  );
}
