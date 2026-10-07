import { resolveDefaultBranchActionDialogCopy } from "@t3tools/client-runtime/state/vcs";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { Platform, View } from "react-native";

import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { AppText as Text } from "../../../components/AppText";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { cloneDisplayedGitSource, type DisplayedGitSource } from "./git-action-source";
import { SheetActionButton } from "./gitSheetComponents";

type GitConfirmSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly confirmAction?: string;
  readonly branchName?: string;
  readonly includesCommit?: string;
  readonly commitMessage?: string;
  readonly filePaths?: string;
  readonly source?: DisplayedGitSource | null;
}>;

export function GitConfirmSheet(props: GitConfirmSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const gitActions = useSelectedThreadGitActions();

  const params = props.route.params;
  const [source] = useState(() => cloneDisplayedGitSource(params.source));
  const sourceIsCurrent =
    source !== null &&
    source.environmentId === params.environmentId &&
    source.threadId === params.threadId &&
    gitActions.isDisplayedSourceCurrent(source);

  const confirmAction =
    params.confirmAction === "push" ||
    params.confirmAction === "create_pr" ||
    params.confirmAction === "commit_push" ||
    params.confirmAction === "commit_push_pr"
      ? params.confirmAction
      : undefined;
  const branchName = params.branchName ?? "";
  const includesCommit = params.includesCommit === "true";
  const environmentId = params.environmentId ?? "";
  const threadId = params.threadId ?? "";

  const copy = useMemo(
    () =>
      confirmAction
        ? resolveDefaultBranchActionDialogCopy({
            action: confirmAction,
            branchName,
            includesCommit,
          })
        : null,
    [branchName, confirmAction, includesCommit],
  );

  const continuePendingAction = useCallback(async () => {
    if (!confirmAction || !sourceIsCurrent) return;
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));
    await gitActions.onRunSelectedThreadGitAction(
      {
        action: confirmAction,
        ...(params.commitMessage ? { commitMessage: params.commitMessage } : {}),
        ...(params.filePaths ? { filePaths: params.filePaths.split(",") } : {}),
      },
      source,
    );
  }, [
    confirmAction,
    environmentId,
    gitActions,
    params,
    navigation,
    source,
    sourceIsCurrent,
    threadId,
  ]);

  const movePendingActionToFeatureBranch = useCallback(async () => {
    if (!confirmAction || !sourceIsCurrent) return;
    if (!includesCommit) {
      navigation.dispatch(StackActions.replace("GitBranches", { environmentId, threadId }));
      return;
    }
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));
    await gitActions.onRunSelectedThreadGitAction(
      {
        action: confirmAction,
        featureBranch: true,
        ...(params.commitMessage ? { commitMessage: params.commitMessage } : {}),
        ...(params.filePaths ? { filePaths: params.filePaths.split(",") } : {}),
      },
      source,
    );
  }, [
    confirmAction,
    environmentId,
    gitActions,
    includesCommit,
    navigation,
    params,
    source,
    sourceIsCurrent,
    threadId,
  ]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <AndroidSheetHeader title="Confirm action" onBack={() => navigation.goBack()} />
      ) : (
        <View className="min-h-4 pt-2" />
      )}

      <View className="items-center gap-1 px-5 pb-3 pt-4">
        <Text className="text-xs font-t3-bold tracking-[1px] uppercase text-foreground-muted">
          Confirm
        </Text>
        <Text className="text-center text-3xl font-t3-bold">
          {copy?.title ?? "Run action on default branch?"}
        </Text>
        <Text className="text-center text-foreground-secondary text-sm font-medium leading-normal">
          {includesCommit
            ? (copy?.description ?? "Choose how to continue.")
            : "Continue on this branch, or choose another branch and review the action there."}
        </Text>
      </View>

      {!sourceIsCurrent ? (
        <Text>Git source changed or is unavailable. Close this sheet and review it again.</Text>
      ) : null}
      <View className="gap-3 px-5 pt-2" style={{ paddingBottom: Math.max(insets.bottom, 18) + 8 }}>
        <SheetActionButton
          icon="arrow.right.circle"
          label={copy?.continueLabel ?? "Continue"}
          disabled={!sourceIsCurrent}
          onPress={() => void continuePendingAction()}
        />
        <SheetActionButton
          icon="arrow.branch"
          label={includesCommit ? "Feature branch & continue" : "Choose another branch"}
          disabled={!sourceIsCurrent}
          tone="primary"
          onPress={() => void movePendingActionToFeatureBranch()}
        />
      </View>
    </View>
  );
}
