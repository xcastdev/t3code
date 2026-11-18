import type { WorkTone } from "@t3tools/client-runtime/project-work-presentation";
import { PROJECT_TEAM_PRESETS, type ProjectTeamAvatar } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { WorkAgentAvatar } from "./WorkAgentAvatar";
import { workStateLabel, workStateVariant } from "./workModel";

/** One palette per tone, matching web's badge variants. */
const TONES: Record<WorkTone, { tint: string; text: string; background: string }> = {
  secondary: {
    tint: "accent-icon-muted",
    text: "text-foreground-muted",
    background: "bg-adaptive-zinc-500-a12-a16",
  },
  outline: {
    tint: "accent-icon-muted",
    text: "text-foreground-muted",
    background: "bg-adaptive-zinc-500-a12-a16",
  },
  success: {
    tint: "accent-adaptive-emerald-600-400",
    text: "text-adaptive-emerald-600-400",
    background: "bg-adaptive-emerald-500-a12-a16",
  },
  warning: {
    tint: "accent-adaptive-amber-700-400",
    text: "text-adaptive-amber-700-400",
    background: "bg-adaptive-amber-500-a12-a16",
  },
  error: {
    tint: "accent-danger-foreground",
    text: "text-danger-foreground",
    background: "bg-adaptive-rose-500-a12-a16",
  },
  info: {
    tint: "accent-adaptive-sky-600-400",
    text: "text-adaptive-sky-600-400",
    background: "bg-adaptive-sky-500-a12-a16",
  },
};

/** The same glyph web draws for each state, from symbols both platforms have. */
const GLYPHS: Record<string, AppSymbolName> = {
  draft: "circle.dashed",
  specified: "circle",
  ready: "arrow.right.circle",
  "in-progress": "circle.inset.filled",
  "in-review": "ellipsis.circle",
  blocked: "slash.circle",
  failed: "exclamationmark.circle",
  completed: "checkmark.circle.fill",
  canceled: "xmark.circle.fill",
  approved: "checkmark.circle.fill",
  accepted: "checkmark.circle.fill",
  rejected: "xmark.circle.fill",
  pending: "circle",
  proposed: "circle",
  stale: "exclamationmark.triangle",
  missing: "circle.dashed",
  running: "circle.inset.filled",
  reserved: "circle.inset.filled",
  stopping: "circle.inset.filled",
  settled: "checkmark.circle",
  revoked: "slash.circle",
  quarantined: "exclamationmark.triangle",
  recovery: "exclamationmark.triangle",
  waiting: "questionmark.bubble",
  available: "circle",
  active: "circle.inset.filled",
  paused: "pause",
  retired: "slash.circle",
};

export const workTone = (state: string, tone?: WorkTone): WorkTone =>
  tone ?? workStateVariant(state);

export function WorkStatusGlyph(props: {
  readonly state: string;
  readonly tone?: WorkTone;
  readonly size?: number;
}) {
  return (
    <SymbolView
      name={GLYPHS[props.state] ?? "circle"}
      size={props.size ?? 16}
      tintColorClassName={TONES[workTone(props.state, props.tone)].tint}
      type="monochrome"
      weight="semibold"
    />
  );
}

/** A state as a tinted pill: glyph and label, colored like web's status badge. */
export const WorkStatusChip = memo(function WorkStatusChip(props: {
  readonly state: string;
  readonly label?: string;
  readonly tone?: WorkTone;
  readonly icon?: AppSymbolName | null;
}) {
  const palette = TONES[workTone(props.state, props.tone)];
  return (
    <View
      className={cn(
        "flex-row items-center gap-1 self-start rounded-full px-2 py-0.5",
        palette.background,
      )}
    >
      {props.icon === null ? null : props.icon ? (
        <SymbolView
          name={props.icon}
          size={12}
          tintColorClassName={palette.tint}
          type="monochrome"
        />
      ) : (
        <WorkStatusGlyph
          state={props.state}
          {...(props.tone ? { tone: props.tone } : {})}
          size={12}
        />
      )}
      <Text textRole="label" numberOfLines={1} className={cn("font-t3-medium", palette.text)}>
        {props.label ?? workStateLabel(props.state)}
      </Text>
    </View>
  );
});

