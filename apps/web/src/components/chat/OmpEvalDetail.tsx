import { Dialog, DialogPopup, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Button } from "../ui/button";
import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import type { EnvironmentId, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { ompEvalArtifacts, type OmpEvalView } from "@t3tools/client-runtime/work-log/omp-eval";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ToolCode, ToolDetailCard, ToolDetailPane } from "./ToolCallDetail";
import { ChatMarkdownAssetImage } from "./ChatMarkdownMedia";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

function EvalOutput({ children }: { readonly children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows committed output snapshots only while the reader stays at the bottom
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  });
  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label="Program output"
      className="max-h-80 overflow-auto whitespace-pre-wrap break-words"
      onScroll={(event) => {
        const element = event.currentTarget;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
      }}
    >
      {children}
    </div>
  );
}

function EvalArtifact(props: {
  readonly artifact: ReturnType<typeof ompEvalArtifacts>[number];
  readonly environmentId: EnvironmentId;
}) {
  const { artifact, environmentId } = props;
  const threadId = artifact.resource?.threadId;
  const turnItemId = artifact.resource?.turnItemId;
  const artifactId = artifact.resource?.artifactId;
  const asset =
    threadId && turnItemId && artifactId
      ? {
          environmentId,
          resource: { _tag: "provider-output-artifact" as const, threadId, turnItemId, artifactId },
        }
      : undefined;
  if (!asset)
    return (
      <div className="font-sans text-muted-foreground">
        {artifact.label}: native artifact access is unavailable.
      </div>
    );
  return (
    <Dialog>
      <DialogTrigger render={<Button size="xs" variant="ghost-muted" />}>
        Open {artifact.label}
      </DialogTrigger>
      <DialogPopup variant="media">
        <DialogTitle>{artifact.label}</DialogTitle>
        <AttachmentFilePreview
          name={artifact.name}
          mimeType="text/plain"
          sizeBytes={0}
          asset={asset}
        />
      </DialogPopup>
    </Dialog>
  );
}

export function OmpEvalDetail(props: {
  readonly view: OmpEvalView;
  readonly item: OrchestrationV2TurnItem;
  readonly environmentId: EnvironmentId;
  readonly hydration: "settled" | "load" | "fallback";
  readonly pending: boolean;
  readonly error: string | null;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const { view } = props;
  return (
    <ToolDetailCard>
      <ToolDetailPane label="Input" surface="terminal" meta={view.language}>
        <div className="mb-1 font-sans font-medium">{view.title}</div>
        <ToolCode
          text={view.code}
          path={
            view.language === "python"
              ? "eval.py"
              : view.language === "javascript"
                ? "eval.js"
                : undefined
          }
        />
        {view.inputTruncated ? (
          <div className="font-sans text-muted-foreground">Input truncated.</div>
        ) : null}
      </ToolDetailPane>
      <ToolDetailPane
        label="Output"
        surface="terminal"
        scroll={false}
        meta={[
          view.status,
          view.durationMs === undefined ? null : view.durationMs + " ms",
          view.exitCode === undefined ? null : "exit " + view.exitCode,
        ]
          .filter(Boolean)
          .join(" · ")}
      >
        {view.phase ? (
          <div className="mb-1 font-sans text-muted-foreground">{view.phase}</div>
        ) : null}
        {view.logs.length ? (
          <details className="mb-1 text-muted-foreground">
            <summary className="cursor-pointer font-sans">Execution log</summary>
            {view.logs.join("\n")}
          </details>
        ) : null}
        <EvalOutput>
          {view.stdout || (
            <span className="font-sans text-muted-foreground italic">
              {!view.outputAvailable
                ? "Output not included in this preview."
                : view.status === "running"
                  ? "Waiting for output…"
                  : "No output."}
            </span>
          )}
          {view.images.map((image) => (
            <ChatMarkdownAssetImage
              key={image.index}
              environmentId={props.environmentId}
              resource={{
                _tag: "tool-output-image",
                threadId: props.item.threadId,
                itemId: props.item.id,
                index: image.index,
              }}
              resourceRevision={
                view.attachmentRevision === undefined ? undefined : String(view.attachmentRevision)
              }
              alt="Eval output image"
              maxHeightRem={16}
              onImageExpand={props.onImageExpand}
            />
          ))}
        </EvalOutput>
        {view.replies.length || view.repliesOmitted ? (
          <div className="mt-2">
            <div className="mb-1 font-sans text-muted-foreground">Replies</div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">
              {view.replies.join("\n\n")}
            </pre>
            {view.repliesOmitted ? (
              <div className="font-sans text-muted-foreground">Replies truncated.</div>
            ) : null}
          </div>
        ) : null}
        {view.fallbackOutput ? (
          <details className="mt-1 text-muted-foreground">
            <summary className="cursor-pointer font-sans">Historical output</summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">
              {view.fallbackOutput}
            </pre>
          </details>
        ) : null}
        {view.outputTruncated ? (
          <div className="mt-1 font-sans text-muted-foreground">Output truncated.</div>
        ) : null}
        {ompEvalArtifacts(props.item, view.artifacts).map((artifact) => (
          <div key={artifact.key} className="mt-1">
            <EvalArtifact artifact={artifact} environmentId={props.environmentId} />
          </div>
        ))}
        {view.outputTruncated && !view.artifacts.length && props.hydration !== "load" ? (
          <div className="mt-1 font-sans text-muted-foreground">Full output is unavailable.</div>
        ) : null}
        {props.error ? (
          <div className="mt-1 font-sans text-destructive">
            Couldn&apos;t load full output: {props.error}
          </div>
        ) : props.hydration === "load" ? (
          <div className="mt-1 font-sans text-muted-foreground">
            {props.pending
              ? "Loading full output…"
              : "Showing latest output preview; full output is not available yet."}
          </div>
        ) : props.hydration === "fallback" ? (
          <div className="mt-1 font-sans text-muted-foreground">
            Full output is unavailable for this historical item.
          </div>
        ) : null}
      </ToolDetailPane>
    </ToolDetailCard>
  );
}
