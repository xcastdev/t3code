import { type ReactNode } from "react";

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
        className={cn(
          props.rail ? RIGHT_PANEL_RAIL_SHEET_CLASS_NAME : RIGHT_PANEL_SHEET_CLASS_NAME,
          props.rail &&
            "wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))]",
        )}
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
