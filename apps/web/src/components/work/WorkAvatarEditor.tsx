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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
  const moods = Object.keys(AGENT_AVATAR_MOODS) as Array<keyof typeof AGENT_AVATAR_MOODS>;
  const tones = Object.keys(AGENT_AVATAR_TONES) as Array<keyof typeof AGENT_AVATAR_TONES>;
  const generate = () => {
    if (!avatar) return;
    const next = generateAgentAvatar(
      avatar,
      others,
      () => crypto.getRandomValues(new Uint32Array(1))[0]!,
    );
    setStashed(next);
    onChange(next);
    setPreview((n) => n + 1);
  };
  return (
    <section
      aria-label={`Avatar for ${name}`}
      className="flex min-w-0 flex-col gap-2 sm:col-span-2"
    >
      <div className="flex min-w-0 items-start gap-4 rounded-xl border border-border/60 bg-muted/20 p-3">
        <div className="flex shrink-0 flex-col items-center gap-2">
          <div
            role="img"
            aria-label={`${name}'s avatar: ${avatar ? `${avatar.expression}, ${avatar.tone} face` : `initials ${identity.monogram}`}`}
            className="grid size-20 place-items-center rounded-xl bg-background/70 ring-1 ring-border/50"
          >
            <WorkMemberAvatar member={identity} size="preview" preview={preview} />
          </div>
          {avatar ? (
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="outline"
                      aria-label="Generate another face"
                      onClick={generate}
                    />
                  }
                >
                  <ShuffleIcon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Generate another face</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="outline"
                      aria-label="Preview"
                      disabled={unavailable !== null}
                      aria-describedby={unavailable ? descriptionId : undefined}
                      onClick={() => setPreview((n) => n + 1)}
                    />
                  }
                >
                  <PlayIcon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Preview the animation</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
          <span className="text-xs text-muted-foreground">Style</span>
          <div>
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
          </div>
          {avatar ? (
            <>
              <span className="text-xs text-muted-foreground">Color</span>
              <fieldset className="flex flex-wrap items-center gap-1.5">
                <legend className="sr-only">Color</legend>
                {tones.map((tone) => (
                  <button
                    key={tone}
                    type="button"
                    aria-label={AGENT_AVATAR_TONES[tone].label}
                    aria-pressed={avatar.tone === tone}
                    onClick={() => onChange({ ...avatar, tone })}
                    className="flex size-6 cursor-pointer items-center justify-center rounded-full border border-border/60 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:text-background"
                    style={{ backgroundColor: AGENT_AVATAR_TONES[tone].fill }}
                  >
                    {avatar.tone === tone ? (
                      <CheckIcon aria-hidden="true" className="size-3.5" />
                    ) : null}
                  </button>
                ))}
              </fieldset>
              <span className="text-xs text-muted-foreground">Mood</span>
              <div>
                <ToggleGroup
                  aria-label="Mood"
                  value={[avatar.expression]}
                  wrap
                  onValueChange={(next) => {
                    const expression = moods.find((mood) => mood === next[0]);
                    if (expression) {
                      onChange({ ...avatar, expression });
                      setPreview((n) => n + 1);
                    }
                  }}
                >
                  {moods.map((mood) => (
                    <Toggle key={mood} value={mood}>
                      {AGENT_AVATAR_MOODS[mood]}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>
              <span className="text-xs text-muted-foreground">Motion</span>
              <div className="flex min-w-0 items-center gap-2">
                <Switch
                  id={motionId}
                  aria-describedby={descriptionId}
                  checked={avatar.motion}
                  onCheckedChange={(motion) => onChange({ ...avatar, motion })}
                />
                <Label htmlFor={motionId}>Animate</Label>
                <WorkMeta id={descriptionId} className="min-w-0 truncate">
                  {unavailable ?? "Nods and blinks on hover. Never loops."}
                </WorkMeta>
              </div>
            </>
          ) : (
            <WorkMeta className="col-start-2">Initials use the agent's name and color.</WorkMeta>
          )}
        </div>
      </div>
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
    </section>
  );
}
