import {
  CircleIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleEllipsisIcon,
  CircleHelpIcon,
  CircleMinusIcon,
  CirclePlayIcon,
  CircleSlashIcon,
  CircleXIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { workStateLabel, workStateVariant } from "./workModel";
import type { WorkTone } from "./workPresentation";

const GLYPHS = {
  draft: CircleDashedIcon,
  specified: CircleIcon,
  ready: CirclePlayIcon,
  "in-progress": CircleDotIcon,
  "in-review": CircleEllipsisIcon,
  blocked: CircleSlashIcon,
  failed: CircleXIcon,
  completed: CircleCheckIcon,
  canceled: CircleMinusIcon,
  approved: CircleCheckIcon,
  accepted: CircleCheckIcon,
  rejected: CircleXIcon,
  pending: CircleIcon,
  stale: CircleAlertIcon,
  missing: CircleDashedIcon,
  running: CircleDotIcon,
  reserved: CircleDotIcon,
  stopping: CircleDotIcon,
  settled: CircleCheckIcon,
  revoked: CircleMinusIcon,
  quarantined: CircleAlertIcon,
  recovery: CircleAlertIcon,
  waiting: CircleHelpIcon,
  available: CircleIcon,
  active: CircleDotIcon,
  paused: CircleMinusIcon,
  retired: CircleMinusIcon,
} as const;
const TONES = {
  secondary: "text-muted-foreground",
  outline: "text-muted-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
  info: "text-info-foreground",
};

export function WorkStatusGlyph({ state, tone }: { state: string; tone?: WorkTone }) {
  const Icon = GLYPHS[state as keyof typeof GLYPHS] ?? CircleHelpIcon;
  const resolved = tone ?? workStateVariant(state);
  return (
    <Icon
      aria-hidden="true"
      className={cn("size-4 shrink-0", TONES[resolved as WorkTone] ?? TONES.secondary)}
    />
  );
}

export function WorkStatus({
  state,
  label,
  tone,
}: {
  state: string;
  label?: string;
  tone?: WorkTone;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium">
      <WorkStatusGlyph state={state} {...(tone ? { tone } : {})} />
      <span className="truncate">{label ?? workStateLabel(state)}</span>
    </span>
  );
}
