import { getFiletypeFromFileName } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { type ReactNode, Suspense } from "react";

import { useRenderedAppearance } from "../../hooks/useTheme";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { cn } from "../../lib/utils";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { HighlightedTokens } from "./HighlightedTokens";
import { ShellCommandBlock } from "./ShellCommandBlock";
import { splitNumberedReadOutput, splitPathForDisplay } from "./ToolCallDetail.logic";

const MONO = "font-mono text-(length:--font-size-code,var(--text-2xs)) leading-relaxed select-text";

/** One expanded tool call: its input and output panes share a frame, split by a rule. */
export function ToolDetailCard({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-code">{children}</div>
  );
}

/**
 * A labelled pane of a tool call. "terminal" panes use the terminal's background, so a command
 * and what it printed read like a shell.
 */
export function ToolDetailPane({
  label,
  meta,
  surface = "code",
  scroll = true,
  children,
}: {
  label: "Input" | "Output";
  meta?: ReactNode;
  surface?: "code" | "terminal";
  /** Off when the content scrolls itself, like streaming command output that follows its end. */
  scroll?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="border-t border-border/70 first:border-t-0">
      <div className="flex min-h-6 items-center gap-2 border-b border-border/50 bg-muted/40 px-2.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        <span>{label}</span>
        {meta ? (
          <span className="ms-auto flex min-w-0 items-center gap-1.5 normal-case tracking-normal">
            {meta}
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          MONO,
          "px-2.5 py-2 whitespace-pre-wrap break-words text-foreground/85",
          scroll && "max-h-80 overflow-auto",
          surface === "terminal" && "bg-(--terminal-background)",
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** A command as typed at a prompt. */
export function TerminalCommand({ command }: { command: string }) {
  return (
    <div className="flex min-w-0 gap-2">
      <span aria-hidden className="shrink-0 text-success select-none">
        $
      </span>
      <div className="min-w-0 flex-1">
        <ShellCommandBlock command={command} />
      </div>
    </div>
  );
}

/** A full path with its file name standing out from the folder it lives in. */
export function ToolPath({ path }: { path: string }) {
  const { folder, name } = splitPathForDisplay(path);
  return (
    <div className="break-all">
      <span className="text-muted-foreground">{folder}</span>
      <span className="font-medium text-foreground">{name}</span>
    </div>
  );
}

/** Code highlighted for its file type; line numbers from a file read go in a gutter. */
export function ToolCode({ text, path }: { text: string; path?: string | undefined }) {
  const theme = useRenderedAppearance();
  const { code, firstLine } = splitNumberedReadOutput(text);
  const language = path ? getFiletypeFromFileName(path) : "text";
  const plain = <>{code}</>;
  const highlighted =
    language === "text" ? (
      plain
    ) : (
      <RenderErrorBoundary fallback={plain} resetKeys={[code, language]}>
        <Suspense fallback={plain}>
          <HighlightedTokens code={code} language={language} theme={theme} />
        </Suspense>
      </RenderErrorBoundary>
    );
  if (firstLine === null)
    return <pre className="whitespace-pre-wrap break-words">{highlighted}</pre>;
  const lineCount = code.split("\n").length;
  return (
    <div className="flex min-w-max">
      <pre aria-hidden className="shrink-0 pe-3 text-right text-muted-foreground/60 select-none">
        {Array.from({ length: lineCount }, (_, index) => firstLine + index).join("\n")}
      </pre>
      <pre className="whitespace-pre">{highlighted}</pre>
    </div>
  );
}

/** A change drawn as an inline diff; the card's input pane already names the file. */
export function ToolDiff({ patch, cacheKey }: { patch: string; cacheKey: string }) {
  const theme = useRenderedAppearance();
  const renderable = getRenderablePatch(patch, `tool-diff:${cacheKey}`);
  if (renderable === null) return null;
  if (renderable.kind === "raw") {
    return <pre className="whitespace-pre-wrap break-words">{renderable.text}</pre>;
  }
  return (
    <DiffWorkerPoolProvider>
      {renderable.files.map((fileDiff) => (
        <FileDiff
          key={resolveFileDiffPath(fileDiff)}
          fileDiff={fileDiff}
          options={{
            collapsed: false,
            diffStyle: "unified",
            disableFileHeader: true,
            overflow: "wrap",
            theme: resolveDiffThemeName(theme),
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
          }}
        />
      ))}
    </DiffWorkerPoolProvider>
  );
}
