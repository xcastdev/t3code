# Workspace panes

On web and desktop, the right sidebar holds project tools while a separate secondary pane opens
files beside the chat. In the chat header's combined project-actions menu, choose **Open With** to
open the project in an editor. Git workflows are in Source Control rather than a separate header
control.

## Right sidebar

Select a sidebar icon to open a primary project surface. Use the plus button to add another
surface, including **Diff**, and keep several open as tabs. On desktop, choose a browser profile
from **Browser** when opening another browser surface. Closing the last tab returns to the icon
rail; the sidebar visibility control hides the whole sidebar.

Project Explorer is one of the right-sidebar surfaces. It shows the active project's files and
directories. Selecting a file opens it in the secondary pane while Project Explorer stays open.

## Secondary pane

The secondary pane opens when you select a file from Project Explorer, a sent workspace file, a
search result, or a diff.
Its tabs are independent from the right sidebar, so you can change files without changing the
selected project tool. Closing its last tab closes the pane and leaves the sidebar unchanged.

In an inline secondary pane, use its editor control to open the active file in your preferred
editor, or **Choose editor** to pick another. Its header includes icon controls for minimizing and
maximizing the panel. Minimize hides the pane while retaining its tabs; opening a file or diff
restores it and activates that tab. Maximize/Restore keeps the selected file, diff comparison, and
editor location intact.

Diff tabs are tied to their environment, repository, comparison, and file paths. A file with the
same name in another repository or revision therefore opens as a separate tab. The Files surface
in the right sidebar remains the workspace tree; the secondary file view does not contain another
explorer.

Both panes remember their widths independently. On narrower windows, the right sidebar becomes a
sheet so the chat remains usable; the same workspace and tab relationships are preserved.

## Terminal

The terminal is a bottom dock. Collapse it to hide the dock and keep its sessions. Close a terminal
to remove that session.
