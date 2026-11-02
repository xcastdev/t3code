// Providers label plans with their brand and "Subscription" ("ChatGPT Pro 200 Subscription").
const PLAN_NOISE_WORDS = new Set(["subscription", "chatgpt", "claude"]);

/** The plan's own name ("Pro 200", "Max 20x"), or null when nothing but brand words remain. */
export function shortPlanLabel(plan: string, providerLabel: string): string | null {
  const noise = new Set([
    ...PLAN_NOISE_WORDS,
    ...providerLabel
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 0),
  ]);
  const words = plan
    .split(/\s+/)
    .filter((word) => word.length > 0 && !noise.has(word.toLowerCase()));
  return words.length > 0 ? words.join(" ") : null;
}
