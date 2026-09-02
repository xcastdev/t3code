# Workspace panes

T3 Code's desktop and web workspace has three areas:

- The navigation sidebar contains projects, threads, and app navigation.
- The workspace contains the chat pane and, when needed, a secondary pane for files.
- The right sidebar contains project tools and other surfaces.

## Right sidebar

The right sidebar starts as a vertical icon rail. Hover or focus an icon to see its name,
description, and shortcut. Select an available icon to open that surface.

When a surface is open, the rail becomes a tabbed panel. The plus button in the tab bar opens
another surface without replacing the existing tabs. Closing the last tab returns the sidebar to
the icon rail. Use the sidebar visibility control when you want to hide the entire sidebar.

Project Explorer is one of the right-sidebar surfaces. It shows the active project's files and
directories. Selecting a file opens it in the secondary pane while Project Explorer stays open.

## Secondary pane

The secondary pane is part of the workspace, not part of the right sidebar. It opens when you
select a file from Project Explorer, chat, search, a diff, or another file-opening action. Its tabs
are independent from the right-sidebar tabs, so changing an editor tab does not change the
selected right-sidebar surface.

Only the active editor tab is mounted. Closing the last editor tab closes the secondary pane and
leaves the right sidebar unchanged.

Both panes remember their widths independently. On narrower windows, the right sidebar becomes a
sheet so the chat remains usable; the same workspace and tab relationships are preserved.
