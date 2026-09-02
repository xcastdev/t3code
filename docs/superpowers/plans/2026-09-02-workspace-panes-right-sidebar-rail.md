# Workspace Panes and Right Sidebar Rail Implementation Plan

> **For agentic workers:** The implementation described by this plan is complete in source and has passed a targeted integrated web-client pass. Use `superpowers:verification-before-completion` before making further changes.

**Goal:** Restructure the web and desktop-shared chat shell so the application has a navigation sidebar, a workspace containing chat and an optional editor pane, and a right sidebar that defaults to an icon rail.

**Architecture:** `rightPanelStore` owns right-sidebar surfaces and visibility. `secondaryPaneStore` owns file-editor tabs in the workspace. `ChatView` composes the chat pane, optional secondary pane, and right sidebar as independent siblings; Project Explorer opens files through the secondary-pane store instead of rendering an editor beside the tree.

**Tech Stack:** React, TypeScript, Zustand, existing `PreviewPanelShell`/resize primitives, Radix-style tooltip and context-menu primitives, Lucide icons, and Vitest through `vp`.

**Spec:** The accepted behavior is recorded in this plan under “Accepted behavior.”

## Implementation status

Status: source implementation and targeted integrated client verification complete. Broader workflow coverage remains optional because those paths were not changed by this redesign.

- [x] Secondary file-pane state, persistence, reconciliation, deduplication, activation, line reveal, and close actions are implemented.
- [x] File editor and Project Explorer are separate production surfaces. `FileEditorPanel` is the production import boundary; `FilePreviewPanel` remains a compatibility implementation behind that boundary.
- [x] The secondary pane has independent tabs, close actions, context-menu actions, persisted width, and stacked narrow-screen layout.
- [x] Chat links, search, file picker, diff actions, agent file links, and Project Explorer file selection use the secondary pane.
- [x] Right-panel persistence is migrated to version 12 and legacy file surfaces are removed from the right-sidebar model.
- [x] Right-panel persistence is migrated to version 13 and legacy terminal surfaces are removed; terminals remain available only through the bottom dock.
- [x] The tile launcher is replaced by the default icon rail with tooltips, keyboard shortcuts, disabled-state explanations, and live-agent badges.
- [x] Rail tooltips use the shared theme-aware popover styling with spacing and contrast suitable for the vertical icon rail.
- [x] The expanded right sidebar retains tabs and the plus menu; closing its final tab returns to the visible rail.
- [x] The primary and secondary workspace panes share one full-height split, including their top headers.
- [x] When the secondary pane is open, chat actions remain in the primary header and move with the primary pane; the secondary header owns editor tabs, Open With, and secondary-pane fullscreen.
- [x] The former right-sidebar maximize behavior and control are removed; the existing fullscreen key command now targets the secondary pane when it is available.
- [x] Drawer/right-sidebar toggle controls have one owner at a time: the right-sidebar header when expanded, the secondary header when open without an expanded right sidebar, and the chat header otherwise.
- [x] Pull Requests retains its expanded tabbed presentation.
- [x] User-facing workspace, source-control, keybinding, and documentation updates are implemented.
- [x] Run an integrated browser pass after explicit user approval using the isolated worktree environment.

Implementation commits:

- `72fb1e349` — secondary-pane state and initial implementation work.
- `8cb6ba3d9` — sanitize secondary-pane persistence.
- `4d717dfff` — split workspace editor from right sidebar.

The plan file itself is intentionally uncommitted, following repository guidance for implementation plans.

## Accepted behavior

```text
Application shell
├── Navigation sidebar
└── Main body
    ├── Workspace
    │   ├── Chat pane with its own full-height header
    │   └── Secondary editor / file viewer pane with tabs, Open With, and fullscreen in its header
    └── Right sidebar
        ├── Icon rail view
        └── Expanded view with tabs and active surface
```

