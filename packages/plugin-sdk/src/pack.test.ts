// @effect-diagnostics nodeBuiltinImport:off - Packs fixture plugins on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";

import { packPlugin } from "./pack.ts";
import { extractPluginArchive, startPackedBackend } from "./testing.ts";

const ECHO_DIR = NodePath.join(import.meta.dirname, "testFixtures", "echo");

const tempDir = (prefix: string) =>
  NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), `plugin-sdk-${prefix}-`));

const BACKEND_MANIFEST = {
  manifestVersion: 1,
  id: "fixture",
  name: "Fixture",
  version: "1.0.0",
  hostApi: "1.0",
  author: "T3 Tools",
  backend: {
    entry: "backend/index.cjs",
    operations: [],
    topics: [],
    resources: [],
    prerequisites: [],
  },
  capabilities: [],
};

const PANEL_MANIFEST = {
  manifestVersion: 1,
  id: "fixture",
  name: "Fixture",
  version: "1.0.0",
  hostApi: "1.0",
  author: "T3 Tools",
  ui: { panels: [{ id: "main", title: "Main", entry: "ui/main.html" }], commands: [] },
  capabilities: [],
};

const writeFixture = async (files: Record<string, string>) => {
  const dir = await tempDir("fixture");
  for (const [name, contents] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(dir, name)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(dir, name), contents);
  }
  return dir;
};

const packEcho = async () => {
  const out = NodePath.join(await tempDir("out"), "echo.t3plugin");
  await packPlugin(ECHO_DIR, out);
  return { out, zip: await JSZip.loadAsync(await NodeFSP.readFile(out)) };
};

const entryNames = (zip: JSZip) =>
  Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name)
    .toSorted();

