import type { ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  initialProjectActionSelection,
  projectActionMenuIntent,
  projectScriptForSelection,
  resolveProjectActionSelection,
  type ProjectActionSelection,
} from "./projectActionSelection";

const scripts: ReadonlyArray<ProjectScript> = [
  {
    id: "dev",
    name: "Dev",
    command: "pnpm dev",
    icon: "play",
    runOnWorktreeCreate: false,
  },
  {
    id: "test",
    name: "Test",
    command: "pnpm test",
    icon: "test",
    runOnWorktreeCreate: false,
  },
];

describe("project action selection", () => {
  it("starts with the preferred action and falls back to the primary action", () => {
    expect(initialProjectActionSelection(scripts, "test")).toEqual({
      kind: "script",
      scriptId: "test",
    });
    expect(initialProjectActionSelection(scripts, "missing")).toEqual({
      kind: "script",
      scriptId: "dev",
    });
  });

  it("uses Add action when the project has no actions", () => {
    const selection: ProjectActionSelection = initialProjectActionSelection([], null);

    expect(selection).toEqual({ kind: "add" });
    expect(projectScriptForSelection([], selection)).toBeNull();
  });

  it("resolves a chosen action without running it", () => {
    const selection: ProjectActionSelection = { kind: "script", scriptId: "test" };

    expect(projectScriptForSelection(scripts, selection)).toEqual(scripts[1]);
  });

  it("treats Add action as an editor command in the split menu", () => {
    expect(projectActionMenuIntent({ kind: "add" })).toEqual({ kind: "open-add-editor" });
  });

  it("falls back to the new primary action after an empty-project placeholder", () => {
    expect(resolveProjectActionSelection(scripts, null, { kind: "add" })).toEqual({
      kind: "script",
      scriptId: "dev",
    });
  });
});
