import {
  AGENT_AVATAR_MOODS,
  AGENT_AVATAR_TONES,
  generateAgentAvatar,
  sameAgentAvatar,
  switchAgentAvatarMode,
} from "@t3tools/client-runtime/project-work";
import { PROJECT_TEAM_PRESETS, type ProjectTeamAvatar } from "@t3tools/contracts";
import { getRandomValues } from "expo-crypto";
import { useState } from "react";
import { View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { Button } from "../../components/ui/Button";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { WorkBlock, WorkText } from "./WorkParts";
import { WorkAgentAvatar } from "./WorkAgentAvatar";
import type { TeamRole } from "./workLogic";

export function WorkAvatarEditor({
  role,
  name,
  avatar,
  recorded,
  others,
  onChange,
}: {
  role: TeamRole;
  name: string;
  avatar: ProjectTeamAvatar | null | undefined;
  recorded: ProjectTeamAvatar | null | undefined;
  others: ReadonlyArray<ProjectTeamAvatar>;
  onChange: (avatar: ProjectTeamAvatar | null) => void;
}) {
  const [stashed, setStashed] = useState(avatar ?? null);
  const [preview, setPreview] = useState(0);
  const reduced = useReducedMotion();
  const unavailable = reduced
    ? "Your system reduces motion."
    : !avatar?.motion
      ? "Motion is off for this avatar."
      : null;
  return (
    <WorkBlock>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${name}'s avatar: ${avatar ? `${avatar.expression}, ${avatar.tone} face` : "initials"}`}
      >
        <WorkAgentAvatar role={role} name={name} avatar={avatar} size={64} preview={preview} />
      </View>
      <SegmentedControl
        options={[
          { value: "face", label: "Face" },
          { value: "initials", label: "Initials" },
        ]}
        selected={avatar ? "face" : "initials"}
        onSelect={(mode) => {
          const state = switchAgentAvatarMode(
            avatar,
            stashed,
            PROJECT_TEAM_PRESETS[role].avatar,
            mode,
          );
          setStashed(state.stashed);
          onChange(state.avatar);
          setPreview(0);
        }}
      />
      {avatar ? (
        <>
          <WorkText muted>Color</WorkText>
          <SegmentedControl
            options={(
              Object.keys(AGENT_AVATAR_TONES) as Array<keyof typeof AGENT_AVATAR_TONES>
            ).map((tone) => ({ value: tone, label: AGENT_AVATAR_TONES[tone].label }))}
            selected={avatar.tone}
            onSelect={(tone) => onChange({ ...avatar, tone })}
          />
          <WorkText muted>Mood</WorkText>
          <SegmentedControl
            options={(
              Object.keys(AGENT_AVATAR_MOODS) as Array<keyof typeof AGENT_AVATAR_MOODS>
            ).map((mood) => ({ value: mood, label: AGENT_AVATAR_MOODS[mood] }))}
            selected={avatar.expression}
            onSelect={(expression) => {
              onChange({ ...avatar, expression });
              setPreview((n) => n + 1);
            }}
          />
          <View className="flex-row flex-wrap gap-2">
            <Button
              label="Generate another face"
              onPress={() => {
                const next = generateAgentAvatar(
                  avatar,
                  others,
                  () => getRandomValues(new Uint32Array(1))[0]!,
                );
                onChange(next);
                setStashed(next);
                setPreview((n) => n + 1);
              }}
            />
            <Button
              label="Preview"
              disabled={unavailable !== null}
              onPress={() => setPreview((n) => n + 1)}
            />
          </View>
          <ListToggleRow
            label="Animate"
            description="A short nod and blink when previewed. Never loops."
            value={avatar.motion}
            onValueChange={(motion) => onChange({ ...avatar, motion })}
          />
          {unavailable ? <WorkText muted>{unavailable}</WorkText> : null}
        </>
      ) : null}
      {!sameAgentAvatar(avatar, recorded) ? (
        <Button
          label="Revert avatar"
          tone="text"
          onPress={() => {
            onChange(recorded ?? null);
            setStashed(recorded ?? null);
            setPreview(0);
          }}
        />
      ) : null}
    </WorkBlock>
  );
}
