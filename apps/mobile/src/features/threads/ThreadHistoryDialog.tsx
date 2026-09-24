import { ThreadId, type EnvironmentId, type OrchestrationThread } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Alert, Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { waitForThreadCheckpoint } from "../../state/entities";

export function ThreadHistoryDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly running: boolean;
  readonly currentThread: OrchestrationThread | null;
}) {
  const [open, setOpen] = useState(false);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [messageLimit, setMessageLimit] = useState(40);
  const [forkTurnCount, setForkTurnCount] = useState<number | null>(null);
  const navigation = useNavigation();
  const archives = useEnvironmentQuery(
    open
      ? orchestrationEnvironment.historyArchives({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : null,
  );
  const snapshot = useEnvironmentQuery(
    open && archiveId
      ? orchestrationEnvironment.historyArchive({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, archiveId },
        })
      : null,
  );
  const restore = useAtomCommand(threadEnvironment.restoreHistory, { reportFailure: false });
  const fork = useAtomCommand(threadEnvironment.forkHistory, { reportFailure: false });
  const forkSource = archiveId ? snapshot.data : props.currentThread;

  const restorePath = async (restoreFiles: boolean) => {
    if (!archiveId || busy) return;
    setBusy(true);
    try {
      const result = await restore({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, archiveId, restoreFiles },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setOpen(false);
      setArchiveId(null);
    } catch (error) {
      Alert.alert(
        "Could not restore history",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusy(false);
    }
  };
  const forkPath = async (restoreFiles: boolean) => {
    if (forkTurnCount === null || busy) return;
    setBusy(true);
    const forkThreadId = ThreadId.make(uuidv4());
    try {
      const result = await fork({
        environmentId: props.environmentId,
        input: {
          threadId: props.threadId,
          forkThreadId,
          ...(archiveId ? { archiveId } : {}),
          turnCount: forkTurnCount,
          restoreFiles,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const created = await waitForThreadCheckpoint(
        {
          environmentId: props.environmentId,
          threadId: forkThreadId,
        },
        forkTurnCount,
      );
      if (!created) throw new Error("Timed out waiting for the forked thread.");
      setOpen(false);
      navigation.dispatch(
        StackActions.push("Thread", {
          environmentId: String(props.environmentId),
          threadId: String(forkThreadId),
        }),
      );
    } catch (error) {
      Alert.alert("Could not fork history", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        className="self-end px-4 py-2"
      >
        <Text className="text-sm text-foreground-muted">History</Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <View className="flex-1 bg-background px-4 pt-6">
          <View className="mb-4 flex-row items-center justify-between">
            <Text className="text-xl font-t3-bold text-foreground">Thread history</Text>
            <Pressable onPress={() => setOpen(false)} accessibilityRole="button">
              <Text className="text-base text-primary">Done</Text>
            </Pressable>
          </View>
          <Text className="mb-4 text-sm text-foreground-muted">
            Reverted paths stay here. Restoring one replaces this thread and saves its current path.
          </Text>
          {archives.error ? <Text className="text-destructive">{archives.error}</Text> : null}
          {archives.isPending ? <Text>Loading history…</Text> : null}
          <ScrollView className="max-h-44">
            <Pressable
              onPress={() => {
                setArchiveId(null);
                setForkTurnCount(null);
              }}
              accessibilityRole="button"
              className="border-b border-border-subtle py-3"
            >
              <Text className="text-foreground">Current path</Text>
            </Pressable>
            {archives.data?.map((archive) => (
              <Pressable
                key={archive.archiveId}
                onPress={() => {
                  setArchiveId(archive.archiveId);
                  setMessageLimit(40);
                  setForkTurnCount(null);
                }}
                accessibilityRole="button"
                className="border-b border-border-subtle py-3"
              >
                <Text className="text-foreground">
                  {new Date(archive.createdAt).toLocaleString()} · {archive.turnCount} turns
                </Text>
              </Pressable>
            ))}
            {archives.data?.length === 0 ? <Text>No archived paths yet.</Text> : null}
          </ScrollView>
          {archiveId && snapshot.data ? (
            <ScrollView className="my-4 flex-1 rounded-xl border border-border-subtle p-3">
              {snapshot.data.messages.length > messageLimit ? (
                <Pressable
                  onPress={() => setMessageLimit((limit) => limit + 40)}
                  accessibilityRole="button"
                >
                  <Text className="mb-3 text-primary">Show older messages</Text>
                </Pressable>
              ) : null}
              {snapshot.data.messages.slice(-messageLimit).map((message) => (
                <Text key={message.id} className="mb-3 text-foreground">
                  {message.role}: {message.text}
                </Text>
              ))}
            </ScrollView>
          ) : null}
          {forkSource && forkSource.checkpoints.length > 0 ? (
            <View className="my-3 gap-2">
              <Text className="font-t3-medium text-foreground">Fork from a checkpoint</Text>
              {forkSource.checkpoints
                .map((checkpoint) => checkpoint.checkpointTurnCount)
                .filter((count, index, values) => values.indexOf(count) === index)
                .map((count) => (
                  <Pressable
                    key={count}
                    onPress={() => setForkTurnCount(count)}
                    accessibilityRole="button"
                    className="rounded-xl bg-subtle p-3"
                  >
                    <Text className="text-foreground">
                      {forkTurnCount === count ? "✓ " : ""}
                      {count === 0 ? "Before first turn" : `After turn ${count}`}
                    </Text>
                  </Pressable>
                ))}
            </View>
          ) : null}
          {forkTurnCount !== null ? (
            <View className="gap-2 pb-3">
              <Pressable
                disabled={busy || props.running}
                onPress={() => void forkPath(false)}
                accessibilityRole="button"
                className="rounded-xl bg-subtle p-3"
              >
                <Text className="text-center text-foreground">Fork and keep files</Text>
              </Pressable>
              <Pressable
                disabled={busy || props.running}
                onPress={() => void forkPath(true)}
                accessibilityRole="button"
                className="rounded-xl bg-primary p-3"
              >
                <Text className="text-center text-primary-foreground">Fork files too</Text>
              </Pressable>
            </View>
          ) : null}
          {archiveId ? (
            <View className="gap-3 pb-8">
              <Pressable
                disabled={busy || props.running}
                onPress={() => void restorePath(false)}
                accessibilityRole="button"
                className="rounded-xl bg-subtle p-3"
              >
                <Text className="text-center text-foreground">Restore and keep files</Text>
              </Pressable>
              <Pressable
                disabled={busy || props.running}
                onPress={() => void restorePath(true)}
                accessibilityRole="button"
                className="rounded-xl bg-primary p-3"
              >
                <Text className="text-center text-primary-foreground">Restore files too</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </Modal>
    </>
  );
}