- The left navigation sidebar remains the project and thread navigation surface.
- Chat is the primary workspace pane.
- An editor or file viewer opens as a secondary workspace pane beside chat.
- Project Explorer is a right-sidebar surface, not the default right-sidebar view.
- A fresh right sidebar opens as an icon rail.
- Clicking a rail icon opens that surface and changes the rail to the expanded view.
- The expanded right sidebar retains top tabs when multiple surfaces are open.
- The plus button opens additional right-sidebar surfaces after the first surface exists.
- The tile-based “Open a Surface” launcher is removed.
- Selecting a file in Project Explorer opens or activates that file in the secondary pane while leaving Project Explorer active.
- Multiple open files appear as independent secondary-pane tabs.
- Right-sidebar tabs and secondary-pane tabs are independent state machines.
- Closing the final right-sidebar tab returns to the visible icon rail.
- Hiding the entire right sidebar remains separate from closing its final tab.
- Closing the final secondary-pane tab returns the workspace to chat-only mode.
- Browser, diff, pull-request, agents, remote, and thread-scoped right-sidebar flows remain supported.
- Terminal remains supported in the bottom dock and is no longer represented by right-sidebar state, tabs, icons, or the plus menu.
- The terminal drawer toolbar has a separate X action beside the trash action; it collapses the drawer without closing the active terminal session.
- The primary/secondary split begins at the top of the workspace, so the chat header actions move left with the primary pane instead of sitting above both panes.
- At the compact breakpoint, the secondary pane stacks below the chat pane instead of remaining in a horizontal split.
- Secondary-pane fullscreen collapses the primary pane while preserving the secondary header and its controls; right-sidebar fullscreen is no longer exposed.
- The terminal-drawer and right-sidebar toggles remain at the far-right edge of whichever active surface owns them; when both side surfaces are open, the right-sidebar header takes priority.
- Pull Requests keeps its expanded tabbed right-panel presentation.
- State remains scoped to the appropriate thread and environment.

## Terminology

- **Navigation sidebar:** The left project and thread navigation.
- **Workspace:** The central area containing chat and the optional secondary pane.
- **Chat pane:** The primary conversation and composer area.
- **Secondary pane:** The workspace pane for editor and file-viewer surfaces.
- **Right sidebar:** The side area containing the icon rail or an expanded surface view.
- **Project Explorer:** The right-sidebar surface that browses project files.
- **Right-sidebar surface:** A browser, explorer, diff, pull request, agents, or other surface opened in the right sidebar. Terminal is a bottom-dock surface.

## Completed implementation map

### State models

- [x] Added `apps/web/src/secondaryPaneStore.ts` with thread/environment-scoped file surfaces, stable persistence, malformed-state sanitization, path deduplication, line-reveal request IDs, activation, close/close-other/close-to-right/close-all operations, workspace reconciliation, and thread removal.
- [x] Updated `apps/web/src/rightPanelStore.ts` and tests for the version-13 migration, including dropping legacy terminal surfaces.
- [x] Legacy right-panel file surfaces are discarded during migration. An empty but visible right sidebar now represents rail mode.
- [x] Final right-sidebar close actions preserve sidebar visibility and return to the rail. Explicit sidebar hide remains a separate action.

### File surfaces

- [x] Added `ProjectExplorerPanel.tsx` around `FileBrowserPanel`, with an explicit `onOpenFile(relativePath)` callback.
- [x] Removed the editor/tree composition from the right-sidebar file surface.
- [x] Added the `FileEditorPanel.tsx` production boundary while preserving the existing file query, markdown/image rendering, Pierre editor, comments, save coordinator, dirty state, and line-reveal behavior.
- [x] Kept `FilePreviewPanel.tsx` as the compatibility implementation so existing helper coverage and behavior remain stable.

### Secondary pane

- [x] Added `SecondaryPaneShell.tsx` as a workspace sibling using the existing resizable shell.
- [x] Added `SecondaryPaneTabs.tsx` with active-tab selection, close buttons, keyboard-accessible tabs, path tooltips, and context-menu actions for copy path, close, close others, close to right, and close all.
- [x] Only the active editor surface is mounted.
- [x] Added persisted secondary width and pure layout helpers in `workspacePaneLayout.ts`.
- [x] Added narrow-screen stacking behavior for the secondary pane, including the parent workspace flex direction.

### Entry points and shell composition

- [x] Migrated `ChatMarkdown.tsx`, `ProjectContentSearchDialog.tsx`, `ProjectFilePicker.tsx`, `diffFileActions.ts`, and ChatView/agent file-link handling to the secondary-pane action.
- [x] Integrated secondary-pane subscriptions and rendering into `ChatView.tsx` without moving server, provider, or contract logic.
- [x] Kept the chat timeline, composer, terminal drawer, thread selection, and pending-work behavior in the existing shell.
- [x] Ensured explorer selection opens the editor without changing the active right-sidebar tab.
- [x] Ensured editor-tab changes do not change right-sidebar state.

### Right-sidebar rail and expanded mode

