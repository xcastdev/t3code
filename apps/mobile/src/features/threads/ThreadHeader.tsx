import { useNavigation } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Platform } from "react-native";
import { useGT, useMessages } from "gt-react-native";
import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import { ScreenHeaderButton } from "../../components/ui/ScreenHeaderButton";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useAgentThreadLink } from "../assistants/useAgentThreadLink";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  useThreadGitPanelItems,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";
import type { ThreadToolAction } from "./thread-tools-panel";
import { ThreadToolsPanel } from "./ThreadToolsPanel";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useCanShareWithGuest } from "./useCanShareWithGuest";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const goBack = useWorkspaceBackNavigation();
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(String(props.gitControls.environmentId));
  const threadId = ThreadId.make(String(props.gitControls.threadId));
  const { layout, toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const gitPanelItems = useThreadGitPanelItems(props.gitControls);
  const projectId = useThreadSelection().selectedThread?.projectId ?? null;
  const agentLink = useAgentThreadLink(environmentId, threadId);
  const [toolsOpen, setToolsOpen] = useState(false);
  // Phones move Files, Terminal and History into the tools panel; columns keep the inspector.
  const compact = !layout.usesSplitView;
  const canShareWithGuest = useCanShareWithGuest(props.draft ? null : environmentId);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const openHistory = () => navigation.navigate("ThreadHistory", { environmentId, threadId });
  const agentAction: AppBarAction | null =
    agentLink === null
      ? null
      : {
          accessibilityLabel: agentLink.label,
          icon: "person.crop.circle",
          onPress: agentLink.open,
        };
  const toolsAction: AppBarAction = {
    accessibilityLabel: gt("Open tools"),
    icon: "sidebar.right",
    separateBackground: false,
    onPress: () => setToolsOpen(true),
  };
  // The iOS header toolbar lays out right to left, so the first action sits at the far edge.
  const toolsFirst = compact && Platform.OS === "ios";
  const detailsAction: AppBarAction | null = props.draft
    ? null
    : {
        accessibilityLabel: gt("Thread details"),
        icon: "info.circle",
        separateBackground: false,
        onPress: () => navigation.navigate("ThreadLiveDetails", { environmentId, threadId }),
      };
  const compactActions = [
    ...(toolsFirst ? [toolsAction] : []),
    ...(detailsAction === null ? [] : [detailsAction]),
  ];
  const actions: AppBarAction[] = compact
    ? [...compactActions, ...(agentAction === null ? [] : [agentAction])]
    : [
        ...(props.hasThreadCwd
          ? [
              {
                accessibilityLabel: filesVisible ? gt("Close files") : gt("Open files"),
                icon: "folder",
                selected: filesVisible,
                disabled: !props.gitControls.canOpenFiles,
                separateBackground: false,
                onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
              } satisfies AppBarAction,
            ]
          : []),
        ...(agentAction === null ? [] : [agentAction]),
        { accessibilityLabel: gt("Thread history"), icon: "clock", onPress: openHistory },
      ];
  // Phones list Git in the tools panel; the header slot opens the thread details instead.
  const menus = [
    compact ? null : gitMenu,
    compact ? null : threadTerminalMenu(props.gitControls, m),
  ].filter((menu): menu is AppBarMenu => menu !== null);

  const runTool = (action: ThreadToolAction) => {
    const controls = props.gitControls;
    if (action.type === "terminal") controls.onOpenTerminal(action.terminalId);
    else if (action.type === "new-terminal") controls.onOpenNewTerminal();
    else if (action.type === "script") void controls.onRunProjectScript(action.script);
    else if (action.type === "files") {
      if (props.draft) props.onOpenFilesInspector();
      else navigation.navigate("ThreadFiles", { environmentId, threadId });
    } else if (action.type === "browser")
      navigation.navigate("ThreadBrowserPreview", { environmentId, threadId });
    else if (action.type === "device")
      navigation.navigate("ThreadDevicePreview", { environmentId, threadId });
    else if (action.type === "project") {
      if (projectId !== null)
        navigation.navigate("ProjectWork", {
          environmentId: String(environmentId),
          projectId: String(projectId),
          section: action.section,
        });
    } else if (action.type === "git") findGitItem(gitPanelItems, action.itemId)?.onPress();
    else if (action.type === "guest-share")
      navigation.navigate("ThreadGuestShare", { environmentId, threadId });
    else openHistory();
  };

  return (
    <>
      <AppBar
        title={props.title}
        subtitle={props.subtitle}
        onBackToList={goBack}
        onCompose={props.draft ? undefined : startNewTask}
        backInSplitView={
          props.onReturnToThread
            ? {
                accessibilityLabel: gt("Return to chat"),
                icon: "chevron.left",
                onPress: props.onReturnToThread,
              }
            : undefined
        }
        actions={actions}
        menus={menus}
        trailing={
          compact && !toolsFirst ? (
            <ScreenHeaderButton
              accessibilityLabel={gt("Open tools")}
              icon="sidebar.right"
              separateBackground={false}
              onPress={() => setToolsOpen(true)}
            />
          ) : undefined
        }
        hideBottomBorder
      />
      {compact && toolsOpen ? (
        <ThreadToolsPanel
          environmentId={environmentId}
          threadId={threadId}
          tools={{
            hasThread: props.gitControls.hasThread !== false,
            canOpenTerminal: props.gitControls.canOpenTerminal,
            canOperateTerminal: props.gitControls.canOperateTerminal,
            terminalSessions: props.gitControls.terminalSessions,
            projectScripts: props.gitControls.projectScripts,
            hasFiles: props.hasThreadCwd,
            canOpenFiles: props.gitControls.canOpenFiles,
            gitItems: gitPanelItems,
            hasProject: projectId !== null,
            canShareWithGuest,
          }}
          onSelect={runTool}
          onClosed={() => setToolsOpen(false)}
        />
      ) : null}
    </>
  );
}

function findGitItem(
  items: ReadonlyArray<AppBarMenuItem>,
  id: string,
): Extract<AppBarMenuItem, { onPress: () => void }> | null {
  for (const item of items) {
    if ("items" in item) {
      const found = findGitItem(item.items, id);
      if (found !== null) return found;
    } else if (item.id === id) return item;
  }
  return null;
}