/** A neutral label chip, such as a task's kind. */
export function WorkTagChip(props: { readonly label: string; readonly icon?: AppSymbolName }) {
  return (
    <WorkStatusChip state="tag" tone="outline" label={props.label} icon={props.icon ?? null} />
  );
}

/** One count in a row of tiles: glyph, number, label. */
export function WorkStatTile(props: {
  readonly value: number;
  readonly label: string;
  /** Draws the state's glyph beside the number; plain counts leave it out. */
  readonly state?: string;
  readonly tone?: WorkTone;
}) {
  return (
    <View className="min-w-0 flex-1 gap-0.5 rounded-2xl border-continuous bg-grouped-card px-3 py-2.5">
      <View className="flex-row items-center gap-1.5">
        {props.state ? (
          <WorkStatusGlyph state={props.state} {...(props.tone ? { tone: props.tone } : {})} />
        ) : null}
        <Text
          textRole="headline"
          className="font-t3-bold text-foreground"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {props.value}
        </Text>
      </View>
      <Text textRole="label" numberOfLines={1} className="text-foreground-muted">
        {props.label}
      </Text>
    </View>
  );
}

export function WorkStatRow(props: { readonly children: ReactNode }) {
  return <View className="flex-row flex-wrap gap-2">{props.children}</View>;
}

/** Any team member's avatar. A role this client doesn't know draws a plain monogram. */
export function WorkMemberAvatar(props: {
  readonly role: string;
  readonly name: string;
  readonly avatar?: ProjectTeamAvatar | null | undefined;
  readonly size?: number;
}) {
  const size = props.size ?? 28;
  if (props.role in PROJECT_TEAM_PRESETS)
    return (
      <WorkAgentAvatar
        role={props.role as keyof typeof PROJECT_TEAM_PRESETS}
        name={props.name}
        avatar={props.avatar}
        size={size}
      />
    );
  return (
    <View
      className="items-center justify-center bg-subtle"
      style={{ width: size, height: size, borderRadius: size * 0.25 }}
    >
      <Text
        allowFontScaling={false}
        className="font-mono text-foreground-muted"
        style={{ fontSize: size * 0.44, fontWeight: "700" }}
      >
        {props.name.trim().slice(0, 1).toUpperCase() || "?"}
      </Text>
    </View>
  );
}

/** A section's heading row with an optional count and trailing actions, like web's list header. */
export function WorkHeading(props: {
  readonly title: string;
  readonly count?: number | null;
  readonly detail?: string;
  readonly trailing?: ReactNode;
}) {
  return (
    <View className="flex-row items-center gap-3 px-2">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
          {props.title}
          {props.count === undefined || props.count === null ? "" : `  ${props.count}`}
        </Text>
        {props.detail ? (
          <Text textRole="label" className="text-foreground-tertiary">
            {props.detail}
          </Text>
        ) : null}
      </View>
      {props.trailing}
    </View>
  );
}

/** The quiet one-line state of an empty list, inside its card. */
export function WorkEmptyRow(props: { readonly title: string; readonly detail?: string }) {
  return (
    <View className={cn("gap-1 px-4", props.detail ? "items-center py-6" : "py-3.5")}>
      <Text
        textRole={props.detail ? "body" : "footnote"}
        className={
          props.detail ? "text-center font-t3-medium text-foreground" : "text-foreground-muted"
        }
      >
        {props.title}
      </Text>
      {props.detail ? (
        <Text textRole="footnote" className="text-center text-foreground-muted">
          {props.detail}
        </Text>
      ) : null}
    </View>
  );
}

/** A hairline between rows of one card. */
export function WorkSeparator() {
  return <View className="ms-4 h-px bg-separator" />;
}
