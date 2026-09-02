import type { ReactNode } from "react";

import {
  SECONDARY_PANE_DEFAULT_WIDTH,
  SECONDARY_PANE_MIN_WIDTH,
  type SecondaryPaneLayoutMode,
} from "../../workspacePaneLayout";
import { cn } from "~/lib/utils";
import { PreviewPanelShell } from "../preview/PreviewPanelShell";

export function SecondaryPaneShell(props: {
  layout?: SecondaryPaneLayoutMode;
  maximized?: boolean;
  children: ReactNode;
}) {
  const isStacked = props.layout === "stack";
  return (
    <PreviewPanelShell
      mode={isStacked ? "embedded" : "inline"}
      {...(props.maximized === undefined ? {} : { maximized: props.maximized })}
      widthStorageKey="t3code:secondary-pane-width"
      defaultWidth={SECONDARY_PANE_DEFAULT_WIDTH}
      minWidth={SECONDARY_PANE_MIN_WIDTH}
      className={cn(isStacked && "min-h-0 flex-1")}
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-secondary-pane
        data-secondary-pane-layout={props.layout ?? "inline"}
      >
        <div className="flex min-h-0 flex-1 flex-col" data-secondary-pane-content>
          {props.children}
        </div>
      </div>
    </PreviewPanelShell>
  );
}
