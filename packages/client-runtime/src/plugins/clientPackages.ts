import type { PluginId, PluginManifest } from "@t3tools/contracts";
import { decodePluginManifest, isHostApiCompatible } from "@t3tools/shared/pluginManifest";
import * as Result from "effect/Result";

import { ARCHIVE_ENTRY_MAX_BYTES, ARCHIVE_MAX_BYTES, boundedZip } from "../zip/boundedZip.ts";
import { parsePluginPanelKey, type PluginPanelKey, type PluginPanelScope } from "./commands.ts";

const MANIFEST_FILE = "t3-plugin.json";
const MAX_PANEL_HTML_BYTES = 5 * 1024 * 1024;

export interface ClientPluginRecord {
  readonly pluginId: PluginId;
  readonly version: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly manifest: PluginManifest;
  /** Self-contained panel HTML keyed by panel id. */
  readonly panelHtml: Readonly<Record<string, string>>;
}

export interface ClientPluginPanelState {
  readonly value: unknown;
  /** The plugin version whose UI wrote this value. */
  readonly version: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

const decodeText = (bytes: Uint8Array, path: string): string => {
  try {
    return utf8.decode(bytes);
  } catch (cause) {
    throw new Error(`${path} is not UTF-8 text.`, { cause });
  }
};

async function readArchive(bytes: ArrayBuffer) {
  if (bytes.byteLength > ARCHIVE_MAX_BYTES) {
    throw new Error("A plugin package must be smaller than 50 MiB.");
  }
  let files: Awaited<ReturnType<typeof boundedZip>>;
  try {
    files = await boundedZip(bytes, ARCHIVE_ENTRY_MAX_BYTES);
  } catch (cause) {
    throw new Error("This file is not a valid T3 Code plugin package.", { cause });
  }

  const manifestFile = files.get(MANIFEST_FILE);
  if (manifestFile === undefined || manifestFile.directory) {
    throw new Error(`This plugin package has no ${MANIFEST_FILE} at its root.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(decodeText(manifestFile.bytes, MANIFEST_FILE));
  } catch (cause) {
    throw new Error(`${MANIFEST_FILE} is not valid JSON.`, { cause });
  }
  const decoded = decodePluginManifest(json);
  if (Result.isFailure(decoded)) throw new Error(decoded.failure);
  return { files, manifest: decoded.success };
}

/** The validated manifest of any package, so a host can describe it before uploading it. */
export async function readPluginArchiveManifest(bytes: ArrayBuffer): Promise<PluginManifest> {
  return (await readArchive(bytes)).manifest;
}

export async function readClientPluginArchive(bytes: ArrayBuffer): Promise<ClientPluginRecord> {
  const { files, manifest } = await readArchive(bytes);

  if (manifest.backend !== undefined) {
    throw new Error(
      `${manifest.name} has a backend, so it cannot be installed on this device alone. Install this plugin into an environment.`,
    );
  }
  if (!isHostApiCompatible(manifest.hostApi)) {
    throw new Error(
      `${manifest.name} needs host API ${manifest.hostApi}, which needs a newer or different version of T3 Code.`,
    );
  }
  const panels = manifest.ui?.panels ?? [];
  if (panels.length === 0) throw new Error(`${manifest.name} has no panels to show.`);

  const panelHtml: Record<string, string> = {};
  for (const panel of panels) {
    const file = files.get(panel.entry);
    if (file === undefined || file.directory) throw new Error(`${panel.entry} is missing.`);
    if (file.bytes.byteLength > MAX_PANEL_HTML_BYTES) {
      throw new Error(`${panel.entry} is larger than 5 MiB.`);
    }
    panelHtml[panel.id] = decodeText(file.bytes, panel.entry);
  }

  return {
    pluginId: manifest.id,
    version: manifest.version,
    name: manifest.name,
    enabled: true,
    manifest,
    panelHtml,
  };
}

/** Platform persistence for client-only plugins. Packages are keyed by plugin id. */
export interface ClientPluginStorage {
  readonly listPackages: () => Promise<ReadonlyArray<ClientPluginRecord>>;
  readonly getPackage: (pluginId: string) => Promise<ClientPluginRecord | null>;
  readonly putPackage: (record: ClientPluginRecord) => Promise<void>;
  readonly deletePackage: (pluginId: string) => Promise<void>;
  readonly listStateKeys: () => Promise<ReadonlyArray<string>>;
  readonly getState: (key: string) => Promise<ClientPluginPanelState | null>;
  readonly putState: (key: string, state: ClientPluginPanelState) => Promise<void>;
  readonly deleteState: (key: string) => Promise<void>;
}

export interface ClientPluginStore {
  readonly list: () => Promise<ReadonlyArray<ClientPluginRecord>>;
  /** Replaces an installed package with the same id, keeping its enabled flag and panel state. */
  readonly install: (bytes: ArrayBuffer) => Promise<ClientPluginRecord>;
  readonly setEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
  /** Removes the package and keeps its panel state. */
  readonly uninstall: (pluginId: string) => Promise<void>;
  /** Deletes this device's panel state for the plugin in one scope, by default its client install. */
  readonly deleteData: (pluginId: string, scope?: PluginPanelScope) => Promise<void>;
  /** The plugins this device holds panel state for, one entry per scope. */
  readonly listStateOwners: () => Promise<
    ReadonlyArray<{ readonly scope: PluginPanelScope; readonly pluginId: PluginId }>
  >;
  readonly readState: (panelKey: PluginPanelKey) => Promise<ClientPluginPanelState | null>;
  readonly writeState: (panelKey: PluginPanelKey, value: unknown, version: string) => Promise<void>;
}

export function createClientPluginStore(storage: ClientPluginStorage): ClientPluginStore {
  return {
    list: storage.listPackages,
    install: async (bytes) => {
      const record = await readClientPluginArchive(bytes);
      const installed = await storage.getPackage(record.pluginId);
      const next = installed === null ? record : { ...record, enabled: installed.enabled };
      await storage.putPackage(next);
      return next;
    },
    setEnabled: async (pluginId, enabled) => {
      const installed = await storage.getPackage(pluginId);
      if (installed === null || installed.enabled === enabled) return;
      await storage.putPackage({ ...installed, enabled });
    },
    uninstall: storage.deletePackage,
    deleteData: async (pluginId, scope = "client") => {
      for (const key of await storage.listStateKeys()) {
        const parsed = parsePluginPanelKey(key);
        if (parsed?.scope === scope && parsed.pluginId === pluginId) {
          await storage.deleteState(key);
        }
      }
    },
    listStateOwners: async () => {
      const owners = new Map<string, { scope: PluginPanelScope; pluginId: PluginId }>();
      for (const key of await storage.listStateKeys()) {
        const parsed = parsePluginPanelKey(key);
        if (parsed !== undefined) {
          owners.set(`${parsed.scope}:${parsed.pluginId}`, {
            scope: parsed.scope,
            pluginId: parsed.pluginId,
          });
        }
      }
      return [...owners.values()];
    },
    readState: storage.getState,
    writeState: (panelKey, value, version) => storage.putState(panelKey, { value, version }),
  };
}
