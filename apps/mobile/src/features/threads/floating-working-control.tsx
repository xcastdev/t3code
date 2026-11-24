import { toServerClock } from "@t3tools/client-runtime/clock";
import type { SubagentPillSegment } from "@t3tools/client-runtime/state/thread-subagents";
import type { EnvironmentId } from "@t3tools/contracts";
import { GlassView } from "expo-glass-effect";
import { useGT } from "gt-react-native";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";
import { BackHandler, type LayoutChangeEvent, Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { withUniwind } from "uniwind";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ControlPill } from "../../components/ui/ControlPill";
import { cn } from "../../lib/cn";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { BrowserPreviewButton } from "../browser/browser-preview-button";
import type { FloatingStatusAction, FloatingWorkingStatus } from "./floating-working-status";
import { ContextRing } from "./ContextRing";
import { ChecklistExpanded, ChecklistStrip } from "./live-bar-checklist";
import {
  type ChecklistPresentation,
  formatLastTurnDuration,
  formatLiveClock,
  liveBarCardTargetWidth,
  resolveScrollButtonPlacement,
  type ScrollButtonPlacement,
  type SideChatSummary,
} from "./live-bar-presentation";
import { ShimmeringWorkContent } from "./thread-work-log";
import { useVisibleSecondClock } from "./use-visible-second-clock";

const PILL_HEIGHT = 44;
const SCROLL_BUTTON_SIZE = 44;
const SCROLL_BUTTON_GAP = 8;
const BESIDE_SHIFT = (SCROLL_BUTTON_SIZE + SCROLL_BUTTON_GAP) / 2;
// Matches the composer capsule's side gutter, so an expanded card lines up with it.
const CARD_GUTTER = 12;
// The composer pads 6pt above its capsule; together they leave 8pt below the card.
const CARD_BOTTOM_GAP = 2;
/** Room the pill takes above the composer, for estimates made before it is measured. */
export const LIVE_BAR_PILL_COVERAGE = PILL_HEIGHT + CARD_BOTTOM_GAP + 6;

