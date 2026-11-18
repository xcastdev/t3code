import { useRoute } from "@react-navigation/native";
import type { ReactNode } from "react";
import { View } from "react-native";

import type { AppBarProps } from "../../../components/ui/AppBar.types";
import { AppBar } from "../../../components/ui/AppBar";
import { ScreenContent as SettingsScreenContent } from "../../../components/ui/ScreenContent";
import { useAdaptiveWorkspaceLayout } from "../../layout/adaptive-workspace-context";
import { useDeviceType } from "../../../native/native-layout-metrics";
import { useCompactWorkspaceTabs } from "../../layout/workspace/useSystemWorkspaceTabBar";
import { useSettingsPageBack } from "../useSettingsPageBack";
import {
  ScreenScrollViewBottomInset,
  ScreenScrollViewSurface,
} from "../../../components/ui/ScreenScrollView";

export { SettingsScreenContent };

export function SettingsScreen(
  props: Pick<
    AppBarProps,
    "title" | "actions" | "refresh" | "trailing" | "search" | "menus" | "guardBack"
  > & {
    readonly children: ReactNode;
    readonly workspaceRoot?: boolean;
  },
) {
  const route = useRoute();
  const { layout } = useAdaptiveWorkspaceLayout();
  const deviceType = useDeviceType();
  const compactTabs = useCompactWorkspaceTabs();
  const back = useSettingsPageBack();
  const cover = deviceType === "duo-folded";
  // Beside columns the Settings list is a workspace tab with nothing to go back to; without
  // them it is a page pushed over the tabs.
  const workspaceRoot = props.workspaceRoot || (layout.usesSplitView && route.name === "Settings");

  const surfaceClassName = workspaceRoot || cover ? "bg-screen" : "bg-sheet";

  return (
    <View collapsable={false} className={`flex-1 ${surfaceClassName}`}>
      <AppBar
        title={props.title}
        actions={props.actions}
        refresh={props.refresh}
        search={props.search}
        trailing={props.trailing}
        menus={props.menus}
        onBack={workspaceRoot ? undefined : back}
        guardBack={props.guardBack}
        hideBottomBorder
      />
      <ScreenScrollViewBottomInset value={deviceType === "pad" || compactTabs ? 80 : 0}>
        <ScreenScrollViewSurface value={surfaceClassName}>
          <SettingsScreenContent>{props.children}</SettingsScreenContent>
        </ScreenScrollViewSurface>
      </ScreenScrollViewBottomInset>
    </View>
  );
}
