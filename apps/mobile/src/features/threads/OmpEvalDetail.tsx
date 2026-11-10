import type { EnvironmentId, OrchestrationV2TurnItem } from "@t3tools/contracts";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { Button } from "../../components/ui/Button";
import { useRef, type ComponentRef } from "react";
import { ScrollView, View } from "react-native";
import { ompEvalArtifacts, type OmpEvalView } from "@t3tools/client-runtime/work-log/omp-eval";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { getMobileTerminalTheme } from "../terminal/terminalTheme";
import { useMarkdownCodeHighlight } from "./markdownCodeHighlightState";
import { AppText as Text } from "../../components/ui/AppText";

export function OmpEvalDetail(props: {
  readonly view: OmpEvalView;
  readonly item: OrchestrationV2TurnItem;
  readonly environmentId: EnvironmentId;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly hydration: "settled" | "load" | "fallback";
  readonly pending: boolean;
  readonly error: string | null;
  readonly themeAppearance: "light" | "dark";
}) {
  const { view } = props;
  const { themeId } = useAppearancePreferences();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const following = useRef(true);
  const backgroundColor = getMobileTerminalTheme(themeId, props.themeAppearance).background;
  const mono = "font-mono text-2xs leading-normal text-foreground";
  const codeLines = useMarkdownCodeHighlight({
    code: view.code,
    language: view.language,
    theme: props.themeAppearance,
    enabled: true,
  });
  let tokenOffset = 0;
  const code = codeLines?.flatMap((line, lineIndex) => [
    lineIndex > 0 ? "\n" : "",
    ...line.map((token) => {
      const key = tokenOffset;
      tokenOffset += token.content.length;
      return (
        <Text key={key} style={token.color ? { color: token.color } : undefined}>
          {token.content}
        </Text>
      );
    }),
  ]);
  return (
    <View className="overflow-hidden rounded-lg border border-border" style={{ backgroundColor }}>
      <View className="px-2.5 py-2">
        <Text className="pb-1 text-2xs text-foreground-muted">Input · {view.language}</Text>
        <Text className="pb-1 text-2xs text-foreground">{view.title}</Text>
        <ScrollView nestedScrollEnabled className="max-h-60">
          <Text selectable className={mono}>
            {code ?? (view.code || "Input unavailable.")}
          </Text>
        </ScrollView>
        {view.inputTruncated ? (
          <Text className="text-2xs text-foreground-muted">Input truncated.</Text>
        ) : null}
      </View>
      <View className="border-t border-border px-2.5 py-2">
        <Text className="pb-1 text-2xs text-foreground-muted">
          {[
            "Output",
            view.status,
            view.durationMs === undefined ? null : view.durationMs + " ms",
            view.exitCode === undefined ? null : "exit " + view.exitCode,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        {view.phase ? (
          <Text className="pb-1 text-2xs text-foreground-muted">{view.phase}</Text>
        ) : null}
        {view.logs.length ? (
          <View className="pb-2">
            <Text className="text-2xs text-foreground-muted">Execution log</Text>
            <Text selectable className="font-mono text-2xs text-foreground-muted">
              {view.logs.join("\n")}
            </Text>
          </View>
        ) : null}
        <ScrollView
          ref={scrollRef}
          nestedScrollEnabled
          className="max-h-60"
          scrollEventThrottle={100}
          onScroll={(event) => {
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
            following.current =
              contentSize.height - contentOffset.y - layoutMeasurement.height <= 8;
          }}
          onContentSizeChange={() => {
            if (following.current) scrollRef.current?.scrollToEnd({ animated: false });
          }}
        >
          <Text selectable className={mono}>
            {view.stdout ||
              (!view.outputAvailable
                ? "Output not included in this preview."
                : view.status === "running"
                  ? "Waiting for output…"
                  : "No output.")}
          </Text>
        </ScrollView>
        {view.replies.length || view.repliesOmitted ? (
          <View className="pt-2">
            <Text className="pb-1 text-2xs text-foreground-muted">Replies</Text>
            <ScrollView nestedScrollEnabled className="max-h-60">
              <Text selectable className={mono}>
                {view.replies.join("\n\n")}
              </Text>
            </ScrollView>
            {view.repliesOmitted ? (
              <Text className="text-2xs text-foreground-muted">Replies truncated.</Text>
            ) : null}
          </View>
        ) : null}
        {view.fallbackOutput ? (
          <View className="pt-1">
            <Text className="text-2xs text-foreground-muted">Historical output</Text>
            <ScrollView nestedScrollEnabled className="max-h-60">
              <Text selectable className={mono}>
                {view.fallbackOutput}
              </Text>
            </ScrollView>
          </View>
        ) : null}
        {view.outputTruncated ? (
          <Text className="text-2xs text-foreground-muted">Output truncated.</Text>
        ) : null}
        {ompEvalArtifacts(props.item, view.artifacts).map((artifact) => {
          const resource = artifact.resource;
          return (
            <View key={artifact.key} className="pt-1">
              {resource ? (
                <Button
                  label={"Open " + artifact.label}
                  tone="text"
                  onPress={() =>
                    props.onPressPreview({
                      kind: "document",
                      name: artifact.name,
                      mimeType: "text/plain",
                      environmentId: props.environmentId,
                      resource,
                    })
                  }
                />
              ) : (
                <Text className="text-2xs text-foreground-muted">
                  {artifact.label}: native artifact access is unavailable.
                </Text>
              )}
            </View>
          );
        })}
        {view.outputTruncated && !view.artifacts.length && props.hydration !== "load" ? (
          <Text className="pt-1 text-2xs text-foreground-muted">Full output is unavailable.</Text>
        ) : null}
        {props.error ? (
          <Text className="pt-1 text-2xs text-danger-foreground">
            Couldn’t load full output: {props.error}
          </Text>
        ) : props.hydration === "load" ? (
          <Text className="pt-1 text-2xs text-foreground-muted">
            {props.pending
              ? "Loading full output…"
              : "Showing latest output preview; full output is not available yet."}
          </Text>
        ) : props.hydration === "fallback" ? (
          <Text className="pt-1 text-2xs text-foreground-muted">
            Full output is unavailable for this historical item.
          </Text>
        ) : null}
      </View>
    </View>
  );
}