- [x] Added the shared surface-action registry in `rightPanelSurfaceActions.tsx`.
- [x] Added `RightPanelRail.tsx` with vertical icon buttons, accessible labels, tooltips, shortcuts, disabled-state explanations, and live-agent badges.
- [x] Updated `RightPanelTabs.tsx` and `RightPanelSheet.tsx` so an empty chat right sidebar renders the rail and a populated sidebar renders the expanded tabbed view.
- [x] Removed terminal from right-sidebar surface actions, tabs, icons, callbacks, persistence, and keyboard routing; terminal split/new/close behavior stays in the bottom-dock path.
- [x] Preserved the plus menu for adding another surface after the first surface is open.
- [x] Preserved Pull Requests’ tabbed presentation through its explicit presentation mode.
- [x] Updated layout controls and titlebar behavior for rail, expanded right sidebar, secondary pane, and chat-only states.
- [x] Made the empty inline rail begin below the shared workspace header; sheet rails use the same header-height offset.
- [x] Kept the rail dedicated to surface-launch icons; the right-sidebar and terminal-drawer toggles remain header-owned in every layout.
- [x] Matched the right-sidebar toggle to the rail icon-box geometry while keeping the terminal-drawer toggle compact and matching only the shared header spacing.
- [x] Normalized the right-side header inset across chat-only, secondary-pane, and expanded-sidebar control owners so the toggle cluster stays anchored to the same edge position.
- [x] Matched the active right-sidebar tab-bar control inset to the rail’s 6px edge anchor, including the native-titlebar overlay calculation, so File Explorer, Pull Requests, Agents, and other active surfaces do not shift the controls left.
- [x] When an inline rail is visible, extended the owning primary or secondary header across the rail column and aligned the right-sidebar toggle with the rail icon centerline.
- [x] Grouped the main chat header pills, secondary-pane actions, fullscreen control, terminal toggle, and right-sidebar toggle with one consistent right-aligned gap treatment.
- [x] Kept header-owned right controls on the same 6px right anchor when the icon rail is visible or collapsed, including the Electron Window Controls Overlay path; left padding and unrelated headers remain unchanged.
- [x] Moved secondary-pane tabs into the top header and added its theme-consistent Open With and fullscreen controls.
- [x] Centralized toggle placement so controls do not duplicate or remain over the primary pane when the right sidebar or secondary pane owns the far-right header.

### Documentation

- [x] Added `docs/user/workspace-panes.md`.
- [x] Updated `docs/user/keybindings.md`, `docs/user/source-control.md`, and `docs/README.md`.
- [x] Kept user documentation in shipped-product language without internal source paths or repository tooling.

## Verification completed

- [x] Focused web tests passed: 9 test files, 96 tests.
- [x] `vp run --filter web typecheck` passed.
- [x] Targeted lint passed for changed files.
- [x] Commit-hook formatting completed successfully.
- [x] `git diff --check` passed.
- [x] Follow-up focused tests passed: 5 test files, 60 tests.
- [x] Follow-up web typecheck passed with `vp run --filter @t3tools/web typecheck`.
- [x] Terminal drawer regression test passed for the distinct collapse-action label contract.
- [x] Latest rail/control follow-up passed focused web tests: 7 test files, 81 tests.
- [x] Latest rail/control follow-up passed web typecheck, targeted lint, formatting, and `git diff --check`.
- [x] Corrected rail/control ownership after review: no panel toggle is rendered at the bottom of the rail.
- [x] Added the reviewed rail-center alignment contract for both primary-header and secondary-header ownership.
- [x] Added pure workspace layout-state coverage for fixed right-inset precedence and compact stacked-pane direction.
- [x] Reviewed active RightPanelTabs control alignment against the shared rail edge anchor.
- [x] Completed standards and specification reviews; corrected the compact stacked-layout gap and removed static-markup-only UI assertions before the final validation pass.
- [x] Final pre-merge validation passed: 10 focused test files, 105 tests, web typecheck, targeted lint, formatting, `git diff --check`, no tagged debug instrumentation, and a production web build.
- [x] The implementation was reviewed for accidental server, mobile, provider, contract, and unrelated navigation changes.
- [x] Mobile remains intentionally unchanged; web and desktop use the shared web implementation.

Focused test command:

```bash
vp test run apps/web/src/components/right-panel/rightPanelSurfaceActions.test.ts \
  apps/web/src/secondaryPaneStore.test.ts \
  apps/web/src/rightPanelStore.test.ts \
  apps/web/src/workspacePaneLayout.test.ts \
  apps/web/src/components/RightPanelTabs.test.tsx \
  apps/web/src/components/preview/PreviewPanelShell.test.ts \
  apps/web/src/components/files/FilePreviewPanel.test.ts \
  apps/web/src/diffFileActions.test.ts \
  apps/web/src/components/chat/PanelLayoutControls.test.tsx
```

## Remaining work

### Targeted integrated client verification