const CARD_TIMING = {
  duration: 260,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
const LABEL_ENTERING = FadeIn.duration(160).delay(80).reduceMotion(ReduceMotion.System);
const LABEL_EXITING = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

// Expo reapplies glass after layout or reattachment, restoring material UIKit can lose behind visible labels.
const UniwindGlassView = withUniwind(GlassView, {
  style: { fromClassName: "className" },
});

// Segment widths feed back into the card width; ignore sub-point changes to avoid rounding-driven loops.
function settleWidth(next: number) {
  return (current: number) => (Math.abs(current - next) < 1 ? current : next);
}

export type LiveBarTime =
  | {
      readonly kind: "working";
      readonly startedAtMs: number;
      readonly environmentId: EnvironmentId;
      /** A request waits on the user, so the dot turns amber. */
      readonly waiting: boolean;
    }
  | { readonly kind: "idle"; readonly durationMs: number };

interface LiveBarProps {
  readonly colorScheme: "light" | "dark";
  readonly status: FloatingWorkingStatus | null;
  readonly extensionStatus?: { readonly label: string; readonly onPress: () => void } | null;
  readonly time: LiveBarTime | null;
  readonly onOpenTurn: () => void;
  readonly agents: { readonly segment: SubagentPillSegment; readonly failed: boolean } | null;
  readonly onOpenAgents: () => void;
  readonly sideChats: SideChatSummary | null;
  readonly onOpenSideChats: () => void;
  readonly devicePreview: { readonly count: number; readonly onPress: () => void } | null;
  readonly browserPreview: { readonly count: number; readonly onPress: () => void } | null;
  readonly contextPercent: number | null;
  readonly onOpenContext: () => void;
  readonly queuedCount: number;
  readonly onOpenQueue: () => void;
  readonly checklist: ChecklistPresentation | null;
  readonly checklistExpanded: boolean;
  readonly onToggleChecklist: () => void;
  /** The pending request slot; it replaces the checklist strip. */
  readonly request: ReactNode | null;
  readonly requestExpanded: boolean;
  /** Collapses whichever of the checklist or request is expanded. */
  readonly onCollapse: () => void;
  readonly showScrollToEnd: boolean;
  readonly onScrollToEnd: () => void;
  readonly lift?: SharedValue<number>;
}

/**
 * The live bar: a pill of live segments with the checklist or a pending request attached on top,
 * as one card that sits in flow above the composer so the feed inset follows its height.
 */
export function LiveBar(props: LiveBarProps) {
  const gt = useGT();
  const reducedMotion = useReducedMotion();
  const [hostWidth, setHostWidth] = useState(0);
  const [rowWidth, setRowWidth] = useState(0);
  const availableWidth = Math.max(0, hostWidth - CARD_GUTTER * 2);
  const actions: ReadonlyArray<FloatingStatusAction> =
    props.status?.kind === "goal"
      ? props.status.actions
      : props.status?.kind === "stop" && props.status.action !== null
        ? [props.status.action]
        : [];
  const extensionStatus = props.extensionStatus ?? null;
  const hasSegments =
    props.status !== null ||
    extensionStatus !== null ||
    props.time !== null ||
    props.agents !== null ||
    props.sideChats !== null ||
    props.devicePreview !== null ||
    props.browserPreview !== null ||
    props.contextPercent !== null ||
    props.queuedCount > 0;
  const requestShown = props.request !== null;
  const checklistExpanded = props.checklistExpanded && props.checklist !== null && !requestShown;
  const requestExpanded = props.requestExpanded && requestShown;
  const pillVisible = hasSegments && !requestExpanded;
  const topSlot: ReactNode =
    props.request ??
    (props.checklist === null ? null : checklistExpanded ? (
      <ChecklistExpanded checklist={props.checklist} onCollapse={props.onToggleChecklist} />
    ) : (
      <ChecklistStrip checklist={props.checklist} onExpand={props.onToggleChecklist} />
    ));
  const hasLiveBar = pillVisible || topSlot !== null;
  const expanded = checklistExpanded || requestExpanded;
  const targetWidth = liveBarCardTargetWidth({
    rowWidth: pillVisible ? rowWidth : 0,
    hasStrip: topSlot !== null,
    fullWidth: requestShown || checklistExpanded,
    availableWidth,
  });
  const sized = availableWidth > 0 && (!pillVisible || rowWidth > 0);
  const placement = resolveScrollButtonPlacement({
    visible: props.showScrollToEnd,
    hasLiveBar,
    expanded,
    cardTargetWidth: targetWidth,
  });
  // A hidden button keeps its last spot so it fades out where it was.
  const [buttonSpot, setButtonSpot] = useState<Exclude<ScrollButtonPlacement, "hidden">>("alone");
  if (placement !== "hidden" && placement !== buttonSpot) setButtonSpot(placement);

  const cardWidth = useSharedValue(0);
  const cardHeight = useSharedValue(0);
  const cardOpacity = useSharedValue(0);
  const besideProgress = useSharedValue(0);
  const buttonOpacity = useSharedValue(props.showScrollToEnd ? 1 : 0);
  const shownRef = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the Reanimated card width and opacity toward what this render settled on
  useEffect(() => {
    if (!hasLiveBar) {
      shownRef.current = false;
      cardOpacity.set(withTiming(0, CARD_TIMING));
      return;
    }
    if (!sized) return;
    const animate = shownRef.current && !reducedMotion;
    cardWidth.set(animate ? withTiming(targetWidth, CARD_TIMING) : targetWidth);
    cardOpacity.set(animate ? withTiming(1, CARD_TIMING) : 1);
    shownRef.current = true;
  }, [cardOpacity, cardWidth, hasLiveBar, reducedMotion, sized, targetWidth]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- animates the Reanimated scroll button position and visibility when its placement changes
  useEffect(() => {
    besideProgress.set(withTiming(placement === "beside" ? 1 : 0, CARD_TIMING));
    buttonOpacity.set(withTiming(placement === "hidden" ? 0 : 1, CARD_TIMING));
  }, [besideProgress, buttonOpacity, placement]);

  const collapse = useEffectEvent(() => props.onCollapse());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to Android back while the card is expanded, so back collapses it first
  useEffect(() => {
    if (!expanded) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      collapse();
      return true;
    });
    return () => subscription.remove();
  }, [expanded]);

  const lastHeightRef = useRef<number | null>(null);
  const handleContentLayout = (event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    if (height === lastHeightRef.current) return;
    // The first measurement lands at once so an open thread does not grow its card on entry.
    cardHeight.set(lastHeightRef.current === null ? height : withTiming(height, CARD_TIMING));
    lastHeightRef.current = height;
  };

  const lift = props.lift;
  const hostStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -(lift?.value ?? 0) }],
  }));
  const cardStyle = useAnimatedStyle(() => ({
    width: cardWidth.value,
    height: cardHeight.value,
    opacity: NATIVE_LIQUID_GLASS_SUPPORTED ? 1 : cardOpacity.value,
    transform: [{ translateX: -BESIDE_SHIFT * besideProgress.value }],
  }));
  // Content lays out once at its resting width and stays centred while the card resizes, so text
  // does not reflow on every frame.
  const contentStyle = useAnimatedStyle(() => ({
    left: (cardWidth.value - targetWidth) / 2,
  }));
  const rowStyle = useAnimatedStyle(() => ({
    left: (cardWidth.value - availableWidth) / 2,
  }));
  const buttonStyle = useAnimatedStyle(() => {
    const center = hostWidth / 2;
    const left =
      buttonSpot === "beside"
        ? center + cardWidth.value / 2 - BESIDE_SHIFT * besideProgress.value + SCROLL_BUTTON_GAP
        : center - SCROLL_BUTTON_SIZE / 2;
    return {
      left,
      bottom: buttonSpot === "above" ? cardHeight.value + SCROLL_BUTTON_GAP : 0,
      opacity: buttonOpacity.value,
    };
  });

  const previewCompact =
    props.status !== null ||
    props.time !== null ||
    props.agents !== null ||
    props.queuedCount > 0 ||
    (props.devicePreview !== null && props.browserPreview !== null);
  const statusInteractive =
    props.status?.kind === "connection" ||
    props.status?.kind === "extension" ||
    props.status?.kind === "child-input";

  const segments = (
    <View
      onLayout={(event) => setRowWidth(settleWidth(event.nativeEvent.layout.width))}
      className="h-11 flex-row items-center px-1.5"
    >
      {props.status !== null ? (
        <View
          pointerEvents={statusInteractive ? "box-none" : "none"}
          className="shrink"
          style={{ maxWidth: availableWidth * 0.6 }}
        >
          <FloatingStatusLabel
            key={
              props.status.kind === "extension"
                ? props.status.kind
                : `${props.status.kind}:${props.status.label}`
            }
            status={props.status}
          />
        </View>
      ) : null}
      {extensionStatus !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={extensionStatus.label}
          accessibilityHint={gt("Shows the full Pi status")}
          onPress={extensionStatus.onPress}
          style={{ maxWidth: availableWidth * 0.4 }}
          className="h-11 shrink flex-row items-center px-2.5 active:opacity-70"
        >
          <Text className="shrink font-t3-medium text-xs text-foreground" numberOfLines={1}>
            {extensionStatus.label}
          </Text>
        </Pressable>
      ) : null}
      {actions.map((action) => (
        <Pressable
          key={action.label}
          accessibilityRole="button"
          accessibilityLabel={action.accessibilityLabel}
          accessibilityState={{ disabled: action.disabled }}
          disabled={action.disabled}
          onPress={action.onPress}
          className={cn(
            "h-11 items-center justify-center px-2.5 active:opacity-70",
            action.disabled && "opacity-50",
          )}
        >
          <Text className="font-t3-medium text-xs text-foreground" numberOfLines={1}>
            {action.label}
          </Text>
        </Pressable>
      ))}
      {props.time !== null ? <TimeSegment time={props.time} onPress={props.onOpenTurn} /> : null}
      {props.agents !== null ? (
        <Segment
          accessibilityLabel={
            props.agents.failed
              ? gt("Agents, {agents}, one failed", {
                  agents: props.agents.segment.accessibilityLabel,
                })
              : gt("Agents, {agents}", { agents: props.agents.segment.accessibilityLabel })
          }
          accessibilityHint={gt("Opens this turn's agents")}
          onPress={props.onOpenAgents}
        >
          <SymbolView name="person.2" size={13} tintColorClassName="accent-foreground" />
          <Text className="font-t3-medium text-xs tabular-nums text-foreground" numberOfLines={1}>
            {props.agents.segment.label}
          </Text>
          {props.agents.failed ? (
            <View className="size-1.5 rounded-full bg-danger-foreground" />
          ) : null}
        </Segment>
      ) : null}
      {props.sideChats !== null ? (
        <Segment
          accessibilityLabel={
            props.sideChats.needsAttention
              ? gt(
                  "{count, plural, one {{count} side chat, one needs you} other {{count} side chats, one needs you}}",
                  { count: props.sideChats.count },
                )
              : gt("{count, plural, one {{count} side chat} other {{count} side chats}}", {
                  count: props.sideChats.count,
                })
          }
          accessibilityHint={gt("Opens this thread's side chats")}
          onPress={props.onOpenSideChats}
        >
          <SymbolView
            name="bubble.left.and.bubble.right"
            size={13}
            tintColorClassName="accent-foreground"
          />
          <Text className="font-t3-medium text-xs tabular-nums text-foreground">
            {props.sideChats.count}
          </Text>
          {props.sideChats.needsAttention ? (
            <View className="size-1.5 rounded-full bg-warning-foreground" />
          ) : null}
        </Segment>
      ) : null}
      {props.devicePreview !== null ? (
        <Segment
          accessibilityLabel={gt("{count, plural, =1 {View device} other {View {count} devices}}", {
            count: props.devicePreview.count,
          })}
          accessibilityHint={gt("Watch and control devices open in this thread")}
          onPress={props.devicePreview.onPress}
        >
          <SymbolView
            name={{ ios: "iphone", android: "smartphone" }}
            size={14}
            tintColorClassName="accent-foreground"
            type="monochrome"
          />
          <Text className="font-t3-medium text-xs tabular-nums text-foreground">
            {props.devicePreview.count}
          </Text>
        </Segment>
      ) : null}
      {props.browserPreview !== null ? (
        <BrowserPreviewButton {...props.browserPreview} compact={previewCompact} />
      ) : null}
      {props.contextPercent !== null ? (
        <Segment
          accessibilityLabel={gt("Context window {percent}% used", {
            percent: props.contextPercent,
          })}
          accessibilityHint={gt("Opens context window details")}
          onPress={props.onOpenContext}
        >
          <ContextRing percent={props.contextPercent} size={14} stroke={2} />
          <Text className="font-t3-medium text-xs tabular-nums text-foreground">
            {props.contextPercent}%
          </Text>
        </Segment>
      ) : null}
      {props.queuedCount > 0 ? (
        <Segment
          accessibilityLabel={gt("{count, plural, other {Open queue, {count} messages}}", {
            count: props.queuedCount,
          })}
          accessibilityHint={gt("Opens queued messages to send now, edit, or remove")}
          onPress={props.onOpenQueue}
        >
          <SymbolView name="list.number" size={13} tintColorClassName="accent-foreground" />
          <Text className="font-t3-medium text-xs tabular-nums text-foreground" numberOfLines={1}>
            {gt("{count, plural, other {{count} queued}}", { count: props.queuedCount })}
          </Text>
        </Segment>
      ) : null}
    </View>
  );

  return (
    <Animated.View
      pointerEvents="box-none"
      className="z-20 w-full items-center"
      style={[{ marginBottom: CARD_BOTTOM_GAP }, hostStyle]}
      onLayout={(event) => setHostWidth(event.nativeEvent.layout.width)}
    >
      <Animated.View
        pointerEvents={hasLiveBar ? "box-none" : "none"}
        accessibilityElementsHidden={!hasLiveBar}
        importantForAccessibility={hasLiveBar ? "auto" : "no-hide-descendants"}
        className={NATIVE_LIQUID_GLASS_SUPPORTED ? undefined : "shadow-md shadow-black/10"}
        style={cardStyle}
      >
        <View
          pointerEvents="box-none"
          className={cn(
            "flex-1 overflow-hidden rounded-[22px]",
            !NATIVE_LIQUID_GLASS_SUPPORTED && "border border-border bg-glass-fallback",
            requestShown && "border border-warning-border",
          )}
        >
          {NATIVE_LIQUID_GLASS_SUPPORTED ? (
            <UniwindGlassView
              pointerEvents="none"
              colorScheme={props.colorScheme}
              glassEffectStyle={{ style: hasLiveBar ? "regular" : "none", animate: true }}
              className="absolute inset-0 rounded-[22px]"
            />
          ) : null}
          {availableWidth > 0 ? (
            <Animated.View
              pointerEvents="box-none"
              className="absolute bottom-0"
              style={[{ width: targetWidth }, contentStyle]}
              onLayout={handleContentLayout}
            >
              {topSlot}
              {topSlot !== null && pillVisible ? (
                <View className="bg-border" style={{ height: StyleSheet.hairlineWidth }} />
              ) : null}
              {pillVisible ? <View pointerEvents="none" style={{ height: PILL_HEIGHT }} /> : null}
            </Animated.View>
          ) : null}
          {pillVisible && availableWidth > 0 ? (
            <Animated.View
              pointerEvents="box-none"
              className="absolute bottom-0 items-center justify-center"
              style={[{ height: PILL_HEIGHT, width: availableWidth }, rowStyle]}
            >
              {segments}
            </Animated.View>
          ) : null}
        </View>
      </Animated.View>

      <Animated.View
        pointerEvents={placement === "hidden" ? "none" : "box-none"}
        accessibilityElementsHidden={placement === "hidden"}
        importantForAccessibility={placement === "hidden" ? "no-hide-descendants" : "auto"}
        className="absolute"
        style={buttonStyle}
      >
        {NATIVE_LIQUID_GLASS_SUPPORTED ? (
          <UniwindGlassView
            colorScheme={props.colorScheme}
            glassEffectStyle={{ style: placement === "hidden" ? "none" : "regular", animate: true }}
            isInteractive
            className="h-11 w-11 items-center justify-center overflow-hidden rounded-full"
          >
            <ControlPill
              accessibilityLabel={gt("Scroll to end")}
              activateOnPressIn
              className="h-11 w-11 bg-transparent"
              disabled={placement === "hidden"}
              icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
              onPress={props.onScrollToEnd}
            />
          </UniwindGlassView>
        ) : (
          <ControlPill
            accessibilityLabel={gt("Scroll to end")}
            activateOnPressIn
            className="h-11 w-11 border border-border bg-glass-fallback shadow-md shadow-black/10"
            disabled={placement === "hidden"}
            icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
            onPress={props.onScrollToEnd}
          />
        )}
      </Animated.View>
    </Animated.View>
  );
}

