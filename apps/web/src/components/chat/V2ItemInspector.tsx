import { T, Var, useGT } from "gt-react";
import { mergeOmpEvalDetail } from "@t3tools/client-runtime/work-log/omp-eval";
import { OmpEvalDetail } from "./OmpEvalDetail";
import type { ToolCallDiffTarget } from "../../diffPanelStore";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isJsonToolText,
  toolCallLines,
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
  turnItemOutputImages,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { isJavaScriptReplTool } from "@t3tools/shared/toolActivity";
import { ExternalLinkIcon } from "lucide-react";
import { memo, type ReactNode, Suspense, use, useState } from "react";

import { canOpenLinksInApp, resolveLinkTarget } from "../../browser/browserLinkTarget";
import { useOpenLink } from "../../browser/useOpenLink";
import { useClientSettings } from "../../hooks/useSettings";
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
import { FileSearchResults } from "./FileSearchResults";
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
import { useInitialOutputReady, type TurnItemSource } from "./timelineRowContext";

interface V2ItemInspectorProps {
  readonly onInitialOutputReady?: (() => void) | undefined;
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
  readonly language: "json" | "typescript" | "html";
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

function StructuredValue({
  value,
  highlightJson = false,
  language,
  bare = false,
}: {
  readonly value: unknown;
  readonly highlightJson?: boolean;
  readonly language?: "typescript" | "html" | "json";
  /** Inside a tool pane, which already scrolls and sets the type. */
  readonly bare?: boolean;
}) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const isJson = highlightJson && isJsonToolText(text);
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
  const gt = useGT();
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
  const [retainedOmpDetail, setRetainedOmpDetail] = useState<typeof fetchedItem>();
  const ompEval = mergeOmpEvalDetail(wireItem, fetchedItem, retainedOmpDetail);
  if (ompEval?.detailItem && ompEval.detailItem !== retainedOmpDetail) {
    setRetainedOmpDetail(ompEval.detailItem);
  }
  const item = ompEval?.item ?? (fetchedItem?.type === wireItem.type ? fetchedItem : wireItem);
  return {
    item,
    ompEval,
    output: {
      output: ompEval ? null : turnItemOutputText(item),
      images: ompEval ? [] : turnItemOutputImages(item),
      environmentId,
      pending: ompEval ? fetches && detail.isPending : item === wireItem && detail.isPending,
      error: ompEval
        ? (detail.error ??
          (fetches && detail.data?.item === null ? gt("Output is no longer available.") : null))
        : item !== wireItem
          ? null
          : detail.data?.item === null
            ? gt("Output is no longer available.")
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

// A screenshot-style result is only images; they lead the card instead of trailing the input.
const isImageOnlyOutput = (state: ToolOutputState) =>
  state.images.length > 0 && !state.output?.trim() && !state.error;

function ToolOutputImages(props: ToolOutputState) {
  const gt = useGT();
  return props.images.map((resource) => (
    <ChatMarkdownAssetImage
      key={resource.index}
      environmentId={props.environmentId}
      resource={resource}
      alt={gt("Tool output image")}
      maxHeightRem={16}
      onImageExpand={props.onImageExpand}
    />
  ));
}

function ToolOutput(props: ToolOutputState & { readonly codePath?: string | undefined }) {
  const images = <ToolOutputImages {...props} />;
  const text = props.output ? (
    props.codePath ? (
      <ToolCode text={props.output} path={props.codePath} />
    ) : isJsonToolText(props.output) ? (
      <StructuredValue value={props.output} highlightJson bare />
    ) : (
      <div className="whitespace-pre-wrap break-words">{props.output}</div>
    )
  ) : props.pending ? (
    <div className="font-sans text-muted-foreground italic">
      <T>Loading output…</T>
    </div>
  ) : props.error ? (
    <div className="font-sans text-destructive">
      <T>
        Couldn&apos;t load output: <Var>{props.error}</Var>
      </T>
    </div>
  ) : props.images.length === 0 ? (
    <div className="font-sans text-muted-foreground italic">
      <T>No output.</T>
    </div>
  ) : null;
  return (
    <div className="space-y-1.5">
      {images}
      {text}
    </div>
  );
}

/** Providers can repeat a search result, so identical entries get their occurrence in the key. */
function keyedByOccurrence<T>(values: ReadonlyArray<T>) {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const identity = JSON.stringify(value);
    const occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);
    return { key: `${identity}#${occurrence}`, value };
  });
}

