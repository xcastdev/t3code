import { useAtomValue } from "@effect/atom-react";
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
import type {
  EnvironmentId,
  ProjectTerminalDockSummary,
  ProjectTerminalHandle,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { RegistryContext } from "@effect/atom-react";

import {
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useClientSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { projectTerminalEnvironment, useStreamEvents } from "../../state/projectTerminals";
import { GhosttyTerminalSurface } from "../../terminal/ghostty/surface";
import { terminalThemeFromApp } from "../ThreadTerminalDrawer";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";

type ViewerPhase = Pick<
  ProjectTerminalViewState,
  "phase" | "terminal" | "trimmed" | "cols" | "rows"
>;

const fontOptions = (family: string, size: number) =>
  family.trim().length > 0 ? { family: family.trim(), size } : { size };

/**
 * Observes one project-owned terminal. Attaching never starts a process and
 * closing the viewer never stops one; input and resize are explicit and carry
 * the generation the viewer is showing.
 */
export function ProjectTerminalViewer({
  environmentId,
  summary,
}: {
  environmentId: EnvironmentId;
  summary: ProjectTerminalDockSummary;
}) {
  const handle: ProjectTerminalHandle = {
    projectId: summary.projectId,
    terminalId: summary.terminalId,
  };
  const registry = useContext(RegistryContext);
  const canWrite = useAtomValue(projectTerminalEnvironment.write.permissionAtom(environmentId));
  const canResize = useAtomValue(projectTerminalEnvironment.resize.permissionAtom(environmentId));
  const canStop = useAtomValue(projectTerminalEnvironment.kill.permissionAtom(environmentId));
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const fontFamily = useClientSettings((settings) =>
    resolveTerminalFontPreference({
      advanced: advancedTypography,
      code: settings.fontFamilyCode,
      terminal: settings.fontFamilyTerminal,
    }),
  );
  const fontSize = useClientSettings((settings) =>
    resolveTerminalFontSizePreference({
      advanced: advancedTypography,
      code: settings.fontSizeCode,
      terminal: settings.fontSizeTerminal,
    }),
  );
  const mountRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<GhosttyTerminalSurface | null>(null);
  const stateRef = useRef<ProjectTerminalViewState>(initialProjectTerminalView(handle));
  const [view, setView] = useState<ViewerPhase>(() => initialProjectTerminalView(handle));
  const [streamError, setStreamError] = useState<string | null>(null);
  const [inputEnabled, setInputEnabled] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const fontRef = useRef({ family: fontFamily, size: fontSize });

  const terminal = effectiveProjectTerminal(view.terminal, summary);
  const live = isProjectTerminalViewLive(view, terminal);
  const writable = canWrite && inputEnabled && live;
  const attachAtom = projectTerminalEnvironment.attach({ environmentId, input: handle });

  // A reconnect marker means this reader missed output; reattaching yields a fresh snapshot.
  useEffect(() => {
    if (view.phase === "reconnecting") registry.refresh(attachAtom);
  }, [view.phase, attachAtom, registry]);

  useStreamEvents(
    attachAtom,
    (event) => {
      const previous = stateRef.current;
      const next = applyProjectTerminalAttachEvent(previous, event);
      if (next === previous) return;
      stateRef.current = next;
      setStreamError(null);
      const surface = surfaceRef.current;
      if (surface && next.lastWrite) {
        if (next.lastWrite.type === "reset") surface.resetAndWrite(next.lastWrite.data);
        else surface.write(next.lastWrite.data);
      }
      // Output alone never re-renders React; only state the header shows does.
      if (
        next.phase !== previous.phase ||
        next.terminal !== previous.terminal ||
        next.trimmed !== previous.trimmed ||
        next.cols !== previous.cols ||
        next.rows !== previous.rows
      )
        setView(next);
    },
    setStreamError,
  );

  const writeData = useEffectEvent((data: string) => {
    const terminal = stateRef.current.terminal;
    if (!writable || terminal === null) return;
    void projectTerminalEnvironment.write
      .run(registry, {
        environmentId,
        input: { ...handle, data, expectedGeneration: terminal.generation },
      })
      .then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
          setNotice(describeProjectTerminalFailure(squashAtomCommandFailure(result)));
      });
  });

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let cancelled = false;
    let surface: GhosttyTerminalSurface | null = null;
    const themeObserver = new MutationObserver(() =>
      surfaceRef.current?.setTheme(terminalThemeFromApp(mount)),
    );
    void GhosttyTerminalSurface.create(mount, {
      theme: terminalThemeFromApp(mount),
      font: fontOptions(fontRef.current.family, fontRef.current.size),
      onData: (data) => writeData(data),
      // The grid follows this window only when the user asks; observers never resize a shared PTY.
      onResize: () => undefined,
      onSelectionChange: () => undefined,
      beforeKey: () => true,
      onLinkActivate: (text) => void readLocalApi()?.shell.openExternal(text),
      canActivateLink: (text) => /^https?:\/\//.test(text),
    }).then((created) => {
      if (cancelled) {
        created.dispose();
        return;
      }
      surface = created;
      surfaceRef.current = created;
      created.input.readOnly = true;
      created.resetAndWrite(stateRef.current.history);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    });
    return () => {
      cancelled = true;
      themeObserver.disconnect();
      surface?.dispose();
      surfaceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (surfaceRef.current) surfaceRef.current.input.readOnly = !writable;
  }, [writable]);

  useEffect(() => {
    const current = fontRef.current;
    if (current.family === fontFamily && current.size === fontSize) return;
    fontRef.current = { family: fontFamily, size: fontSize };
    void surfaceRef.current?.setFont(fontOptions(fontFamily, fontSize));
  }, [fontFamily, fontSize]);

  const matchWindow = async () => {
    const surface = surfaceRef.current;
    const terminal = stateRef.current.terminal;
    if (!surface || terminal === null) return;
    const result = await projectTerminalEnvironment.resize.run(registry, {
      environmentId,
      input: {
        ...handle,
        cols: surface.cols,
        rows: surface.rows,
        expectedGeneration: terminal.generation,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setNotice(describeProjectTerminalFailure(squashAtomCommandFailure(result)));
  };

  const stop = async () => {
    const terminal = stateRef.current.terminal;
    if (terminal === null) return;
    const confirmed = await readLocalApi()?.dialogs.confirm(
      `Stop "${terminal.label || terminal.terminalId}"?\nThis ends the process for everyone using it, including the agent that started it.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setStopping(true);
    const result = await projectTerminalEnvironment.kill.run(registry, {
      environmentId,
      input: { ...handle, expectedGeneration: terminal.generation },
    });
    setStopping(false);
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
  };

  return (
    <section
      aria-label={`Terminal ${terminal.label || terminal.terminalId}`}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="min-w-0 truncate text-sm font-medium">
          {terminal.label || terminal.terminalId}
        </span>
        <Badge
          size="sm"
          variant={
            isProjectTerminalRunning(terminal.status)
              ? "success"
              : terminal.status === "unknown"
                ? "warning"
                : "secondary"
          }
        >
          {projectTerminalStatusLabel(terminal)}
        </Badge>
        <span className="text-xs text-muted-foreground">
          Generation {terminal.generation.slice(0, 8)}
          {view.cols !== null && view.rows !== null ? ` · ${view.cols}×${view.rows}` : ""}
        </span>
        {view.phase === "attaching" || view.phase === "reconnecting" ? (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <Spinner className="size-3" />
            {view.phase === "attaching" ? "Attaching…" : "Reconnecting; output may have a gap"}
          </span>
        ) : null}
        {view.phase === "closed" ? (
          <span className="text-xs text-muted-foreground">This terminal was removed.</span>
        ) : null}
        <div className="ms-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              size="sm"
              checked={inputEnabled}
              disabled={!canWrite || !live}
              onCheckedChange={setInputEnabled}
            />
            Allow typing
          </label>
          <Button
            size="xs"
            variant="ghost"
            disabled={!canResize || !live}
            onClick={() => void matchWindow()}
          >
            Fit to this window
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={!canStop || stopping || !isProjectTerminalRunning(terminal.status)}
            onClick={() => void stop()}
          >
            {stopping ? <Spinner className="size-3" /> : null}
            Stop
          </Button>
        </div>
      </div>
      {streamError !== null || notice !== null || view.trimmed ? (
        <div className="space-y-1 border-b border-border/60 px-3 py-2 text-xs">
          {streamError !== null ? (
            <p role="alert" className="text-destructive-foreground">
              {streamError}
            </p>
          ) : null}
          {notice !== null ? (
            <p role="status" className="text-muted-foreground">
              {notice}
            </p>
          ) : null}
          {view.trimmed ? (
            <p className="text-muted-foreground">
              Earlier output is no longer kept; showing the most recent output.
            </p>
          ) : null}
        </div>
      ) : null}
      <div
        ref={mountRef}
        className="min-h-80 flex-1 bg-(--terminal-background,var(--background))"
      />
    </section>
  );
}
