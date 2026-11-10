// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  requiredGuards,
  replaceOnce,
  transformNativeModule,
  verifyInstallation,
} from "./compatibility.ts";

const root = NodePath.dirname(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"))),
);
describe("reviewed OMP source-bearing 18.16.0 / Bun 1.4.4 recipe", () => {
  it("verifies the pinned distribution and every unique native transformation", () => {
    verifyInstallation(root, "1.4.4");
    expect(requiredGuards).toHaveLength(15);
    expect(requiredGuards).toContain("extensibility/tool-proxy.ts");
    expect(requiredGuards).toContain("tools/output-meta.ts");
    for (const name of requiredGuards) {
      const source = NodeFS.readFileSync(NodePath.join(root, "src", name), "utf8");
      const result = transformNativeModule(name, source, "file:///t3/hooks.ts");
      expect(result).toContain(`t3.acknowledge(${JSON.stringify(name)})`);
      expect(() => transformNativeModule(name, source + "\n", "file:///t3/hooks.ts")).toThrow(
        /fingerprint/,
      );
    }
  });
  it("fails on unknown runtimes, missing layout, hashes and ambiguous anchors", () => {
    expect(() => verifyInstallation(root, "1.4.5")).toThrow(/runtime/);
    expect(() => verifyInstallation(NodePath.join(root, "dist"), "1.4.4")).toThrow();
    expect(() => transformNativeModule("other.ts", "", "hooks")).toThrow(/fingerprint/);
    expect(() => replaceOnce("aa aa", "aa", "b")).toThrow(/count/);
    expect(() => replaceOnce("bb", "aa", "b")).toThrow(/count/);
  });
});
