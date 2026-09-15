/* @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProjectScript, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

vi.mock("./projectScriptEditor", () => ({
  EMPTY_PROJECT_SCRIPT_INPUT: {
    name: "",
    command: "",
    icon: "play",
    runOnWorktreeCreate: false,
    waitForSetup: false,
    keybinding: null,
    previewUrl: null,
    autoOpenPreview: false,
  },
  editorRequestForScript: (script: ProjectScript) => ({
    scriptId: script.id,
    initial: { name: script.name, command: script.command },
  }),
  ProjectScriptEditorDialog: ({ request }: { request: { scriptId: string | null } | null }) =>
    request ? (
      <dialog open data-script-id={request.scriptId ?? "add"}>
        {request.scriptId === null ? "Add action editor" : "Edit action editor"}
      </dialog>
    ) : null,
  ScriptIcon: ({ icon }: { icon: string }) => <span data-script-icon={icon} />,
}));

import ProjectScriptsControl from "./ProjectScriptsControl";

const scripts: readonly ProjectScript[] = [
  { id: "dev", name: "Dev", command: "vp dev", icon: "play", runOnWorktreeCreate: false },
  { id: "test", name: "Test", command: "vp test", icon: "test", runOnWorktreeCreate: false },
];

const nextScripts: readonly ProjectScript[] = [
  { id: "build", name: "Build", command: "vp build", icon: "play", runOnWorktreeCreate: false },
  { id: "test", name: "Test", command: "vp test", icon: "test", runOnWorktreeCreate: false },
];

const keybindings = DEFAULT_RESOLVED_KEYBINDINGS as ResolvedKeybindingsConfig;
const roots: Root[] = [];
const unusedAddScript = async (_input: unknown): Promise<never> => {
  throw new Error("unexpected script mutation");
};
const unusedUpdateScript = async (_scriptId: unknown, _input: unknown): Promise<never> => {
  throw new Error("unexpected script mutation");
};
const unusedDeleteScript = async (_scriptId: unknown): Promise<never> => {
  throw new Error("unexpected script mutation");
};

function control(overrides: Partial<React.ComponentProps<typeof ProjectScriptsControl>> = {}) {
  return (
    <ProjectScriptsControl
      scripts={scripts}
      selectionKey="project-a"
      keybindings={keybindings}
      onRunScript={() => undefined}
      onAddScript={unusedAddScript}
      onUpdateScript={unusedUpdateScript}
      onDeleteScript={unusedDeleteScript}
      split
      {...overrides}
    />
  );
}

async function mount(overrides: Partial<React.ComponentProps<typeof ProjectScriptsControl>> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(control(overrides)));
  return { container, root };
}

async function rerender(
  root: Root,
  overrides: Partial<React.ComponentProps<typeof ProjectScriptsControl>>,
) {
  await act(async () => root.render(control(overrides)));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  expect(found).toBeDefined();
  return found as HTMLButtonElement;
}

function menuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found as HTMLElement;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.replaceChildren();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("ProjectScriptsControl split actions", () => {
  it("closes the menu when Add action opens the editor", async () => {
    await mount();

    await click(button("Choose project action"));
    await click(menuItem("Add action"));

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(button("Choose project action").getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('dialog[data-script-id="add"]')).not.toBeNull();
  });

  it("closes the menu when Edit action opens the editor", async () => {
    await mount();

    await click(button("Choose project action"));
    await click(button("Edit Dev"));

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('dialog[data-script-id="dev"]')).not.toBeNull();
  });

  it("resets a selected action when the selection key changes", async () => {
    const { root } = await mount();

    await click(button("Choose project action"));
    await click(menuItem("Test"));
    expect(button("Run Test")).toBeDefined();

    await rerender(root, {
      scripts: nextScripts,
      selectionKey: "project-b",
      preferredScriptId: null,
    });

    expect(button("Run Build")).toBeDefined();
    expect(document.querySelector('button[aria-label="Run Test"]')).toBeNull();
  });
});
