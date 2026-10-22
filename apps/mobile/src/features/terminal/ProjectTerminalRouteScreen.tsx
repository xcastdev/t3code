import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  applyProjectTerminalAttachEvent,
  describeProjectTerminalFailure,
  effectiveProjectTerminal,
  initialProjectTerminalView,
  isProjectTerminalRunning,
  isProjectTerminalViewLive,
  projectTerminalStatusLabel,
  type ProjectTerminalViewState,
} from "@t3tools/client-runtime/project-terminal-view";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId, type ProjectTerminalDockSummary } from "@t3tools/contracts";
import type { StaticScreenProps } from "@react-navigation/native";
import { useContext, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Notice } from "../../components/ui/Notice";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProject } from "../../state/entities";
import {
  projectTerminalEnvironment,
  useProjectTerminalDock,
  useStreamEvents,
} from "../../state/projectTerminals";
import { TerminalSurface } from "./NativeTerminalSurface";

type Props = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly terminalId?: string;
}>;

/**
 * Project-owned terminals, usually started by agents. Opening this screen
 * attaches without spawning; leaving it never stops a process.
 */
export function ProjectTerminalRouteScreen({ route }: Props) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const dock = useProjectTerminalDock(environmentId, projectId);
  const insets = useSafeAreaInsets();
  const [selectedId, setSelectedId] = useState<string | null>(route.params.terminalId ?? null);
  const selected =
    dock.terminals.find((terminal) => terminal.terminalId === selectedId) ??
    (selectedId === null ? dock.terminals[0] : undefined) ??
    null;
  return (
    <View className="flex-1 bg-screen" style={{ paddingBottom: insets.bottom }}>
      <NativeStackScreenOptions options={{ title: project?.title ?? "Project terminals" }} />
      {dock.error !== null ? (
        <View className="gap-2 px-4 pt-3">
          <Notice tone="danger" icon="exclamationmark.triangle" message={dock.error} />
          <View className="flex-row">
            <Button label="Retry" tone="secondary" onPress={dock.retry} />
          </View>
        </View>
      ) : null}
      {!dock.received && dock.error === null ? (
        <Text className="px-4 pt-4 text-sm text-foreground-muted">
          Looking for project terminals…
        </Text>
      ) : null}
      {dock.received && dock.terminals.length === 0 ? (
        <EmptyState
          variant="plain"
          title="No project terminals"
          detail="Agents start these with the terminal tools, for dev servers and watchers. They appear here so you can watch, type into or stop them."
        />
      ) : null}
      {dock.terminals.length > 0 ? (
        <ScrollView
          horizontal
          className="max-h-14 grow-0"
          contentContainerClassName="items-center gap-2 px-4 py-2"
          showsHorizontalScrollIndicator={false}
        >
          {dock.terminals.map((terminal) => (
            <Chip
              key={terminal.terminalId}
              size="small"
              icon="terminal"
              label={`${terminal.label || terminal.terminalId} · ${projectTerminalStatusLabel(terminal)}`}
              selected={selected?.terminalId === terminal.terminalId}
              onPress={() => setSelectedId(terminal.terminalId)}
            />
          ))}
        </ScrollView>
      ) : null}
      {dock.truncated ? (
        <Text className="px-4 text-xs text-foreground-muted">Showing the first 100 terminals.</Text>
      ) : null}
      {selected ? (
        <ProjectTerminalPane
          key={`${environmentId}:${selected.projectId}:${selected.terminalId}`}
          environmentId={environmentId}
          summary={selected}
        />
      ) : dock.terminals.length > 0 ? (
        <Text className="px-4 pt-3 text-sm text-foreground-muted">
          That terminal isn't in this project anymore. Choose another.
        </Text>
      ) : null}
    </View>
  );
}

