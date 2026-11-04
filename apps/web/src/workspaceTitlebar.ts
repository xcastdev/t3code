// While the sidebar is hidden the notification bell rides beside its toggle; the bell is an icon
// button, a quarter rem wider than the toggle.
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[calc(var(--workspace-titlebar-content-left)+var(--workspace-titlebar-control-size)+0.25rem)] max-md:[[data-sidebar-state=expanded]_&]:pl-[calc(var(--workspace-titlebar-content-left)+var(--workspace-titlebar-control-size)+0.25rem)]";
