import { Badge } from "../ui/badge";
import type { AssistantTone } from "@t3tools/client-runtime/assistant-presentation";

const TONE_VARIANTS = {
  neutral: "secondary",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "error",
} as const satisfies Record<AssistantTone, string>;

export function AssistantToneBadge({
  tone,
  children,
}: {
  readonly tone: AssistantTone;
  readonly children: string;
}) {
  return (
    <Badge variant={TONE_VARIANTS[tone]} className="shrink-0">
      {children}
    </Badge>
  );
}