function ProjectTerminalPane({
  environmentId,
  summary,
}: {
  environmentId: EnvironmentId;
  summary: ProjectTerminalDockSummary;
}) {
  const handle = { projectId: summary.projectId, terminalId: summary.terminalId };
  const registry = useContext(RegistryContext);
  const canWrite = useAtomValue(projectTerminalEnvironment.write.permissionAtom(environmentId));
  const canResize = useAtomValue(projectTerminalEnvironment.resize.permissionAtom(environmentId));
  const canStop = useAtomValue(projectTerminalEnvironment.kill.permissionAtom(environmentId));
  const [state, setState] = useState<ProjectTerminalViewState>(() =>
    initialProjectTerminalView(handle),
  );
  const [streamError, setStreamError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const attachAtom = projectTerminalEnvironment.attach({ environmentId, input: handle });
  useStreamEvents(
    attachAtom,
    (event) => {
      setStreamError(null);
      setState((current) => applyProjectTerminalAttachEvent(current, event));
    },
    setStreamError,
  );
  // A reconnect marker means this reader missed output; reattaching yields a fresh snapshot.
  useEffect(() => {
    if (state.phase === "reconnecting") registry.refresh(attachAtom);
  }, [state.phase, attachAtom, registry]);
  const terminal = effectiveProjectTerminal(state.terminal, summary);
  const live = isProjectTerminalViewLive(state, terminal);
  // Mutations target the generation this pane shows, never one only metadata has seen.
  const shownGeneration = state.terminal?.generation ?? terminal.generation;
  const report = (result: Awaited<ReturnType<typeof projectTerminalEnvironment.write.run>>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setNotice(describeProjectTerminalFailure(squashAtomCommandFailure(result)));
  };
  const write = (data: string) => {
    if (!canWrite || !typing || !live) return;
    void projectTerminalEnvironment.write
      .run(registry, {
        environmentId,
        input: { ...handle, data, expectedGeneration: shownGeneration },
      })
      .then(report);
  };
  const fit = () => {
    const size = sizeRef.current;
    if (size === null || !live) return;
    void projectTerminalEnvironment.resize
      .run(registry, {
        environmentId,
        input: { ...handle, ...size, expectedGeneration: shownGeneration },
      })
      .then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
          setNotice(describeProjectTerminalFailure(squashAtomCommandFailure(result)));
      });
  };
  const stop = () =>
    Dialog.confirm({
      title: `Stop ${terminal.label || terminal.terminalId}?`,
      message: "This ends the process for everyone using it, including the agent that started it.",
      confirmText: "Stop",
      destructive: true,
      onConfirm: () => {
        void projectTerminalEnvironment.kill
          .run(registry, {
            environmentId,
            input: { ...handle, expectedGeneration: shownGeneration },
          })
          .then((result) => {
            if (result._tag === "Failure") {
              if (!isAtomCommandInterrupted(result))
                setNotice(describeProjectTerminalFailure(squashAtomCommandFailure(result)));
              return;
            }
            setNotice(
              result.value.status === "exited"
                ? "Stopped."
                : result.value.status === "requested"
                  ? "Stop requested. The status updates when the process exits."
                  : "The stop couldn't be confirmed. The process may still be running.",
            );
          });
      },
    });
  return (
    <View className="flex-1 gap-2 px-3 pt-1">
      <Text className="px-1 text-xs text-foreground-muted">
        {[
          projectTerminalStatusLabel(terminal),
          `generation ${terminal.generation.slice(0, 8)}`,
          state.cols !== null && state.rows !== null ? `${state.cols}×${state.rows}` : null,
          state.phase === "attaching" ? "attaching…" : null,
          state.phase === "reconnecting" ? "reconnecting; output may have a gap" : null,
          state.phase === "closed" ? "removed" : null,
        ]
          .filter((part): part is string => part !== null)
          .join(" · ")}
      </Text>
      {streamError !== null ? <Notice tone="danger" message={streamError} /> : null}
      {notice !== null ? <Notice message={notice} onDismiss={() => setNotice(null)} /> : null}
      {state.trimmed ? (
        <Text className="px-1 text-xs text-foreground-muted">
          Earlier output is no longer kept; showing the most recent output.
        </Text>
      ) : null}
      <TerminalSurface
        className="flex-1"
        terminalKey={`project:${environmentId}:${handle.projectId}:${handle.terminalId}:${shownGeneration}`}
        buffer={state.terminal === null ? null : state.history}
        isRunning={live}
        readOnly={!canWrite || !typing || !live}
        autoFocus={false}
        onInput={write}
        // The PTY follows this screen only through "Fit"; viewers never resize it on their own.
        onResize={(size) => {
          sizeRef.current = size;
        }}
      />
      <ListToggleRow
        icon="keyboard"
        label="Allow typing"
        description="Keystrokes go to the running process"
        disabled={!canWrite || !live}
        value={typing}
        onValueChange={setTyping}
      />
      <View className="flex-row gap-2 px-1 pb-2">
        <Button
          label="Fit to screen"
          tone="secondary"
          disabled={!canResize || !live}
          onPress={fit}
        />
        <Button
          label="Stop"
          tone="danger"
          disabled={!canStop || !isProjectTerminalRunning(terminal.status)}
          onPress={stop}
        />
      </View>
    </View>
  );
}
