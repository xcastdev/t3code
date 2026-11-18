import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import type { ChecklistPresentation, ChecklistStepPresentation } from "./live-bar-presentation";

const CHECKLIST_MAX_HEIGHT = 320;
const STRIP_TICK_WIDTH = 10;
const STRIP_TICKS_MAX_WIDTH = 60;

function stepBarClassName(status: ChecklistStepPresentation["status"]) {
  return status === "completed"
    ? "bg-foreground-muted"
    : status === "running"
      ? "bg-adaptive-blue-500-400"
      : "bg-subtle-strong";
}

function ProgressTicks(props: {
  readonly steps: ReadonlyArray<ChecklistStepPresentation>;
  readonly width?: number;
  readonly className?: string;
}) {
  return (
    <View className={cn("flex-row gap-0.5", props.className)} style={{ width: props.width }}>
      {props.steps.map((step) => (
        <View
          key={step.id}
          className={cn("h-1 flex-1 rounded-full", stepBarClassName(step.status))}
        />
      ))}
    </View>
  );
}

/** The current step, collapsed into the live bar card. */
export function ChecklistStrip(props: {
  readonly checklist: ChecklistPresentation;
  readonly onExpand: () => void;
}) {
  const { checklist } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Checklist, step ${checklist.position} of ${checklist.total}: ${checklist.currentText}`}
      accessibilityHint="Shows the whole checklist"
      onPress={props.onExpand}
      className="h-9 flex-row items-center gap-2 px-3.5 active:opacity-70"
    >
      <ProgressTicks
        steps={checklist.steps}
        width={Math.min(STRIP_TICKS_MAX_WIDTH, checklist.steps.length * STRIP_TICK_WIDTH)}
      />
      <Text className="font-t3-medium text-xs tabular-nums text-foreground" numberOfLines={1}>
        {checklist.position} of {checklist.total}
      </Text>
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        · {checklist.currentText}
      </Text>
      <SymbolView name="chevron.up" size={10} tintColorClassName="accent-icon-subtle" />
    </Pressable>
  );
}

function StepIcon(props: { readonly status: ChecklistStepPresentation["status"] }) {
  if (props.status === "completed") {
    return (
      <View className="size-5 items-center justify-center rounded-full bg-subtle-strong">
        <SymbolView name="checkmark" size={10} tintColorClassName="accent-icon-muted" />
      </View>
    );
  }
  if (props.status === "running") {
    return (
      <View className="size-5 items-center justify-center rounded-full border-2 border-adaptive-blue-500-400">
        <View className="size-2 rounded-full bg-adaptive-blue-500-400" />
      </View>
    );
  }
  return <View className="size-5 rounded-full border-2 border-border" />;
}

/** The whole checklist, expanded in place inside the live bar card. */
export function ChecklistExpanded(props: {
  readonly checklist: ChecklistPresentation;
  readonly onCollapse: () => void;
}) {
  const { checklist } = props;
  return (
    <View className="gap-2 px-4 pt-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Collapse checklist, ${checklist.done} of ${checklist.total} done`}
        onPress={props.onCollapse}
        className="flex-row items-center gap-2 active:opacity-70"
      >
        <Text className="flex-1 font-t3-bold text-base text-foreground">Checklist</Text>
        <Text className="text-xs tabular-nums text-foreground-muted">
          {checklist.done} of {checklist.total} done
        </Text>
        <SymbolView name="chevron.down" size={11} tintColorClassName="accent-icon-subtle" />
      </Pressable>
      <ProgressTicks steps={checklist.steps} className="gap-1" />
      <ScrollView
        bounces={false}
        nestedScrollEnabled
        style={{ maxHeight: CHECKLIST_MAX_HEIGHT, flexGrow: 0 }}
      >
        {checklist.steps.map((step, index) => (
          <View
            key={step.id}
            accessible
            accessibilityLabel={`${step.text}, ${
              step.status === "completed"
                ? "done"
                : step.status === "running"
                  ? "in progress"
                  : "pending"
            }`}
            className="flex-row items-center gap-3 border-border py-2.5"
            style={index === 0 ? undefined : { borderTopWidth: StyleSheet.hairlineWidth }}
          >
            <StepIcon status={step.status} />
            <Text
              className={cn(
                "min-w-0 flex-1 text-sm",
                step.status === "pending" ? "text-foreground-muted" : "text-foreground",
              )}
              numberOfLines={2}
            >
              {step.text}
            </Text>
            {step.status === "running" ? (
              <Text className="text-xs text-adaptive-blue-500-400">
                {step.durationLabel ?? "In progress"}
              </Text>
            ) : step.durationLabel !== null ? (
              <Text className="text-xs tabular-nums text-foreground-muted">
                {step.durationLabel}
              </Text>
            ) : step.status === "pending" ? (
              <Text className="text-xs text-foreground-muted">Pending</Text>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