function Segment(props: {
  readonly accessibilityLabel: string;
  readonly accessibilityHint: string;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      onPress={props.onPress}
      className="h-11 flex-row items-center gap-1.5 px-2.5 active:opacity-70"
    >
      {props.children}
    </Pressable>
  );
}

/** Ticks once a second while working; only this segment re-renders. */
function TimeSegment(props: { readonly time: LiveBarTime; readonly onPress: () => void }) {
  const { time } = props;
  const gt = useGT();
  const nowMs = useVisibleSecondClock(time.kind === "working");
  const label =
    time.kind === "working"
      ? formatLiveClock(toServerClock(time.environmentId, nowMs) - time.startedAtMs)
      : formatLastTurnDuration(time.durationMs);
  return (
    <Segment
      accessibilityLabel={
        time.kind === "working"
          ? gt("Working for {duration}", { duration: label })
          : gt("Last turn took {duration}", { duration: label })
      }
      accessibilityHint={gt("Opens this turn's details")}
      onPress={props.onPress}
    >
      {time.kind === "working" ? (
        <View
          className={cn(
            "size-2 rounded-full",
            time.waiting ? "bg-warning-foreground" : "bg-adaptive-blue-500-400",
          )}
        />
      ) : (
        <SymbolView
          name="checkmark"
          size={11}
          tintColorClassName="accent-adaptive-emerald-600-400"
        />
      )}
      <Text className="font-t3-medium text-xs tabular-nums text-foreground">{label}</Text>
    </Segment>
  );
}

