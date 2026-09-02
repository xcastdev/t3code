import { type ReactNode, useRef } from "react";

import {
  RIGHT_PANEL_RAIL_SHEET_CLASS_NAME,
  RIGHT_PANEL_SHEET_CLASS_NAME,
} from "../rightPanelLayout";
import { cn } from "~/lib/utils";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  rail?: boolean;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);

  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        ref={sheetRef}
        initialFocus={sheetRef}
        className={cn(
          props.rail ? RIGHT_PANEL_RAIL_SHEET_CLASS_NAME : RIGHT_PANEL_SHEET_CLASS_NAME,
          props.rail &&
            "mt-[var(--workspace-topbar-height)] h-[calc(100%-var(--workspace-topbar-height))] max-h-[calc(100%-var(--workspace-topbar-height))]",
        )}
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
