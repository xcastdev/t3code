// While the sidebar is hidden the notification bell rides beside its toggle; the bell is an icon
// button, a quarter rem wider than the toggle. Match the sidebar gap during a drag, before
// pointer-up commits its visibility. The bell mounts only on commit, so a drag that closes an
// open sidebar leaves room for the toggle alone.
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]:not([data-sidebar-drag-state=expanded])_&]:pl-[calc(var(--workspace-titlebar-content-left)+var(--workspace-titlebar-control-size)+0.25rem)] [[data-sidebar-state=expanded][data-sidebar-drag-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] max-md:[[data-sidebar-state=expanded]_&]:pl-[calc(var(--workspace-titlebar-content-left)+var(--workspace-titlebar-control-size)+0.25rem)] [[data-sidebar-drag-state]_&]:transition-none!";
