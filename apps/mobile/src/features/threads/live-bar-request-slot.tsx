import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Animated, { useAnimatedStyle, type DerivedValue } from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import type { LiveRequest, LiveRequestSummary } from "./live-bar-requests";

/** The pending request the live bar card shows in place of the checklist strip. */
export function LiveRequestSlot(props: {
  readonly kind: LiveRequest["kind"];
  readonly summary: LiveRequestSummary;
  readonly position: number;
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  /** Says the composer answers this request; null when it does not. */
  readonly composerHint: string | null;
  readonly bodyMaxHeight: DerivedValue<number>;
  readonly children: ReactNode;
}) {
  const bodyStyle = useAnimatedStyle(() => ({ maxHeight: props.bodyMaxHeight.value }));
  const isInput = props.kind === "user-input";
  return (
    <View className="bg-adaptive-amber-500-a10-400-a10">
      <View className="flex-row items-center gap-2.5 py-2.5 pl-3.5 pr-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.summary.label}, ${props.summary.title}`}
          accessibilityHint={props.expanded ? "Collapses the request" : "Shows the request"}
          accessibilityState={{ expanded: props.expanded }}
          onPress={props.onToggle}
          className="min-w-0 flex-1 flex-row items-center gap-2.5 active:opacity-70"
        >
          <View className="size-8 items-center justify-center rounded-full bg-adaptive-amber-500-a25-400-a25">
            <SymbolView
              name={isInput ? "text.bubble" : "exclamationmark.circle"}
              size={15}
              tintColorClassName="accent-warning-foreground"
            />
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              <Text className="font-t3-bold text-xs text-warning-foreground">
                {props.summary.label}
              </Text>
              {props.summary.kind.length > 0 ? ` · ${props.summary.kind}` : ""}
            </Text>
            <Text
              className="font-t3-medium text-sm text-foreground"
              numberOfLines={props.expanded ? 3 : 2}
            >
              {props.summary.title}
            </Text>
          </View>
        </Pressable>
        {props.count > 1 ? (
          <View className="h-8 flex-row items-center rounded-full bg-subtle">
            <PagerButton
              icon="chevron.left"
              label="Previous request"
              disabled={props.position <= 1}
              onPress={props.onPrevious}
            />
            <Text className="text-xs tabular-nums text-foreground-secondary">
              {props.position} of {props.count}
            </Text>
            <PagerButton
              icon="chevron.right"
              label="Next request"
              disabled={props.position >= props.count}
              onPress={props.onNext}
            />
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.expanded ? "Collapse request" : "Expand request"}
          onPress={props.onToggle}
          hitSlop={6}
          className="size-8 items-center justify-center active:opacity-70"
        >
          <SymbolView
            name={props.expanded ? "chevron.down" : "chevron.up"}
            size={12}
            tintColorClassName="accent-icon-subtle"
          />
        </Pressable>
      </View>
      {props.expanded ? (
        <Animated.View style={bodyStyle}>
          <ScrollView
            style={{ flexShrink: 1 }}
            contentContainerClassName="gap-2.5 px-3.5 pb-3"
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            bounces={false}
          >
            {props.children}
            {props.composerHint !== null ? (
              <View className="flex-row items-center justify-center gap-1.5 pt-0.5">
                <SymbolView name="chevron.down" size={10} tintColorClassName="accent-icon-subtle" />
                <Text className="text-xs text-foreground-muted">{props.composerHint}</Text>
              </View>
            ) : null}
          </ScrollView>
        </Animated.View>
      ) : null}
    </View>
  );
}

function PagerButton(props: {
  readonly icon: "chevron.left" | "chevron.right";
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={4}
      className={cn(
        "h-8 w-7 items-center justify-center active:opacity-70",
        props.disabled && "opacity-35",
      )}
    >
      <SymbolView name={props.icon} size={11} tintColorClassName="accent-foreground" />
    </Pressable>
  );
}
