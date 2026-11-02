import type { ToolCallDiffTarget } from "../../diffPanelStore";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import {
  toolCallLines,
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
  turnItemOutputImages,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { isJavaScriptReplTool } from "@t3tools/shared/toolActivity";
import { ExternalLinkIcon } from "lucide-react";
import { memo, type ReactNode, Suspense, use } from "react";

import { useRenderedAppearance } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { useTurnItemDetail } from "../../state/queries";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { Button } from "../ui/button";
import ChatMarkdown from "../ChatMarkdown";
import { ChatMarkdownAssetImage } from "./ChatMarkdownMedia";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { CommandOutputPanel, useCommandOutputStreaming } from "./CommandOutputPanel";
import { resolveExternalWebLinkHref } from "./externalLinkContextMenu";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  TerminalCommand,
  ToolCode,
  ToolDiff,
  ToolDetailCard,
  ToolDetailPane,
  ToolPath,
} from "./ToolCallDetail";
import {
  fileChangePatch,
  isFileContentArg,
  isFilePathArg,
  toolArgsFilePath,
} from "./ToolCallDetail.logic";
import type { TurnItemSource } from "./timelineRowContext";

interface V2ItemInspectorProps {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly cwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly onOpenToolDiff?: ((target: ToolCallDiffTarget) => void) | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  readonly source?: TurnItemSource | undefined;
}

function SyntaxTokens({
  text,
  language,
}: {
  readonly text: string;
  readonly language: "json" | "typescript";
}) {
  const resolvedTheme = useRenderedAppearance();
  const highlighter = use(getSyntaxHighlighterPromise(language));
  const { tokens } = highlighter.codeToTokens(text, {
    lang: language,
    theme: resolveDiffThemeName(resolvedTheme),
  });
  return tokens.flatMap((line, lineIndex) => [
    lineIndex > 0 ? "\n" : "",
    ...line.map((token) => (
      <span key={token.offset} style={{ color: token.color }}>
        {token.content}
      </span>
    )),
  ]);
}

const monoClassName =
  "font-mono text-(length:--font-size-code,var(--text-2xs)) leading-relaxed whitespace-pre-wrap break-words select-text";

function isJsonText(text: string): boolean {
  if (!text) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function StructuredValue({
  value,
  highlightJson = false,
  language,
  bare = false,
}: {
  readonly value: unknown;
  readonly highlightJson?: boolean;
  readonly language?: "typescript";
  /** Inside a tool pane, which already scrolls and sets the type. */
  readonly bare?: boolean;
}) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const isJson = highlightJson && isJsonText(text);
  if (!text) return null;
  return (
    <pre
      className={
        bare
          ? "whitespace-pre-wrap break-words"
          : cn("max-h-80 overflow-auto text-muted-foreground", monoClassName)
      }
    >
      {language || isJson ? (
        <RenderErrorBoundary fallback={text}>
          <Suspense fallback={text}>
            <SyntaxTokens text={text} language={language ?? "json"} />
          </Suspense>
        </RenderErrorBoundary>
      ) : (
        text
      )}
    </pre>
  );
}

function useFetchedTurnItem(
  projectedItem: OrchestrationV2ProjectedTurnItem,
  environmentId: EnvironmentId,
  source: TurnItemSource | undefined,
  skip = false,
) {
  const wireItem = projectedItem.item;
  // The wire leaves out file change diffs; an opened edit fetches its diff to show it inline.
  const fetches = !skip && (turnItemNeedsDetailFetch(wireItem) || wireItem.type === "file_change");
  const detail = useTurnItemDetail(
    fetches
      ? {
          environmentId,
          threadId: projectedItem.sourceThreadId,
          itemId: projectedItem.sourceItemId,
          revision: turnItemDetailRevision(wireItem),
        }
      : null,
    source?.detail,
  );
  const fetchedItem = detail.data?.item;
  const item = fetchedItem?.type === wireItem.type ? fetchedItem : wireItem;
  return {
    item,
    output: {
      output: turnItemOutputText(item),
      images: turnItemOutputImages(item),
      environmentId,
      pending: item === wireItem && detail.isPending,
      error:
        item !== wireItem
          ? null
          : detail.data?.item === null
            ? "Output is no longer available."
            : detail.error,
      empty: fetches && item !== wireItem,
    },
  };
}