- [x] Run an integrated browser pass in the approved isolated web environment.
- [x] Verify a fresh chat starts with the rail, not Project Explorer or the old tile launcher.
- [x] Verify the rail exposes the surface buttons with accessible labels and keyboard shortcuts; the shared theme-aware tooltip implementation is present on each button.
- [x] Verify the right-sidebar plus menu opens a second surface and preserves independent tabs.
- [x] Verify Project Explorer opens files into the secondary pane and remains selected in the right sidebar.
- [x] Verify the secondary pane tab bar, Open With controls, fullscreen toggle, and final-tab close behavior.
- [x] Verify the terminal remains a bottom drawer, exposes the separate close/collapse X beside the terminal close action, and collapses cleanly.
- [x] Verify expanded sidebar, icon rail, sheet, narrow-screen stacked panes, and the far-right control ownership states.
- [x] Verify the 6px edge-anchor geometry at 1280px in chat-only rail mode and with an active right-sidebar surface.
- [x] Fixes found during the pass were limited to the test environment; the final shared endpoint loaded successfully and no application error occurred after reload.
- [x] Optional accessibility follow-up: implemented an explicit sheet-popup initial-focus target so opening the narrow right-sidebar sheet moves focus out of the composer before Base UI isolates the workspace.
- [x] Validated focused-composer narrow-sheet interaction in a real isolated client using Parallel Browser MCP. Its fixed 1280px viewport required forcing the same `(max-width: 980px)` media-query branch; after opening the real sheet, focus was inside `[data-slot="sheet-popup"]` and captured console warnings contained no blocked-`aria-hidden` message.

### Optional narrow-sheet focus fix

**Goal:** ensure that opening the narrow right-sidebar sheet moves keyboard focus into the modal before Base UI hides the workspace from assistive technology.

**Exact source changes:**

1. [x] Modify `apps/web/src/components/ui/sheet.tsx`.
   - Convert `SheetPopup` from a plain function component to `React.forwardRef<HTMLDivElement, SheetPrimitive.Popup.Props & SheetPopupOptions>`.
   - Pass the forwarded ref to the underlying `SheetPrimitive.Popup`.
   - Do not change the shared sheet's visual classes, `modal` behavior, backdrop, transition, or default focus policy.

2. [x] Modify `apps/web/src/components/RightPanelSheet.tsx`.
   - Import `useRef` and create `const popupRef = useRef<HTMLDivElement>(null)`.
   - Attach `ref={popupRef}` to its `SheetPopup`.
   - Pass `initialFocus={popupRef}` to that `SheetPopup`. Base UI already makes its popup programmatically focusable, so this moves focus to the sheet container rather than leaving it in the chat composer while the workspace becomes `aria-hidden`.
   - Do not change `ChatView.tsx`, right-panel state, sheet width/rail offset, escape/backdrop close behavior, or the return-focus policy.

3. [x] Validate in the isolated web client at a narrow viewport.
   - Focus the chat composer, open the right-sidebar rail and then an expanded surface.
   - Confirm `document.activeElement` is inside `[data-slot="sheet-popup"]` immediately after opening.
   - Confirm the browser no longer emits the blocked-`aria-hidden` warning, keyboard Tab remains within the sheet, and Escape/backdrop close behavior is unchanged.
   - Run focused web typecheck and lint for the two modified files plus `git diff --check`.

**Why this scope:** the warning comes from the modal sheet's focus timing, not from layout or right-panel state. The explicit popup focus fixes that timing without weakening the modal's screen-reader isolation or changing every sheet in the app.

Additional breadth not exercised in this pass (not a redesign blocker):

- [ ] Exercise chat links, search, file picker, diff actions, multiple editor tabs, Pull Requests, remote connections, and thread switching in a future workflow pass.

### Optional polish, not a functional blocker

- [ ] Physically move the full implementation from `FilePreviewPanel.tsx` into `FileEditorPanel.tsx`, leaving `FilePreviewPanel.tsx` as the compatibility re-export. The current production boundary already has the requested behavior.
- [ ] Add a real interaction test for `SecondaryPaneShell`/`SecondaryPaneTabs` and the rail if the test environment can exercise those interactions without relying on static markup assertions.

## Constraints and scope

- Do not change server contracts, provider adapters, or mobile navigation as part of this redesign.
- Reuse the existing file-loading, remote filesystem, editor, comments, save, markdown, image, and line-reveal infrastructure.
- Do not mount inactive editors or add continuously repainting animations.
- Preserve right-sidebar width persistence separately from secondary-pane width persistence.
- Keep thread/environment reconciliation and remote connection behavior intact.
- Use focused checks only; repository-wide checks remain CI’s responsibility.

## Handoff

The implementation and targeted integrated client pass are complete. The follow-up source changes are currently uncommitted; this plan remains an uncommitted work artifact by repository convention.
