/* @vitest-environment happy-dom */

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { FolderClosedIcon } from "lucide-react";

import { FileExplorerIcon, FinderIcon } from "../Icons";

const openInState = vi.hoisted(() => ({
  mode: "local-exec" as "local-exec" | "remote-links" | "remote-unavailable",
  host: "remote.example",
}));
const commands = vi.hoisted(() => ({
  openInEditor: vi.fn().mockResolvedValue({ _tag: "Success", value: undefined }),
  openRemoteEditorUrl: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../remoteOpen", () => ({
  openRemoteEditorUrl: commands.openRemoteEditorUrl,
  useRemoteCapableEditors: () => ["vscode"],
  useRemoteOpenHint: () => [false, vi.fn()],
  useRemoteOpenState: () =>
    openInState.mode === "remote-links"
      ? { mode: "remote-links", host: { host: openInState.host } }
      : { mode: openInState.mode },
}));
vi.mock("../../editorPreferences", () => ({
  usePreferredEditor: (available: readonly string[]) => [available[0] ?? null, vi.fn()],
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ label: "remote environment" }),
}));
vi.mock("../../state/shell", () => ({
  shellEnvironment: { openInEditor: Symbol("open-in-editor") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => commands.openInEditor,
}));

import {
  OpenInPicker,
  resolveOpenInOptions,
  resolveOpenInPickerPresentation,
} from "./OpenInPicker";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";

const environmentId = EnvironmentId.make("environment");
const roots: Root[] = [];
const baseProps = {
  environmentId,
  keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
  availableEditors: ["vscode"] as const,
  openInCwd: "/repo",
};

function picker(overrides: Partial<typeof baseProps & { menu: boolean }> = {}) {
  return createElement(OpenInPicker, { ...baseProps, ...overrides });
}

function embeddedPicker() {
  return createElement(
    Menu,
    { open: true },
    createElement(MenuTrigger, {
      render: createElement("button", { type: "button", "aria-label": "Open actions" }),
    }),
    createElement(MenuPopup, null, createElement(OpenInPicker, { ...baseProps, menu: true })),
  );
}

async function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
}

async function click(element: Element) {
  await act(async () => (element as HTMLElement).click());
}

function menuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll('[role="menuitem"]')].find((element) =>
    element.textContent?.trim().startsWith(label),
  );
  expect(found).toBeDefined();
  return found as HTMLElement;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.replaceChildren();
  openInState.mode = "local-exec";
  commands.openInEditor.mockClear();
  commands.openRemoteEditorUrl.mockClear();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("OpenInPicker rendered destinations", () => {
  it("opens the selected local editor destination from the standalone control", async () => {
    await mount(picker());

    await click(document.querySelector('button[aria-label="Choose editor"]')!);
    await click(menuItem("VS Code"));

    expect(commands.openInEditor).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", editor: "vscode" },
    });
  });

  it("renders remote editor destinations and opens them through the SSH link", async () => {
    openInState.mode = "remote-links";
    await mount(embeddedPicker());

    expect(menuItem("Open With")).toBeDefined();
    await click(menuItem("Open With"));
    expect(menuItem("VS Code")).toBeDefined();
    expect(menuItem("Opens over SSH. Needs your key on remote environment")).toBeDefined();

    await click(menuItem("VS Code"));

    expect(commands.openRemoteEditorUrl).toHaveBeenCalledWith(
      expect.stringContaining("remote.example"),
    );
    expect(commands.openInEditor).not.toHaveBeenCalled();
  });

  it("renders the unavailable SSH state without editor destinations", async () => {
    openInState.mode = "remote-unavailable";
    await mount(embeddedPicker());

    await click(menuItem("Open With"));
    const unavailable = menuItem("No SSH route to remote environment");
    expect(unavailable.getAttribute("data-disabled")).not.toBeNull();
    expect(
      document.querySelector(
        '[data-slot="menu-sub-content"] [role="menuitem"]:not([data-disabled])',
      ),
    ).toBeNull();
  });
});

describe("resolveOpenInPickerPresentation", () => {
  it("renders the Open With submenu when embedded in the project-actions menu", () => {
    expect(resolveOpenInPickerPresentation(true)).toBe("submenu");
  });

  it("renders the standalone editor control otherwise", () => {
    expect(resolveOpenInPickerPresentation(false)).toBe("toolbar");
  });
});

describe("resolveOpenInOptions", () => {
  it.each([
    ["MacIntel", "Finder", FinderIcon],
    ["Win32", "File Explorer", FileExplorerIcon],
    ["Linux x86_64", "Files", FolderClosedIcon],
  ] as const)("includes the file manager with its icon on %s", (platform, label, Icon) => {
    expect(resolveOpenInOptions(platform, ["cursor", "vscode", "file-manager"])).toEqual([
      expect.objectContaining({ value: "cursor", label: "Cursor" }),
      expect.objectContaining({ value: "vscode", label: "VS Code" }),
      expect.objectContaining({ value: "file-manager", label, Icon }),
    ]);
  });

  it("omits the file manager when unavailable or using remote editors", () => {
    expect(resolveOpenInOptions("MacIntel", ["vscode"])).toEqual([
      expect.objectContaining({ value: "vscode" }),
    ]);
    expect(resolveOpenInOptions("MacIntel", [])).toEqual([]);
  });
});