function FloatingStatusLabel(props: { readonly status: FloatingWorkingStatus }) {
  if (props.status.kind === "extension") {
    return (
      <StatusLabelRow
        accessibilityLabel={props.status.label}
        accessibilityRole="button"
        onPress={props.status.onPress}
        className="gap-1.5"
        animated={false}
      >
        <Text className="shrink font-t3-medium text-xs text-foreground" numberOfLines={1}>
          {props.status.label}
        </Text>
        <SymbolView name="chevron.down" size={10} tintColorClassName="accent-foreground" />
      </StatusLabelRow>
    );
  }
  if (props.status.kind === "child-input") {
    return (
      <StatusLabelRow
        accessibilityLabel={props.status.accessibilityLabel}
        accessibilityRole="button"
        className="gap-2"
        onPress={props.status.onPress}
      >
        <SymbolView name="text.bubble" size={13} tintColorClassName="accent-foreground" />
        <Text className="shrink font-t3-medium text-xs text-foreground" numberOfLines={1}>
          {props.status.label}
        </Text>
      </StatusLabelRow>
    );
  }
  if (props.status.kind === "connection") {
    return (
      <StatusLabelRow
        accessibilityLabel={props.status.label}
        accessibilityRole="button"
        className="gap-2"
        onPress={props.status.onPress}
      >
        <View className="h-2 w-2 rounded-full bg-red-500" />
        <Text className="shrink font-t3-medium text-xs text-foreground" numberOfLines={1}>
          {props.status.label}
        </Text>
      </StatusLabelRow>
    );
  }
  if (props.status.kind === "stop") {
    return (
      <StatusLabelRow accessibilityLabel={props.status.label} className="gap-2">
        {props.status.unresponsive ? (
          <SymbolView
            name="exclamationmark.triangle"
            size={13}
            tintColorClassName="accent-warning-foreground"
            type="monochrome"
          />
        ) : (
          <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
        )}
        <Text className="shrink font-t3-medium text-xs text-foreground" numberOfLines={1}>
          {props.status.label}
        </Text>
      </StatusLabelRow>
    );
  }
  if (props.status.kind === "goal") {
    return (
      <StatusLabelRow accessibilityLabel={props.status.accessibilityLabel} className="gap-2">
        <SymbolView
          name="target"
          size={13}
          tintColorClassName="accent-foreground"
          type="monochrome"
        />
        <Text className="shrink font-t3-medium text-xs text-foreground" numberOfLines={1}>
          {props.status.label}
        </Text>
      </StatusLabelRow>
    );
  }
  return (
    <StatusLabelRow accessibilityLabel={props.status.label} className="gap-1.5">
      <SymbolView
        name="arrow.triangle.branch"
        size={13}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
      <ShimmeringWorkContent
        className="flex-none"
        textClassName="font-t3-medium"
        compact
        icon="arrow.triangle.branch"
        iconSubtleColor="transparent"
        label={props.status.label}
        showIcon={false}
      />
    </StatusLabelRow>
  );
}

function StatusLabelRow(props: {
  readonly animated?: boolean;
  readonly accessibilityLabel?: string;
  readonly accessibilityRole?: "button";
  readonly className?: string;
  readonly children: ReactNode;
  readonly onPress?: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const rowClassName = `h-11 flex-row items-center px-2.5 ${props.className ?? ""}`;
  return (
    <Animated.View
      className="max-w-full"
      entering={props.animated === false || reducedMotion ? undefined : LABEL_ENTERING}
      exiting={props.animated === false || reducedMotion ? undefined : LABEL_EXITING}
    >
      {props.onPress ? (
        <Pressable
          accessibilityLabel={props.accessibilityLabel}
          accessibilityRole={props.accessibilityRole}
          className={`${rowClassName} active:opacity-70`}
          onPress={props.onPress}
        >
          {props.children}
        </Pressable>
      ) : (
        <View accessible accessibilityLabel={props.accessibilityLabel} className={rowClassName}>
          {props.children}
        </View>
      )}
    </Animated.View>
  );
}