interface ToolOutputState {
  readonly output: string | null;
  readonly images: ReturnType<typeof turnItemOutputImages>;
  readonly environmentId: EnvironmentId;
  readonly pending: boolean;
  readonly error: string | null;
  readonly empty: boolean;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

function ToolOutput(props: ToolOutputState & { readonly codePath?: string | undefined }) {
  const images = props.images.map((resource) => (
    <ChatMarkdownAssetImage
      key={resource.index}
      environmentId={props.environmentId}
      resource={resource}
      alt="Tool output image"
      maxHeightRem={16}
      onImageExpand={props.onImageExpand}
    />
  ));
  const text = props.output ? (
    props.codePath ? (
      <ToolCode text={props.output} path={props.codePath} />
    ) : isJsonText(props.output) ? (
      <StructuredValue value={props.output} highlightJson bare />
    ) : (
      <div className="whitespace-pre-wrap break-words">{props.output}</div>
    )
  ) : props.pending ? (
    <div className="font-sans text-muted-foreground italic">Loading output…</div>
  ) : props.error ? (
    <div className="font-sans text-destructive">Couldn&apos;t load output: {props.error}</div>
  ) : images.length === 0 ? (
    <div className="font-sans text-muted-foreground italic">No output.</div>
  ) : null;
  return (
    <div className="space-y-1.5">
      {images}
      {text}
    </div>
  );
}

/**
 * A tool call whose input the row already knows, such as the files a read opened, with the
 * output fetched from the environment. A read's output highlights for its file's type.
 */
export function FetchedToolDetail(props: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly input: ReactNode;
  readonly codePath?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  readonly source?: TurnItemSource | undefined;
}) {
  const { output } = useFetchedTurnItem(props.projectedItem, props.environmentId, props.source);
  return (
    <ToolDetailCard>
      {props.input ? <ToolDetailPane label="Input">{props.input}</ToolDetailPane> : null}
      <ToolDetailPane label="Output">
        <ToolOutput {...output} codePath={props.codePath} onImageExpand={props.onImageExpand} />
      </ToolDetailPane>
    </ToolDetailCard>
  );
}

/** Every path a read opened, in full. */
export function ToolPaths({ paths }: { readonly paths: ReadonlyArray<string> }) {
  return (
    <div className="space-y-0.5">
      {paths.map((path) => (
        <ToolPath key={path} path={path} />
      ))}
    </div>
  );
}

