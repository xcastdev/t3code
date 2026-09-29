import type { SearchMiddleware } from "@tanstack/react-router";

import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";

/** Accept legacy provider links without replacing an explicit settings scope. */
export function validateSettingsRouteSearch(raw: Record<string, unknown>) {
  const scope = validateSettingsScopeSearch(
    typeof raw.environmentId === "string" && raw.machine === undefined && raw.project === undefined
      ? { ...raw, machine: raw.environmentId }
      : raw,
  );
  return {
    ...scope,
    ...(typeof raw.resource === "string" && raw.resource.length > 0
      ? { resource: raw.resource }
      : {}),
  };
}

const SCOPE_KEYS = [
  "project",
  "machine",
  "checkout",
] as const satisfies readonly (keyof SettingsScopeSearch)[];
const TARGET_INPUT_KEYS = [...SCOPE_KEYS, "environmentId"];

/**
 * Category links keep the target, while an explicit target replaces the entire
 * previous selection. `environmentId` is the legacy provider deep-link target.
 */
export const retainSettingsScope: SearchMiddleware<SettingsScopeSearch> = ({ search, next }) => {
  const result = next(search);
  if (TARGET_INPUT_KEYS.some((key) => Object.hasOwn(result, key))) return result;
  const previousScope = Object.fromEntries(
    SCOPE_KEYS.filter((key) => search[key] !== undefined).map((key) => [key, search[key]]),
  );
  const { resource: _resource, ...categorySearch } = result;
  return { ...previousScope, ...categorySearch };
};
