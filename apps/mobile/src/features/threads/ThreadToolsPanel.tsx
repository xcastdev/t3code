import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import {
  GestureDetector,
  GestureHandlerRootView,
  usePanGesture,
} from "react-native-gesture-handler";
import Animated, {
  Easing,
  ReduceMotion,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  Extrapolation,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { ListSection } from "../../components/ui/ListSection";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { deviceEnvironment } from "../../state/device";
import { useThreadServerBrowserTabs } from "../../state/preview";
import { useEnvironmentQuery } from "../../state/query";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { threadDevicePreviews } from "../devices/threadDevicePreviews";
import {
  threadToolSections,
  type ThreadToolAction,
  type ThreadToolsInput,
} from "./thread-tools-panel";

// Matches the native header menus: a quick spring that overshoots a little, then settles.
const OPEN_SPRING = {
  damping: 21,
  stiffness: 260,
  mass: 0.9,
  reduceMotion: ReduceMotion.System,
};
// Room past the screen edge so the overshoot never shows a gap.
const OVERSHOOT_BLEED = 32;
const CLOSE_TIMING = {
  duration: 220,
  easing: Easing.in(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};
const SUPPORTED_ORIENTATIONS = [
  "portrait",
  "portrait-upside-down",
  "landscape-left",
  "landscape-right",
] as const;

export interface ThreadToolsPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tools: Omit<ThreadToolsInput, "browserTabUrls" | "deviceNames">;
  /** Runs once the panel is gone, so a presented route never races its dismissal. */
  readonly onSelect: (action: ThreadToolAction) => void;
  readonly onClosed: () => void;
}

/** A slide-over list of the thread's tools. Mount it only while it is open. */
export function ThreadToolsPanel(props: ThreadToolsPanelProps) {
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const panelWidth = Math.min(Math.round(windowWidth * 0.85), 420);
  const offset = useSharedValue(panelWidth);
  const [presented, setPresented] = useState(true);
  const closing = useRef(false);
  const pending = useRef<ThreadToolAction | null>(null);
  const finished = useRef(false);
  const dismissFallback = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sections = threadToolSections({
    ...props.tools,
    ...useOpenPreviews(props.environmentId, props.threadId, props.tools.hasThread),
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the one-shot Reanimated slide-in when the panel mounts
  useEffect(() => {
    offset.set(withSpring(0, OPEN_SPRING));
  }, [offset]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the dismiss fallback timer on unmount
  useEffect(
    () => () => {
      if (dismissFallback.current !== null) clearTimeout(dismissFallback.current);
    },
    [],
  );

  const finish = () => {
    if (dismissFallback.current !== null) clearTimeout(dismissFallback.current);
    dismissFallback.current = null;
    if (finished.current) return;
    finished.current = true;
    const action = pending.current;
    props.onClosed();
    if (action) props.onSelect(action);
  };
  const hide = () => {
    setPresented(false);
    // Only iOS reports onDismiss, and it can drop it while another presentation competes.
    if (Platform.OS === "ios") dismissFallback.current = setTimeout(finish, 400);
    else finish();
  };
  const close = (action?: ThreadToolAction) => {
    if (closing.current) return;
    closing.current = true;
    pending.current = action ?? null;
    offset.set(
      withTiming(panelWidth, CLOSE_TIMING, (done) => {
        if (done) runOnJS(hide)();
      }),
    );
  };

  const swipe = usePanGesture({
    activeOffsetX: [-12, 12],
    failOffsetY: [-12, 12],
    onUpdate: (event) => {
      offset.set(Math.max(0, event.translationX));
    },
    onDeactivate: (event) => {
      if (!event.canceled && (event.translationX > panelWidth * 0.3 || event.velocityX > 800)) {
        runOnJS(close)();
      } else {
        offset.set(withSpring(0, OPEN_SPRING));
      }
    },
  });
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(offset.value, [0, panelWidth], [1, 0]),
  }));
  const panelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(offset.value, [0, panelWidth * 0.6], [1, 0.4], Extrapolation.CLAMP),
    transform: [
      { translateX: offset.value },
      { scale: interpolate(offset.value, [0, panelWidth], [1, 0.92], Extrapolation.CLAMP) },
    ],
  }));

  return (
    <Modal
      visible={presented}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      supportedOrientations={SUPPORTED_ORIENTATIONS}
      onRequestClose={() => close()}
      onDismiss={finish}
    >
      <GestureHandlerRootView className="flex-1">
        <Animated.View className="absolute inset-0 bg-backdrop" style={scrimStyle}>
          <Pressable
            className="flex-1"
            accessibilityRole="button"
            accessibilityLabel="Close tools"
            onPress={() => close()}
          />
        </Animated.View>
        <GestureDetector gesture={swipe}>
          <Animated.View
            accessibilityViewIsModal
            onAccessibilityEscape={() => close()}
            className="absolute top-0 bottom-0 bg-sheet"
            style={[
              {
                right: -OVERSHOOT_BLEED,
                width: panelWidth + OVERSHOOT_BLEED,
                paddingTop: insets.top,
                paddingRight: OVERSHOOT_BLEED,
                transformOrigin: "top right",
              },
              panelStyle,
            ]}
          >
            <View className="flex-row items-center gap-2 px-2 pb-2">
              <IconButton icon="xmark" accessibilityLabel="Close tools" onPress={() => close()} />
              <AppText
                accessibilityRole="header"
                textRole="headline"
                className="flex-1 font-t3-bold text-foreground"
              >
                Tools
              </AppText>
            </View>
            <ScrollView
              className="flex-1"
              contentContainerClassName="gap-6 px-4 pt-2"
              contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
            >
              {sections.map((section) => (
                <ListSection key={section.title} title={section.title}>
                  {section.rows.map((row) => {
                    const item = (
                      <NavigationRow
                        className="bg-grouped-card"
                        title={row.title}
                        subtitle={row.subtitle}
                        subtitleNumberOfLines={1}
                        leading={
                          <SymbolView
                            name={row.icon}
                            size={row.nested ? 18 : 22}
                            tintColorClassName={row.nested ? "accent-icon-muted" : "accent-icon"}
                          />
                        }
                        disabled={row.disabled}
                        onPress={() => close(row.action)}
                      />
                    );
                    return row.nested ? (
                      <View key={row.id} className="bg-grouped-card pl-8">
                        {item}
                      </View>
                    ) : (
                      <View key={row.id}>{item}</View>
                    );
                  })}
                </ListSection>
              ))}
            </ScrollView>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** Subscribed only while the panel is open; the thread screen already keeps both warm. */
function useOpenPreviews(environmentId: EnvironmentId, threadId: ThreadId, hasThread: boolean) {
  const serverConfig = useRemoteEnvironmentRuntime(environmentId)?.serverConfig ?? null;
  const browser = useThreadServerBrowserTabs({
    environmentId,
    threadId,
    enabled: hasThread && serverConfig?.environment.capabilities.serverBrowser === true,
  });
  const devices = useEnvironmentQuery(
    hasThread ? deviceEnvironment.state({ environmentId, input: {} }) : null,
  );
  return {
    browserTabUrls: browser.tabs.map((tab) =>
      tab.navStatus._tag === "Idle" ? null : tab.navStatus.url,
    ),
    deviceNames: threadDevicePreviews(devices.data, threadId).map((device) => device.name),
  };
}
