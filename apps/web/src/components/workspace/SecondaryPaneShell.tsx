import type { ReactNode } from "react";

import type { SecondaryPaneSurface } from "../../secondaryPaneStore";
import {
  SECONDARY_PANE_DEFAULT_WIDTH,
  SECONDARY_PANE_MIN_WIDTH,
  type SecondaryPaneLayoutMode,
} from "../../workspacePaneLayout";
import { cn } from "~/lib/utils";
import { PreviewPanelShell } from "../preview/PreviewPanelShell";

import { SecondaryPaneTabs } from "./SecondaryPaneTabs";

export function SecondaryPaneShell(props: {
  surfaces: readonly SecondaryPaneSurface[];
  activeSurfaceId: string | null;
  onActivate: (surface: SecondaryPaneSurface) => void;
  onClose: (surface: SecondaryPaneSurface) => void;
  onCloseOtherSurfaces: (surface: SecondaryPaneSurface) => void;
  onCloseSurfacesToRight: (surface: SecondaryPaneSurface) => void;
  onCloseAllSurfaces: () => void;
  onCopyPath: (relativePath: string) => void;
  layout?: SecondaryPaneLayoutMode;
  children: ReactNode;
}) {
  const isStacked = props.layout === "stack";
  return (
    <PreviewPanelShell
      mode={isStacked ? "embedded" : "inline"}
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
        <SecondaryPaneTabs
          surfaces={props.surfaces}
          activeSurfaceId={props.activeSurfaceId}
          onActivate={props.onActivate}
          onClose={props.onClose}
          onCloseOtherSurfaces={props.onCloseOtherSurfaces}
          onCloseSurfacesToRight={props.onCloseSurfacesToRight}
          onCloseAllSurfaces={props.onCloseAllSurfaces}
          onCopyPath={props.onCopyPath}
        />
        <div className="flex min-h-0 flex-1 flex-col" data-secondary-pane-content>
          {props.children}
        </div>
      </div>
    </PreviewPanelShell>
  );
}
