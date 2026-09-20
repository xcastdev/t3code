import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";

import { resolveProjectPickerTarget, type WslEnvironmentConfiguration } from "../../wslPaths";

export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return wasEdited && memberTitles.some((title) => title !== nextTitle);
}

export type ProjectPickerEnvironmentKind = "primary" | "desktop-local" | "remote";

export interface ProjectPickerRouting {
  readonly canBrowse: boolean;
  /** The desktop backend id to pass to pickFolder, or null for the primary. */
  readonly targetEnvironmentId: string | null;
}

/**
 * Keep project-settings folder picking aligned with the CommandPalette picker.
 * A remote environment has no local filesystem dialog, while a desktop-local
 * secondary must wait until its bootstrap maps the catalog URL to a pool id.
 */
export function resolveProjectPickerRouting(input: {
  readonly hasDesktopBridge: boolean;
  readonly environmentId: string;
  readonly primaryEnvironmentId: string | null;
  readonly environmentKind: ProjectPickerEnvironmentKind;
  readonly displayUrl: string | null;
  readonly desktopLocalBootstraps: ReadonlyArray<
    Pick<DesktopEnvironmentBootstrap, "id" | "httpBaseUrl">
  >;
  readonly wslConfiguration: WslEnvironmentConfiguration | null;
}): ProjectPickerRouting {
  const isPrimary =
    input.environmentKind === "primary" && input.environmentId === input.primaryEnvironmentId;
  const desktopInstanceId =
    input.environmentKind === "desktop-local" && input.displayUrl !== null
      ? (input.desktopLocalBootstraps.find(
          (bootstrap) => bootstrap.httpBaseUrl === input.displayUrl,
        )?.id ?? null)
      : null;
  const targetEnvironmentId = resolveProjectPickerTarget({
    browseEnvironmentId: input.environmentId,
    primaryEnvironmentId: input.primaryEnvironmentId,
    desktopInstanceId,
    wslConfiguration: isPrimary ? input.wslConfiguration : null,
  });

  return {
    canBrowse: input.hasDesktopBridge && (isPrimary || desktopInstanceId !== null),
    targetEnvironmentId,
  };
}