describe("packPlugin", () => {
  it("refuses a panel HTML with a relative script src", async () => {
    const dir = await writeFixture({
      "t3-plugin.json": JSON.stringify(PANEL_MANIFEST),
      "ui/main.html": '<html><body><script src="./main.js"></script></body></html>',
    });
    await expect(packPlugin(dir, NodePath.join(dir, "out.t3plugin"))).rejects.toThrow(
      /relative reference "\.\/main\.js"/,
    );
  });

  it("refuses an invalid manifest with the decoder's message", async () => {
    const dir = await writeFixture({
      "t3-plugin.json": JSON.stringify({
        ...PANEL_MANIFEST,
        ui: {
          ...PANEL_MANIFEST.ui,
          commands: [{ id: "open", title: "Open", opens: { panel: "x" } }],
        },
      }),
      "ui/main.html": "<html><body></body></html>",
    });
    await expect(packPlugin(dir, NodePath.join(dir, "out.t3plugin"))).rejects.toThrow(
      'Invalid plugin manifest: command "open" opens undeclared panel "x"',
    );
  });

  it("produces a zip with t3-plugin.json at the root and inlined panel", async () => {
    const { zip } = await packEcho();
    const manifest = JSON.parse((await zip.file("t3-plugin.json")?.async("string")) ?? "null");
    expect(manifest).toMatchObject({ id: "echo", version: "0.1.0" });
    const html = (await zip.file("ui/echo.html")?.async("string")) ?? "";
    expect(html).toMatch(/<script>[\s\S]*t3\/initialize[\s\S]*<\/script>\s*<\/body>/);
  });

  it("bundles the echo backend, including @t3tools/plugin-sdk/backend, into one .cjs whose only requires are node builtins", async () => {
    const { zip } = await packEcho();
    expect(entryNames(zip)).toEqual(["backend/index.cjs", "t3-plugin.json", "ui/echo.html"]);
    const code = (await zip.file("backend/index.cjs")?.async("string")) ?? "";
    expect(code).toContain("definePluginBackend");
    const requires = [...code.matchAll(/\brequire\(\s*([^)]*?)\s*\)/g)].map((match) => match[1]);
    expect(requires.length).toBeGreaterThan(0);
    for (const specifier of requires) {
      expect(specifier).toMatch(/^"[^"]+"$/);
      expect(NodeModule.isBuiltin(JSON.parse(specifier ?? '""'))).toBe(true);
    }
  });

  it("refuses a backend that imports an unresolvable package", async () => {
    const dir = await writeFixture({
      "t3-plugin.json": JSON.stringify(BACKEND_MANIFEST),
      "backend/index.ts": 'import "definitely-not-a-package-t3";\n',
    });
    await expect(packPlugin(dir, NodePath.join(dir, "out.t3plugin"))).rejects.toThrow(
      /definitely-not-a-package-t3/,
    );
  });

  it("refuses a backend that requires a computed path", async () => {
    const dir = await writeFixture({
      "t3-plugin.json": JSON.stringify(BACKEND_MANIFEST),
      "backend/index.ts": "const name = process.argv[2] ?? 'x';\nrequire(name);\n",
    });
    await expect(packPlugin(dir, NodePath.join(dir, "out.t3plugin"))).rejects.toThrow(
      /loads a computed path through require \(at `.*require\(name\)/,
    );
  });

  it.each([
    [
      'import { createRequire } from "node:module";\ncreateRequire(__filename)("x");\n',
      /node:module/,
    ],
    ['const r = require;\nr("x");\n', /require other than as a direct call/],
    ['(module as any).constructor._load("x");\n', /_load/],
    ['process.dlopen({ exports: {} }, "/tmp/x.node");\n', /dlopen/],
    ['typeof require("node:module");\n', /node:module/],
    ["typeof require(process.argv[2] ?? 'x');\n", /computed path/],
    ['typeof require.call(null, "node:fs");\n', /require\.call/],
    ['require.main?.require("x");\n', /require\.main\.require/],
    ['process.mainModule?.require?.(process.argv[2] ?? "x");\n', /computed path/],
    ['(process as any).getBuiltinModule("node:" + "module");\n', /node:module/],
    ['(globalThis as any).process.dlopen({ exports: {} }, "/tmp/x.node");\n', /dlopen/],
    ['void import(process.argv[2] ?? "x");\n', /computed path/],
  ])("refuses a backend bundle that reaches a module loader: %s", async (source, message) => {
    const dir = await writeFixture({
      "t3-plugin.json": JSON.stringify(BACKEND_MANIFEST),
      "backend/index.ts": source,
    });
    await expect(packPlugin(dir, NodePath.join(dir, "out.t3plugin"))).rejects.toThrow(message);
  });

  it("allows require, module and loader names inside strings and comments", async () => {
    const dir = await writeFixture({
      "t3-plugin.json": JSON.stringify(BACKEND_MANIFEST),
      "backend/index.ts":
        'import * as fs from "node:fs";\n// require("x") module.constructor._load\nconsole.log(fs.constants, "require(name) createRequire process.dlopen", typeof require, typeof module);\n',
    });
    await expect(packPlugin(dir, NodePath.join(dir, "out.t3plugin"))).resolves.toBeUndefined();
  });

  it("allows loader-named properties and require uses that load nothing", async () => {
    const dir = await writeFixture({
      "t3-plugin.json": JSON.stringify(BACKEND_MANIFEST),
      "backend/index.ts": [
        "class Store { _load() { return { dlopen: 1, mainModule: 2, createRequire: 3 }; } }",
        'const hooks = (process as any).mainModule?.require?.("node:async_hooks");',
        "if (require.main === module) console.log(new Store()._load(), hooks);",
        'console.log(require.resolve("node:fs"), process.env["HOME"], (process as any).mainModule?.filename);',
      ].join("\n"),
    });
    await expect(packPlugin(dir, NodePath.join(dir, "out.t3plugin"))).resolves.toBeUndefined();
  });

  it("embeds an imported .txt asset in the .cjs, and the archive lists exactly the manifest, panel HTML, and backend entry", async () => {
    const { out, zip } = await packEcho();
    expect(entryNames(zip)).toEqual(["backend/index.cjs", "t3-plugin.json", "ui/echo.html"]);
    const code = (await zip.file("backend/index.cjs")?.async("string")) ?? "";
    expect(code).toContain("Hello from the echo plugin.");

    const installed = await tempDir("installed");
    await extractPluginArchive(out, installed);
    const dataDir = await tempDir("data");
    const backend = startPackedBackend({
      entryPath: NodePath.join(installed, "backend", "index.cjs"),
      dataDir,
      pluginId: "echo",
      version: "0.1.0",
    });
    try {
      await backend.initialize();
      const result = await backend.invoke("asset", {}).result;
      expect(result).toEqual({
        path: expect.stringContaining(NodePath.join(dataDir, "runtime")),
        text: "Hello from the echo plugin.\n",
      });
    } finally {
      await backend.close();
    }
  });
});
