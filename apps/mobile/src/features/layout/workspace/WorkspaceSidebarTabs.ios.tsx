import { selectedNavigationTab, visibleNavigationTabs } from "./navigation-tab-order";
import { requireNativeView } from "expo";
import type { MenuAction } from "@react-native-menu/menu";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { useControlTheme } from "../../../components/ui/useControlTheme";
import { useNavigationTabOrder, useHiddenNavigationTabs } from "./navigation-tabs";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";

const NativeSidebarTabBar = requireNativeView<
  ViewProps & {
    tabs: readonly string[];
    selectedTab: string;
    selectedColor: string;
    appearance: string;
    showsCompose: boolean;
    compact?: boolean;
    composeMenu: readonly MenuAction[];
    onSelectionChange: (event: NativeSyntheticEvent<{ tab: string }>) => void;
    onCompose: () => void;
    onComposeMenuAction: (event: NativeSyntheticEvent<{ id: string }>) => void;
  }
>("T3NativeControls", "SidebarTabBar");

const NO_MENU: readonly MenuAction[] = [];

export function WorkspaceSidebarTabs(props: {
  readonly onNewTask?: () => void;
  /** Compose's long-press menu. */
  readonly composeMenu?: {
    readonly actions: readonly MenuAction[];
    readonly onSelect: (id: string) => void;
  };
  readonly compact?: boolean;
  readonly reserveComposeSpace?: boolean;
}) {
  const workspace = useWorkspaceTabs()!;
  const { layout } = useAdaptiveWorkspaceLayout();
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  const tabs = visibleNavigationTabs(order, hidden);
  const selectTab = useSelectWorkspaceTab();
  const { colors, colorScheme } = useControlTheme();
  // UIKit loses accessible names when updating nil-titled items in place.
  const tabBarKey = tabs.join(":");
  return (
    <NativeSidebarTabBar
      key={tabBarKey}
      tabs={tabs}
      selectedTab={selectedNavigationTab(
        order,
        workspace.state.selectedTab,
        workspace.settingsOpen,
        hidden,
      )}
      selectedColor={colors["--color-primary"]}
      appearance={colorScheme}
      showsCompose={Boolean(props.onNewTask)}
      compact={props.compact}
      onCompose={() => props.onNewTask?.()}
      composeMenu={props.composeMenu?.actions ?? NO_MENU}
      onComposeMenuAction={({ nativeEvent }) => props.composeMenu?.onSelect(nativeEvent.id)}
      onSelectionChange={({ nativeEvent }) => {
        const tab = tabs.find((candidate) => candidate === nativeEvent.tab);
        if (tab) selectTab(tab);
      }}
      // Keep the host stable while UIKit updates the bars' intrinsic size and safe area together.
      style={{
        position: "absolute",
        bottom: 0,
        left: props.compact ? 8 : 0,
        maxWidth: layout.variant === "medium" ? 280 : undefined,
        // Keep the tab icons in place when Compose disappears on other destinations.
        right:
          (props.compact ? 12 : 0) +
          ((props.reserveComposeSpace ?? props.compact) && !props.onNewTask
            ? props.compact
              ? 64
              : 76
            : 0),
        height: 128,
      }}
    />
  );
}
