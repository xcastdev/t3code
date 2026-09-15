import { describe, expect, it } from "vite-plus/test";
import type { ProjectScript } from "@t3tools/contracts";
import {
  initialProjectActionSelection,
  resolveProjectActionSelection,
} from "./projectActionSelection";

const scripts: readonly ProjectScript[] = [
  { id: "dev", name: "Dev", command: "vp dev", icon: "play", runOnWorktreeCreate: false },
  { id: "test", name: "Test", command: "vp test", icon: "test", runOnWorktreeCreate: false },
];

describe("project action selection", () => {
  it("uses preferred, then primary, then Add", () => {
    expect(initialProjectActionSelection(scripts, "test")).toEqual({
      kind: "script",
      scriptId: "test",
    });
    expect(initialProjectActionSelection(scripts, "missing")).toEqual({
      kind: "script",
      scriptId: "dev",
    });
    expect(initialProjectActionSelection([], null)).toEqual({ kind: "add" });
  });
  it("replaces a stale selected script with the current primary", () => {
    expect(
      resolveProjectActionSelection(scripts, null, { kind: "script", scriptId: "gone" }),
    ).toEqual({ kind: "script", scriptId: "dev" });
  });
});
