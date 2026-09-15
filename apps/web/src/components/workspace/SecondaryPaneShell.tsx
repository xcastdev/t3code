import type { ReactNode } from "react";

import {
  SECONDARY_PANE_DEFAULT_WIDTH,
  type SecondaryPaneLayoutMode,
} from "../../workspacePaneLayout";
import { PreviewPanelShell } from "../preview/PreviewPanelShell";

/** Resizable shell for persistent file tabs; ChatView decides when it is mounted. */
export function SecondaryPaneShell(props: {
  layout?: SecondaryPaneLayoutMode;
  maximized?: boolean;
  children: ReactNode;
}) {
  const stacked = props.layout === "stack";
  return (
    <PreviewPanelShell
      mode={stacked ? "embedded" : "inline"}
      {...(props.maximized === undefined ? {} : { maximized: props.maximized })}
      widthStorageKey="t3code:secondary-pane-width"
      defaultWidth={SECONDARY_PANE_DEFAULT_WIDTH}
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-secondary-pane
        data-secondary-pane-layout={props.layout ?? "inline"}
      >
        {props.children}
      </div>
    </PreviewPanelShell>
  );
}
