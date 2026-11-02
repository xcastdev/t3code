import {
  AGENT_AVATAR_MOODS,
  AGENT_AVATAR_TONES,
  generateAgentAvatar,
  sameAgentAvatar,
  switchAgentAvatarMode,
} from "@t3tools/client-runtime/project-work";
import type { ProjectIconColor, ProjectTeamAvatar } from "@t3tools/contracts";
import { CheckIcon, PlayIcon, ShuffleIcon } from "lucide-react";
import { useId, useState } from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Label } from "../ui/label";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkMemberAvatar } from "./WorkMemberAvatar";
import { WorkMeta } from "./WorkLayout";

export function WorkAvatarEditor({
  identity: initials,
  preset,
  name,
  avatar,
  recorded,
  others,
  onChange,
}: {
  /** What the avatar shows without a face. */
  identity: { monogram: string; color: ProjectIconColor };
  /** The face offered when switching away from initials with nothing stashed. */
  preset: ProjectTeamAvatar;
  name: string;
  avatar: ProjectTeamAvatar | null | undefined;
  recorded: ProjectTeamAvatar | null | undefined;
  others: ReadonlyArray<ProjectTeamAvatar>;
  onChange: (avatar: ProjectTeamAvatar | null) => void;
}) {
  const [stashed, setStashed] = useState(avatar ?? null);
  const [preview, setPreview] = useState(0);
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const motionId = useId();
  const descriptionId = useId();
  const unavailable = reduceMotion
    ? "Your system reduces motion."
    : !avatar?.motion
      ? "Motion is off for this avatar."
      : null;
  const identity = { ...initials, avatar };
  return (
    <section
      aria-label={`Avatar for ${name}`}
      className="flex min-w-0 flex-col gap-3 sm:col-span-2"
    >
      <div className="flex min-w-0 flex-wrap items-start gap-4">
        <div
          role="img"
          aria-label={`${name}'s avatar: ${avatar ? `${avatar.expression}, ${avatar.tone} face` : `initials ${identity.monogram}`}`}
        >
          <WorkMemberAvatar member={identity} size="preview" preview={preview} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <ToggleGroup
            aria-label="Avatar"
            value={[avatar ? "face" : "initials"]}
            onValueChange={(next) => {
              if (next[0] !== "face" && next[0] !== "initials") return;
              const state = switchAgentAvatarMode(avatar, stashed, preset, next[0]);
              setStashed(state.stashed);
              onChange(state.avatar);
              setPreview(0);
            }}
          >
            <Toggle value="face">Face</Toggle>
            <Toggle value="initials">Initials</Toggle>
          </ToggleGroup>
          {avatar ? (
            <>
              <fieldset className="flex flex-wrap items-center gap-2">
                <legend className="mb-1.5 text-xs text-muted-foreground">Color</legend>
                {(Object.keys(AGENT_AVATAR_TONES) as Array<keyof typeof AGENT_AVATAR_TONES>).map(
                  (tone) => (
                    <button
                      key={tone}
                      type="button"
                      aria-label={AGENT_AVATAR_TONES[tone].label}
                      aria-pressed={avatar.tone === tone}
                      onClick={() => onChange({ ...avatar, tone })}
                      className="flex size-8 items-center justify-center rounded-full border border-border/60 text-foreground dark:text-background outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      style={{ backgroundColor: AGENT_AVATAR_TONES[tone].fill }}
                    >
                      {avatar.tone === tone ? (
                        <CheckIcon aria-hidden="true" className="size-4" />
                      ) : null}
                    </button>
                  ),
                )}
              </fieldset>
              <ToggleGroup
                aria-label="Mood"
                value={[avatar.expression]}
                wrap
                onValueChange={(next) => {
                  const expression = (
                    Object.keys(AGENT_AVATAR_MOODS) as Array<keyof typeof AGENT_AVATAR_MOODS>
                  ).find((mood) => mood === next[0]);
                  if (expression) {
                    onChange({ ...avatar, expression });
                    setPreview((n) => n + 1);
                  }
                }}
              >
                {(Object.keys(AGENT_AVATAR_MOODS) as Array<keyof typeof AGENT_AVATAR_MOODS>).map(
                  (mood) => (
                    <Toggle key={mood} value={mood}>
                      {AGENT_AVATAR_MOODS[mood]}
                    </Toggle>
                  ),
                )}
              </ToggleGroup>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    const next = generateAgentAvatar(
                      avatar,
                      others,
                      () => crypto.getRandomValues(new Uint32Array(1))[0]!,
                    );
                    setStashed(next);
                    onChange(next);
                    setPreview((n) => n + 1);
                  }}
                >
                  <ShuffleIcon /> Generate another face
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={unavailable !== null}
                  aria-describedby={unavailable ? descriptionId : undefined}
                  onClick={() => setPreview((n) => n + 1)}
                >
                  <PlayIcon /> Preview
                </Button>
                <div className="flex items-center gap-2">
                  <Switch
                    id={motionId}
                    aria-describedby={descriptionId}
                    checked={avatar.motion}
                    onCheckedChange={(motion) => onChange({ ...avatar, motion })}
                  />
                  <Label htmlFor={motionId}>Animate</Label>
                </div>
              </div>
              <WorkMeta id={descriptionId}>
                {unavailable ?? "A short nod and blink on preview or hover. Never loops."}
              </WorkMeta>
            </>
          ) : (
            <WorkMeta>Initials use the agent's name and color.</WorkMeta>
          )}
          {!sameAgentAvatar(avatar, recorded) ? (
            <div>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  onChange(recorded ?? null);
                  setStashed(recorded ?? null);
                  setPreview(0);
                }}
              >
                Revert avatar
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
