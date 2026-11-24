import { msg } from "gt-react-native";

export const NAVIGATION_TAB_ORDER = [
  "threads",
  "agents",
  "work",
  "pullRequests",
  "issues",
  "usage",
] as const;
/** Built, but left out of the tab bar while workflows are a soft launch on web. */
type UnlistedTab = "workflows";
export type NavigationTab = (typeof NAVIGATION_TAB_ORDER)[number] | UnlistedTab;

const SHARED_SLOT_TABS = ["pullRequests", "issues"] as const;
export type SharedSlotTab = (typeof SHARED_SLOT_TABS)[number];

export function isSharedSlotTab(value: unknown): value is SharedSlotTab {
  return SHARED_SLOT_TABS.some((tab) => tab === value);
}

/**
 * Pull requests and issues share one slot in the tab bar. The open one holds it, or else the one
 * opened last; this returns the other, which the bar leaves out.
 */
export function sharedSlotAbsentee(selected: NavigationTab, last: unknown): SharedSlotTab {
  const holder = isSharedSlotTab(selected) ? selected : last === "issues" ? last : "pullRequests";
  return holder === "issues" ? "pullRequests" : "issues";
}

/** The tab bar's slots. Settings sits in the Home header, not the bar. */
export const NAVIGATION_TAB_CAPACITY = 5;

export function navigationCustomizationAvailable(
  registeredSections: number = NAVIGATION_TAB_ORDER.length - 1,
) {
  return registeredSections > NAVIGATION_TAB_CAPACITY;
}

export const NAVIGATION_TAB_LABELS: Readonly<Record<NavigationTab, string>> = {
  threads: msg("Threads", { $context: "navigation tab, list of chat threads" }),
  agents: msg("Agents", { $context: "navigation tab, list of agents" }),
  pullRequests: msg("Pulls", { $context: "navigation tab, pull requests" }),
  issues: msg("Issues", { $context: "navigation tab, issues from an issue tracker" }),
  work: msg("Work", { $context: "navigation tab, work items and goals" }),
  workflows: msg("Workflows", { $context: "navigation tab, durable workflow runs" }),
  usage: msg("Usage", { $context: "navigation tab, provider usage limits" }),
};

function isNavigationTab(value: unknown): value is NavigationTab {
  return NAVIGATION_TAB_ORDER.some((tab) => tab === value);
}

/**
 * Complete older preferences without losing their order or retaining removed sections. A section
 * the saved order lacks goes after the one it follows by default, so Agents lands after Chats.
 */
export function resolveNavigationTabOrder(saved?: readonly unknown[]): readonly NavigationTab[] {
  if (!saved?.length) return NAVIGATION_TAB_ORDER;
  const order = [...new Set(saved.filter(isNavigationTab))];
  NAVIGATION_TAB_ORDER.forEach((tab, index) => {
    if (order.includes(tab)) return;
    const after = index === 0 ? -1 : order.indexOf(NAVIGATION_TAB_ORDER[index - 1]!);
    order.splice(after === -1 ? order.length : after + 1, 0, tab);
  });
  return order;
}

export function moveNavigationTab(
  saved: readonly unknown[] | undefined,
  tab: NavigationTab,
  position: number,
): readonly NavigationTab[] {
  const order = [...resolveNavigationTabOrder(saved)];
  const from = order.indexOf(tab);
  const to = Math.max(0, Math.min(order.length - 1, position));
  order.splice(from, 1);
  order.splice(to, 0, tab);
  return order;
}

export function resolveHiddenNavigationTabs(saved?: readonly unknown[]): readonly NavigationTab[] {
  return [...new Set(saved?.filter(isNavigationTab) ?? [])];
}

export function toggleNavigationTabVisibility(
  saved: readonly unknown[] | undefined,
  tab: NavigationTab,
) {
  const hidden = resolveHiddenNavigationTabs(saved);
  return hidden.includes(tab) ? hidden.filter((candidate) => candidate !== tab) : [...hidden, tab];
}

export function enabledNavigationTabs(saved?: readonly unknown[], hidden?: readonly unknown[]) {
  const excluded = resolveHiddenNavigationTabs(hidden);
  return resolveNavigationTabOrder(saved).filter((tab) => !excluded.includes(tab));
}

export function visibleNavigationTabs(
  saved?: readonly unknown[],
  hidden?: readonly unknown[],
  capacity = NAVIGATION_TAB_CAPACITY,
) {
  return enabledNavigationTabs(saved, hidden).slice(0, capacity);
}

export function overflowNavigationTabs(saved?: readonly unknown[], hidden?: readonly unknown[]) {
  return enabledNavigationTabs(saved, hidden).slice(NAVIGATION_TAB_CAPACITY);
}

export function selectedNavigationTab(
  saved: readonly unknown[] | undefined,
  selected: NavigationTab,
  settingsOpen: boolean,
  hidden?: readonly unknown[],
  capacity = NAVIGATION_TAB_CAPACITY,
): NavigationTab | "settings" {
  return settingsOpen || !visibleNavigationTabs(saved, hidden, capacity).includes(selected)
    ? "settings"
    : selected;
}

export function resolveSelectedNavigationTab(
  saved: readonly unknown[] | undefined,
  hidden: readonly unknown[] | undefined,
  selected: NavigationTab,
) {
  const enabled = enabledNavigationTabs(saved, hidden);
  return enabled.includes(selected) ? selected : enabled[0];
}