function ToolCallBody(
  props: ToolOutputState & {
    readonly command?: string;
    readonly args?: unknown;
    readonly toolName?: string | null;
    readonly exitCode?: number | undefined;
    /** Replaces fetched output. */
    readonly outputSlot?: ReactNode;
  },
) {
  const call = toolCallLines({ command: props.command, args: props.args });
  const filePath = call.args ? toolArgsFilePath(call.args) : null;
  const terminal = call.command !== null;
  return (
    <ToolDetailCard>
      {call.command ? (
        <ToolDetailPane label="Input" surface="terminal">
          <TerminalCommand command={call.command} />
        </ToolDetailPane>
      ) : null}
      {call.args ? (
        <ToolDetailPane label="Input">
          <dl className="space-y-1.5">
            {call.args.map(([key, value]) => (
              <div key={key}>
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="min-w-0">
                  {key === "code" && isJavaScriptReplTool(props.toolName) ? (
                    <StructuredValue value={value} language="typescript" bare />
                  ) : filePath && isFileContentArg(key) ? (
                    <ToolCode text={value} path={filePath} />
                  ) : isFilePathArg(key) ? (
                    <ToolPath path={value} />
                  ) : (
                    <div className="whitespace-pre-wrap break-words">{value}</div>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </ToolDetailPane>
      ) : null}
      {call.argsText ? (
        <ToolDetailPane label="Input">
          <StructuredValue value={call.argsText} highlightJson bare />
        </ToolDetailPane>
      ) : null}
      <ToolDetailPane
        label="Output"
        surface={terminal ? "terminal" : "code"}
        scroll={props.outputSlot === undefined}
        meta={
          props.exitCode === undefined ? undefined : (
            <span className={props.exitCode === 0 ? undefined : "text-destructive"}>
              exit {props.exitCode}
            </span>
          )
        }
      >
        {props.outputSlot ?? <ToolOutput {...props} />}
      </ToolDetailPane>
    </ToolDetailCard>
  );
}

function FileChangeOutput({
  item,
  pending,
  cacheKey,
}: {
  readonly item: Extract<OrchestrationV2ProjectedTurnItem["item"], { type: "file_change" }>;
  readonly pending: boolean;
  readonly cacheKey: string;
}) {
  const patch = fileChangePatch(item);
  const message = patch === null ? item.diffStr?.trim() : undefined;
  if (patch === null && !message && !pending) return null;
  return (
    <ToolDetailPane label="Output" scroll={patch === null}>
      {patch ? (
        <div className="max-h-96 overflow-auto font-sans">
          <ToolDiff patch={patch} cacheKey={cacheKey} />
        </div>
      ) : message ? (
        message
      ) : (
        <div className="font-sans text-muted-foreground italic">Loading diff…</div>
      )}
    </ToolDetailPane>
  );
}

export const V2ItemInspector = memo(function V2ItemInspector(props: V2ItemInspectorProps) {
  // Command rows stream their output, including the final output, from the server.
  const environmentStreamsOutput = useCommandOutputStreaming(props.environmentId);
  const streamsOutput =
    (props.source !== undefined || environmentStreamsOutput) &&
    props.projectedItem.item.type === "command_execution";
  const fetched = useFetchedTurnItem(
    props.projectedItem,
    props.environmentId,
    props.source,
    streamsOutput,
  );
  const item = fetched.item;
  const outputState = fetched.output;
  return (
    <div className="space-y-2 text-xs" data-v2-item-inspector={item.type}>
      {item.type === "reasoning" && item.text ? (
        <div className="rounded-md border border-border/45 bg-muted/15 p-2 italic text-muted-foreground">
          <ChatMarkdown
            text={item.text}
            cwd={props.cwd}
            threadRef={{
              environmentId: props.environmentId,
              threadId: props.projectedItem.sourceThreadId,
            }}
            lineBreaks
          />
        </div>
      ) : null}

      {item.type === "command_execution" ? (
        <ToolCallBody
          command={item.input}
          exitCode={item.exitCode}
          {...outputState}
          onImageExpand={props.onImageExpand}
          outputSlot={
            streamsOutput ? (
              <CommandOutputPanel
                environmentId={props.environmentId}
                threadId={props.projectedItem.sourceThreadId}
                itemId={props.projectedItem.sourceItemId}
                source={props.source?.commandOutput}
              />
            ) : undefined
          }
        />
      ) : null}

      {item.type === "file_change" ? (
        <ToolDetailCard>
          <ToolDetailPane
            label="Input"
            meta={
              <>
                {item.additions !== undefined || item.deletions !== undefined ? (
                  <span className="tabular-nums">
                    <span className="text-diff-addition">
                      +{formatDiffCount(item.additions ?? 0)}
                    </span>{" "}
                    <span className="text-diff-deletion">
                      -{formatDiffCount(item.deletions ?? 0)}
                    </span>
                  </span>
                ) : null}
                {props.onOpenToolDiff ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      props.onOpenToolDiff?.({
                        threadId: props.projectedItem.sourceThreadId,
                        itemId: props.projectedItem.sourceItemId,
                        revision: turnItemDetailRevision(item),
                      })
                    }
                  >
                    Open diff
                  </Button>
                ) : null}
              </>
            }
          >
            <ToolPath path={item.fileName} />
            {item.changes !== undefined && item.changes.length > 0 ? (
              <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
                {item.changes.map((change) => (
                  <li key={JSON.stringify([change.operation, change.oldPath, change.path])}>
                    {change.operation} {change.oldPath ? `${change.oldPath} → ` : ""}
                    {formatWorkspaceRelativePath(change.path, props.workspaceRoot)}
                    {change.fileType || change.mimeType
                      ? ` (${[change.fileType, change.mimeType].filter(Boolean).join(", ")})`
                      : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </ToolDetailPane>
          <FileChangeOutput
            item={item}
            pending={outputState.pending}
            cacheKey={`${props.projectedItem.sourceThreadId}:${props.projectedItem.sourceItemId}`}
          />
        </ToolDetailCard>
      ) : null}

      {item.type === "file_search" ? (
        <ToolDetailCard>
          {item.pattern?.trim() ? (
            <ToolDetailPane label="Input">{item.pattern}</ToolDetailPane>
          ) : null}
          <ToolDetailPane label="Output">
            {item.results?.length ? (
              <ul className="space-y-1">
                {item.results.map((result) => (
                  <li key={JSON.stringify(result)}>
                    <span className="text-foreground/85">
                      {formatWorkspaceRelativePath(result.fileName, props.workspaceRoot)}
                      {result.line === undefined ? "" : `:${result.line}`}
                      {result.column === undefined ? "" : `:${result.column}`}
                    </span>
                    {result.preview ? (
                      <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                        {result.preview}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="font-sans text-muted-foreground italic">No matches.</div>
            )}
          </ToolDetailPane>
        </ToolDetailCard>
      ) : null}

      {item.type === "web_search" ? (
        <ToolDetailCard>
          {item.patterns?.length ? (
            <ToolDetailPane label="Input">{item.patterns.join("\n")}</ToolDetailPane>
          ) : null}
          <ToolDetailPane label="Output">
            {item.results?.length ? (
              <ul className="space-y-1.5 font-sans">
                {item.results.map((result) => {
                  const safeHref = resolveExternalWebLinkHref(result.url);
                  return (
                    <li key={JSON.stringify(result)}>
                      {safeHref ? (
                        <a
                          href={safeHref}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                        >
                          {result.title ?? result.url}
                          <ExternalLinkIcon className="size-3" />
                        </a>
                      ) : (
                        <p className="font-medium text-foreground">
                          {result.title ?? result.url ?? "Search result"}
                        </p>
                      )}
                      {result.snippet ? (
                        <p className="text-muted-foreground">{result.snippet}</p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="font-sans text-muted-foreground italic">No results.</div>
            )}
          </ToolDetailPane>
        </ToolDetailCard>
      ) : null}

      {item.type === "dynamic_tool" ? (
        <ToolCallBody
          toolName={item.toolName}
          args={item.input}
          {...outputState}
          onImageExpand={props.onImageExpand}
        />
      ) : null}

      {item.type === "approval_request" ? <StructuredValue value={item.prompt} /> : null}
      {item.type === "user_input_request" ? (
        <StructuredValue
          value={item.questions
            .map((question) =>
              [question.question, ...question.options.map((option) => `• ${option.label}`)].join(
                "\n",
              ),
            )
            .join("\n\n")}
        />
      ) : null}
      {item.type === "notification" ? <StructuredValue value={item.detail} /> : null}
      {item.type === "system_notice" ? <StructuredValue value={item.message} /> : null}
      {item.type === "error" ? <StructuredValue value={item.failure.message} /> : null}
      {item.type === "todo_list" ? (
        <StructuredValue
          value={item.steps
            .map(
              (step) =>
                `${step.status === "completed" ? "✓" : step.status === "running" ? "◉" : "○"} ${step.text}`,
            )
            .join("\n")}
        />
      ) : null}
    </div>
  );
});
