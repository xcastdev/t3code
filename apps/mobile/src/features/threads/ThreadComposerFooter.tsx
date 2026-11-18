import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ServerConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Keyboard, Pressable, useWindowDimensions, View } from "react-native";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import type { RemoteClientConnectionState } from "../../lib/connection";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadWorktreePath } from "../../state/use-thread-detail";
import { vcsEnvironment } from "../../state/vcs";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { resolvePreferredThreadWorktreePath } from "../terminal/terminalLaunchContext";
import {
  resolveThreadWorkspacePresentation,
  threadComposerFooterHidesWhileTyping,
} from "./threadComposerFooter";

export const THREAD_COMPOSER_FOOTER_HEIGHT = 26;

export function ThreadComposerFooter(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadBranch: string | null;
  readonly threadWorktreePath: string | null;
  /** The thread's working directory; the route screen subscribes to the same status. */
  readonly cwd: string | null;
  readonly environmentLabel: string | null;
  readonly connectionState: RemoteClientConnectionState;
  readonly serverConfig: ServerConfig | null;
  readonly editorFocused: boolean;
}) {
  const navigation = useNavigation();
  const { height: windowHeight } = useWindowDimensions();
  const detailWorktreePath = useThreadWorktreePath(
    scopeThreadRef(props.environmentId, props.threadId),
  );
  const gitStatus = useEnvironmentQuery(
    props.cwd === null
      ? null
      : vcsEnvironment.status({ environmentId: props.environmentId, input: { cwd: props.cwd } }),
  ).data;

  if (props.editorFocused && threadComposerFooterHidesWhileTyping(windowHeight)) return null;

  const isRepo = gitStatus?.isRepo ?? true;
  const workspace = resolveThreadWorkspacePresentation({
    worktreePath: resolvePreferredThreadWorktreePath({
      threadShellWorktreePath: props.threadWorktreePath,
      threadDetailWorktreePath: detailWorktreePath,
    }),
    threadBranch: props.threadBranch,
    liveBranch: gitStatus?.refName ?? null,
    isRepo,
  });
  const machineLabel = props.environmentLabel ?? "Environment";
  const status = connectionStatusText({
    phase: props.connectionState,
    error: null,
    traceId: null,
  });
  const workspaceKind = workspace.kind === "worktree" ? "Worktree" : "Local checkout";

  return (
    <View
      className="flex-row items-center justify-between gap-3 px-2"
      style={{ height: THREAD_COMPOSER_FOOTER_HEIGHT }}
    >
      <Menu
        title={machineLabel}
        actions={[
          {
            id: "status",
            title: status,
            subtitle: "A thread stays on the machine it started on.",
            attributes: { disabled: true },
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Runs on ${machineLabel}, ${status}`}
          className="min-w-0 shrink flex-row items-center gap-1.5 active:opacity-65"
          hitSlop={8}
        >
          <EnvironmentMachineSymbol
            kind={resolveEnvironmentMachineKind(props.serverConfig)}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
          <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
            {machineLabel}
          </Text>
          <ConnectionStatusDot state={props.connectionState} pulse={false} size={6} />
        </Pressable>
      </Menu>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${workspaceKind}, ${workspace.label}`}
        accessibilityHint="Opens branches and worktrees"
        disabled={!isRepo}
        hitSlop={8}
        onPress={() => {
          Keyboard.dismiss();
          navigation.navigate("GitBranches", {
            environmentId: String(props.environmentId),
            threadId: String(props.threadId),
          });
        }}
        className="min-w-0 shrink flex-row items-center gap-1.5 active:opacity-65"
      >
        <SymbolView
          name={
            workspace.kind === "worktree"
              ? "arrow.triangle.branch"
              : { ios: "folder", android: "folder" }
          }
          size={12}
          tintColorClassName="accent-icon-muted"
        />
        <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
          {workspace.label}
        </Text>
        {isRepo ? (
          <SymbolView name="chevron.down" size={10} tintColorClassName="accent-icon-muted" />
        ) : null}
      </Pressable>
    </View>
  );
}