/**
 * A tool call whose input the row already knows, such as the files a read opened, with the
 * output fetched from the environment. A read's output highlights for its file's type.
 */
export function FetchedToolDetail(props: {
  readonly onInitialOutputReady?: (() => void) | undefined;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly input: ReactNode;
  readonly codePath?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  readonly source?: TurnItemSource | undefined;
}) {
  const gt = useGT();
  const { output } = useFetchedTurnItem(props.projectedItem, props.environmentId, props.source);
  useInitialOutputReady(output.pending, props.onInitialOutputReady);
  const imageOnly = isImageOnlyOutput(output);
  return (
    <ToolDetailCard>
      {imageOnly ? (
        <ToolDetailPane label={gt("Output", { $context: "tool detail pane heading" })}>
          <ToolOutputImages {...output} onImageExpand={props.onImageExpand} />
        </ToolDetailPane>
      ) : null}
      {props.input ? (
        <ToolDetailPane label={gt("Input", { $context: "tool detail pane heading" })}>
          {props.input}
        </ToolDetailPane>
      ) : null}
      {imageOnly ? null : (
        <ToolDetailPane label={gt("Output", { $context: "tool detail pane heading" })}>
          <ToolOutput {...output} codePath={props.codePath} onImageExpand={props.onImageExpand} />
        </ToolDetailPane>
      )}
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

function WebSearchResultLink(props: {
  readonly href: string;
  readonly threadRef: ScopedThreadRef;
  readonly children: ReactNode;
}) {
  const openLink = useOpenLink(props.threadRef);
  // Subscribe so the synchronous _blank decision sees hydrated settings, as ChatMarkdown does.
  const linkTargetPreference = useClientSettings((settings) => settings.browserLinkTarget);
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
      onClick={(event) => {
        if (
          resolveLinkTarget({
            url: props.href,
            event,
            preference: linkTargetPreference,
            canOpenInApp: canOpenLinksInApp(props.threadRef),
          }) !== "app"
        ) {
          return;
        }
        event.preventDefault();
        void openLink(props.href, { event }).catch(console.error);
      }}
    >
      {props.children}
      <ExternalLinkIcon className="size-3" />
    </a>
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
  const gt = useGT();
  const call = toolCallLines({ command: props.command, args: props.args });
  const filePath = call.args ? toolArgsFilePath(call.args) : null;
  const terminal = call.command !== null;
  const imageOnly = props.outputSlot === undefined && isImageOnlyOutput(props);
  return (
    <ToolDetailCard>
      {imageOnly ? (
        <ToolDetailPane label={gt("Output", { $context: "tool detail pane heading" })}>
          <ToolOutputImages {...props} />
        </ToolDetailPane>
      ) : null}
      {call.command ? (
        <ToolDetailPane
          label={gt("Input", { $context: "tool detail pane heading" })}
          surface="terminal"
        >
          <TerminalCommand command={call.command} />
        </ToolDetailPane>
      ) : null}
      {call.args ? (
        <ToolDetailPane label={gt("Input", { $context: "tool detail pane heading" })}>
          <dl className="space-y-1.5">
            {call.args.map(([key, value]) => (
              <div key={key}>
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="min-w-0">
                  {key === "html" ? (
                    <StructuredValue value={value} language="html" bare />
                  ) : key === "code" && isJavaScriptReplTool(props.toolName) ? (
                    <StructuredValue value={value} language="typescript" bare />
                  ) : filePath && isFileContentArg(key) ? (
                    <ToolCode text={value} path={filePath} />
                  ) : isFilePathArg(key) ? (
                    <ToolPath path={value} />
                  ) : isJsonToolText(value) ? (
                    <StructuredValue value={value} language="json" bare />
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
        <ToolDetailPane label={gt("Input", { $context: "tool detail pane heading" })}>
          <StructuredValue value={call.argsText} highlightJson bare />
        </ToolDetailPane>
      ) : null}
      {imageOnly ? null : (
        <ToolDetailPane
          label={gt("Output", { $context: "tool detail pane heading" })}
          surface={terminal ? "terminal" : "code"}
          scroll={props.outputSlot === undefined}
          meta={
            props.exitCode === undefined ? undefined : (
              <span className={props.exitCode === 0 ? undefined : "text-destructive"}>
                <T>
                  exit <Var>{props.exitCode}</Var>
                </T>
              </span>
            )
          }
        >
          {props.outputSlot ?? <ToolOutput {...props} />}
        </ToolDetailPane>
      )}
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
  const gt = useGT();
  const patch = fileChangePatch(item);
  const message = patch === null ? item.diffStr?.trim() : undefined;
  if (patch === null && !message && !pending) return null;
  return (
    <ToolDetailPane
      label={gt("Output", { $context: "tool detail pane heading" })}
      scroll={patch === null}
    >
      {patch ? (
        <div className="max-h-96 overflow-auto font-sans">
          <ToolDiff patch={patch} cacheKey={cacheKey} />
        </div>
      ) : message ? (
        message
      ) : (
        <div className="font-sans text-muted-foreground italic">
          <T>Loading diff…</T>
        </div>
      )}
    </ToolDetailPane>
  );
}

export const V2ItemInspector = memo(function V2ItemInspector(props: V2ItemInspectorProps) {
  const gt = useGT();
  // Command rows stream their output, including the final output, from the server.
  const environmentStreamsOutput = useCommandOutputStreaming(props.environmentId);
  const streamsOutput =
    (props.source === undefined
      ? environmentStreamsOutput
      : props.source.commandOutput !== undefined) &&
    props.projectedItem.item.type === "command_execution";
  const fetched = useFetchedTurnItem(
    props.projectedItem,
    props.environmentId,
    props.source,
    streamsOutput,
  );
  const item = fetched.item;
  const outputState = fetched.output;
  useInitialOutputReady(streamsOutput || outputState.pending, props.onInitialOutputReady);
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
                onInitialOutputReady={props.onInitialOutputReady}
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
            label={gt("Input", { $context: "tool detail pane heading" })}
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
                    <T>Open diff</T>
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
            <ToolDetailPane label={gt("Input", { $context: "tool detail pane heading" })}>
              {item.pattern}
            </ToolDetailPane>
          ) : null}
          <ToolDetailPane label={gt("Output", { $context: "tool detail pane heading" })}>
            {item.results?.length ? (
              <FileSearchResults
                pattern={item.pattern}
                results={item.results}
                workspaceRoot={props.workspaceRoot}
              />
            ) : (
              <div className="font-sans text-muted-foreground italic">
                <T>No matches.</T>
              </div>
            )}
          </ToolDetailPane>
        </ToolDetailCard>
      ) : null}

      {item.type === "web_search" ? (
        <ToolDetailCard>
          {item.patterns?.length ? (
            <ToolDetailPane label={gt("Input", { $context: "tool detail pane heading" })}>
              {item.patterns.join("\n")}
            </ToolDetailPane>
          ) : null}
          <ToolDetailPane label={gt("Output", { $context: "tool detail pane heading" })}>
            {item.results?.length ? (
              <ul className="space-y-1.5 font-sans">
                {keyedByOccurrence(item.results).map(({ key, value: result }) => {
                  const safeHref = resolveExternalWebLinkHref(result.url);
                  return (
                    <li key={key}>
                      {safeHref ? (
                        <WebSearchResultLink
                          href={safeHref}
                          threadRef={{
                            environmentId: props.environmentId,
                            threadId: props.projectedItem.sourceThreadId,
                          }}
                        >
                          {result.title ?? result.url}
                        </WebSearchResultLink>
                      ) : (
                        <p className="font-medium text-foreground">
                          {result.title ?? result.url ?? gt("Search result")}
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
              <div className="font-sans text-muted-foreground italic">
                <T>No results.</T>
              </div>
            )}
          </ToolDetailPane>
        </ToolDetailCard>
      ) : null}

      {fetched.ompEval ? (
        <OmpEvalDetail
          view={fetched.ompEval.view}
          item={item}
          environmentId={props.environmentId}
          hydration={fetched.ompEval.hydration}
          pending={outputState.pending}
          error={outputState.error}
          onImageExpand={props.onImageExpand}
        />
      ) : item.type === "dynamic_tool" ? (
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
