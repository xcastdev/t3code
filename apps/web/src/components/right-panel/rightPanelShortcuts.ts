export type RightPanelRailShortcutEvent = {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly defaultPrevented: boolean;
  readonly isComposing: boolean;
  readonly metaKey: boolean;
};
export function rightPanelRailShortcutAction<
  const Action extends { readonly available: boolean; readonly shortcut: string },
>(actions: readonly Action[], event: RightPanelRailShortcutEvent, focused: boolean): Action | null {
  if (
    !focused ||
    event.defaultPrevented ||
    event.isComposing ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  )
    return null;
  return (
    actions.find(
      (action) => action.available && action.shortcut.toLowerCase() === event.key.toLowerCase(),
    ) ?? null
  );
}
