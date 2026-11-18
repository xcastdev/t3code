import { createContext, useContext, type ReactNode } from "react";
import { Platform, Pressable, View, type LayoutChangeEvent } from "react-native";
import Animated from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { MOBILE_SHAPE } from "../../lib/designTokens";
import { useReduceMotionEnabled } from "../../lib/appState";
import { ContextRing } from "./ContextRing";
import type { ThreadDetailsSectionId } from "./threadLiveDetails.logic";

export interface ThreadDetailsCollapse {
  readonly isCollapsed: (id: ThreadDetailsSectionId) => boolean;
  readonly toggle: (id: ThreadDetailsSectionId) => void;
}

export const ThreadDetailsCollapseContext = createContext<ThreadDetailsCollapse>({
  isCollapsed: () => false,
  toggle: () => undefined,
});

/**
 * A titled group that folds to its heading. Collapsed, the heading shows `summary` (or
 * `actions` when there is none), the figure worth seeing without opening it.
 */
export function LiveSection(props: {
  readonly id: ThreadDetailsSectionId;
  readonly title: string;
  readonly summary?: ReactNode;
  readonly actions?: ReactNode;
  readonly footer?: string | undefined;
  readonly onLayout?: ((event: LayoutChangeEvent) => void) | undefined;
  readonly children: ReactNode;
}) {
  const { isCollapsed, toggle } = useContext(ThreadDetailsCollapseContext);
  const reduceMotion = useReduceMotionEnabled();
  const collapsed = isCollapsed(props.id);
  const trailing = collapsed ? (props.summary ?? props.actions) : props.actions;
  return (
    <View onLayout={props.onLayout} className="gap-1.5">
      <View className="min-h-11 flex-row items-center justify-between gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.title}
          accessibilityState={{ expanded: !collapsed }}
          hitSlop={4}
          onPress={() => toggle(props.id)}
          className={
            Platform.OS === "android"
              ? "min-h-11 min-w-0 shrink flex-row items-center gap-1 px-4 active:opacity-60"
              : "min-h-11 min-w-0 shrink flex-row items-center gap-1 px-2 active:opacity-60"
          }
        >
          <Text textRole="footnote" className="shrink font-t3-medium text-foreground-muted">
            {props.title}
          </Text>
          <Animated.View
            style={{
              transform: [{ rotate: collapsed ? "0deg" : "90deg" }],
              transitionProperty: "transform",
              transitionDuration: reduceMotion ? 0 : 150,
            }}
          >
            <SymbolView
              name="chevron.right"
              size={11}
              tintColorClassName="accent-icon-subtle"
              type="monochrome"
              weight="semibold"
            />
          </Animated.View>
        </Pressable>
        {trailing ? (
          <View className="min-w-0 shrink flex-row items-center justify-end gap-2 pr-2">
            {typeof trailing === "string" ? <SummaryText>{trailing}</SummaryText> : trailing}
          </View>
        ) : null}
      </View>
      {collapsed ? null : (
        <>
          <View
            className="overflow-hidden border-continuous bg-grouped-card"
            style={{
              borderRadius:
                Platform.OS === "android" ? MOBILE_SHAPE.group.android : MOBILE_SHAPE.group.ios,
            }}
          >
            {props.children}
          </View>
          {props.footer ? (
            <Text textRole="footnote" className="px-4 pt-0.5 text-foreground-muted">
              {props.footer}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

export function SummaryText(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <Text
      textRole="footnote"
      numberOfLines={1}
      className={props.className ?? "shrink tabular-nums text-foreground-muted"}
    >
      {props.children}
    </Text>
  );
}

/** A small gauge with its percentage in the middle, for collapsed summaries. */
export function SummaryRing(props: {
  readonly percent: number;
  readonly label: string;
  readonly color?: string | null;
  readonly dangerAt?: number;
}) {
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={props.label}
      className="size-6 items-center justify-center"
    >
      <View className="absolute inset-0">
        <ContextRing
          percent={props.percent}
          size={24}
          stroke={2.5}
          color={props.color ?? null}
          {...(props.dangerAt === undefined ? {} : { dangerAt: props.dangerAt })}
        />
      </View>
      <Text className="text-[8px] font-t3-semibold leading-none text-foreground">
        {props.percent}
      </Text>
    </View>
  );
}

/** Running, waiting, failed and finished agents or chats as colored counts. */
export function StatusBadges(props: {
  readonly running: number;
  readonly input?: number;
  readonly failed?: number;
  readonly done?: number;
}) {
  const input = props.input ?? 0;
  const failed = props.failed ?? 0;
  const done = props.done ?? 0;
  if (props.running === 0 && input === 0 && failed === 0 && done === 0) return null;
  return (
    <View className="flex-row items-center gap-2.5">
      {props.running > 0 ? (
        <View
          accessible
          accessibilityLabel={`${props.running} running`}
          className="flex-row items-center gap-1"
        >
          <View className="size-1.5 rounded-full bg-adaptive-blue-500-400" />
          <SummaryText className="font-t3-medium tabular-nums text-adaptive-blue-500-400">
            {props.running}
          </SummaryText>
        </View>
      ) : null}
      {input > 0 ? (
        <Badge
          icon="questionmark.bubble"
          tint="accent-warning-foreground"
          text="text-warning-foreground"
          count={input}
          label={`${input} waiting for input`}
        />
      ) : null}
      {failed > 0 ? (
        <Badge
          icon="xmark"
          tint="accent-danger-foreground"
          text="text-danger-foreground"
          count={failed}
          label={`${failed} failed`}
        />
      ) : null}
      {done > 0 ? (
        <Badge
          icon="checkmark"
          tint="accent-foreground-muted"
          text="text-foreground-muted"
          count={done}
          label={`${done} done`}
        />
      ) : null}
    </View>
  );
}

function Badge(props: {
  readonly icon: "questionmark.bubble" | "xmark" | "checkmark";
  readonly tint: string;
  readonly text: string;
  readonly count: number;
  readonly label: string;
}) {
  return (
    <View accessible accessibilityLabel={props.label} className="flex-row items-center gap-1">
      <SymbolView
        name={props.icon}
        size={11}
        tintColorClassName={props.tint}
        type="monochrome"
        weight="semibold"
      />
      <SummaryText className={`font-t3-medium tabular-nums ${props.text}`}>
        {props.count}
      </SummaryText>
    </View>
  );
}
