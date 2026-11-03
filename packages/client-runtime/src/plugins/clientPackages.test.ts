import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";

import {
  createClientPluginStore,
  readClientPluginArchive,
  type ClientPluginRecord,
  type ClientPluginStorage,
} from "./clientPackages.ts";
import { pluginPanelKey } from "./commands.ts";
import { EnvironmentId, type PluginId } from "@t3tools/contracts";

const converterManifest = (overrides: Record<string, unknown> = {}) => ({
  manifestVersion: 1,
  id: "converter",
  name: "Converter",
  version: "0.1.0",
  hostApi: "1.0",
  author: "T3 Tools",
  ui: {
    panels: [{ id: "converter", title: "Converter", entry: "ui/converter.html" }],
    commands: [{ id: "open", title: "Open Converter", opens: { panel: "converter" } }],
  },
  capabilities: ["chat.attach"],
  ...overrides,
});

// Incompressible, so boundedZip's compression-ratio guard does not refuse it first.
const noise = (length: number) => {
  let seed = 1;
  let text = "";
  while (text.length < length) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    text += String.fromCharCode(33 + (seed % 90));
  }
  return text;
};

const PANEL_HTML = "<!doctype html><html><body><script>1</script></body></html>";

// Mirrors packPlugin's output: JSZip with DEFLATE, which also writes the `ui/` folder entry.
async function archive(
  manifest: unknown,
  files: Record<string, string> = { "ui/converter.html": PANEL_HTML },
): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("t3-plugin.json", JSON.stringify(manifest));
  for (const [path, contents] of Object.entries(files)) zip.file(path, contents);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function memoryStorage(): ClientPluginStorage & {
  readonly states: Map<string, { value: unknown; version: string }>;
} {
  const packages = new Map<string, ClientPluginRecord>();
  const states = new Map<string, { value: unknown; version: string }>();
  return {
    states,
    listPackages: async () => [...packages.values()],
    getPackage: async (pluginId) => packages.get(pluginId) ?? null,
    putPackage: async (record) => {
      packages.set(record.pluginId, record);
    },
    deletePackage: async (pluginId) => {
      packages.delete(pluginId);
    },
    listStateKeys: async () => [...states.keys()],
    getState: async (key) => states.get(key) ?? null,
    putState: async (key, state) => {
      states.set(key, state);
    },
    deleteState: async (key) => {
      states.delete(key);
    },
  };
}

describe("readClientPluginArchive", () => {
  it("loads the converter fixture", async () => {
    const record = await readClientPluginArchive(await archive(converterManifest()));
    expect(record).toMatchObject({
      pluginId: "converter",
      version: "0.1.0",
      name: "Converter",
      enabled: true,
      panelHtml: { converter: PANEL_HTML },
    });
    expect(record.manifest.ui?.commands[0]?.opens.panel).toBe("converter");
  });

  it('refuses archives with a backend entry ("Install this plugin into an environment")', async () => {
    const manifest = converterManifest({
      backend: {
        entry: "backend/index.cjs",
        operations: [],
        topics: [],
        resources: [],
        prerequisites: [],
      },
    });
    await expect(
      readClientPluginArchive(
        await archive(manifest, {
          "ui/converter.html": PANEL_HTML,
          "backend/index.cjs": "module.exports = {}",
        }),
      ),
    ).rejects.toThrow("Install this plugin into an environment");
  });

  it("refuses incompatible hostApi", async () => {
    await expect(
      readClientPluginArchive(await archive(converterManifest({ hostApi: "2.0" }))),
    ).rejects.toThrow("newer or different version of T3 Code");
  });

  it("refuses a panel html over 5 MiB", async () => {
    await expect(
      readClientPluginArchive(
        await archive(converterManifest(), {
          "ui/converter.html": noise(5 * 1024 * 1024 + 1),
        }),
      ),
    ).rejects.toThrow("ui/converter.html is larger than 5 MiB");
  });

  it("refuses an invalid manifest and a missing panel file", async () => {
    await expect(
      readClientPluginArchive(await archive(converterManifest({ id: "Bad Id" }))),
    ).rejects.toThrow("Invalid plugin manifest");
    await expect(readClientPluginArchive(await archive(converterManifest(), {}))).rejects.toThrow(
      "ui/converter.html is missing",
    );
  });
});

describe("createClientPluginStore", () => {
  it("installing a newer version of an installed id replaces it and keeps panelState", async () => {
    const storage = memoryStorage();
    const store = createClientPluginStore(storage);
    const key = pluginPanelKey("client", "converter" as PluginId, "converter");

    await store.install(await archive(converterManifest()));
    await store.setEnabled("converter", false);
    await store.writeState(key, { mode: "base64" }, "0.1.0");

    const updated = await store.install(await archive(converterManifest({ version: "0.2.0" })));
    expect(updated).toMatchObject({ version: "0.2.0", enabled: false });
    expect((await store.list()).map((record) => record.version)).toEqual(["0.2.0"]);
    expect(await store.readState(key)).toEqual({ value: { mode: "base64" }, version: "0.1.0" });

    await store.uninstall("converter");
    expect(await store.list()).toEqual([]);
    expect(await store.readState(key)).not.toBeNull();

    const environmentKey = pluginPanelKey(
      EnvironmentId.make("env-a"),
      "converter" as PluginId,
      "converter",
    );
    await store.writeState(environmentKey, { mode: "url" }, "0.1.0");
    expect(await store.listStateOwners()).toEqual([
      { scope: "client", pluginId: "converter" },
      { scope: "env-a", pluginId: "converter" },
    ]);
    await store.deleteData("converter");
    expect(await store.readState(key)).toBeNull();
    expect(await store.readState(environmentKey)).not.toBeNull();
    await store.deleteData("converter", EnvironmentId.make("env-a"));
    expect(await store.readState(environmentKey)).toBeNull();
    expect(await store.listStateOwners()).toEqual([]);
  });
});
