import { T, useGT } from "gt-react";
import { type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "./ui/sheet";

export function RightPanelSheet(props: {
  animationDurationMs: number;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  /** The labeled surface list, sized and styled like the app sidebar. */
  launcher?: boolean;
  initialFocus?: () => HTMLElement | null;
}) {
  const gt = useGT();
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open, eventDetails) => {
        if (open) return;
        // Base UI's dismiss handler fires on held Esc repeats after a nested popup closes.
        if (eventDetails.reason === "escape-key" && eventDetails.event.repeat) {
          return eventDetails.cancel();
        }
        props.onClose();
      }}
    >
      {/* On phones the left edge clears the fixed sidebar toggle (2rem) and bell (2.25rem), which sit above the sheet. */}
      <SheetPopup
        transitionDurationMs={props.animationDurationMs}
        side="right"
        showCloseButton={false}
        variant={props.launcher ? "sidebar" : "default"}
        {...(props.launcher ? { "aria-label": gt("Right panel") } : {})}
        {...(props.initialFocus ? { initialFocus: props.initialFocus } : {})}
        {...(props.launcher ? { finalFocus: false } : {})}
        className={cn(
          props.launcher
            ? "w-[min(17rem,85vw)] max-[760px]:w-[min(17rem,85vw,calc(100vw-var(--workspace-controls-left)-4.5rem-1px))]"
            : "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-[min(88vw,24rem,calc(100vw-var(--workspace-controls-left)-4.5rem-1px))] max-[760px]:min-w-0",
          "wco:mt-(--workspace-topbar-height) wco:h-[calc(100%-var(--workspace-topbar-height))] wco:max-h-[calc(100%-var(--workspace-topbar-height))]",
        )}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>
            <T>Workspace panel</T>
          </SheetTitle>
        </SheetHeader>
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
