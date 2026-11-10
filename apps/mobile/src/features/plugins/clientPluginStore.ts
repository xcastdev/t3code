import {
  createClientPluginStore,
  type ClientPluginPanelState,
  type ClientPluginRecord,
} from "@t3tools/client-runtime/plugins/client-packages";
import { Directory, File, Paths } from "expo-file-system";

import { writeFileAtomically } from "../../lib/atomic-file";

const RECORD_FILE = "record.json";
const STATE_SUFFIX = ".json";

const packagesRoot = () => new Directory(Paths.document, "plugins");
const stateRoot = () => new Directory(Paths.document, "plugin-state");
const stateFile = (key: string) =>
  new File(stateRoot(), `${encodeURIComponent(key)}${STATE_SUFFIX}`);

const subdirectories = (directory: Directory) =>
  directory.exists
    ? directory.list().filter((entry): entry is Directory => entry instanceof Directory)
    : [];

async function readJson<A>(file: File): Promise<A | null> {
  if (!file.exists) return null;
  return JSON.parse(await file.text()) as A;
}

// Each package lives at plugins/<id>/<version>/record.json; an install removes other versions.
async function readPackage(pluginDirectory: Directory): Promise<ClientPluginRecord | null> {
  for (const versionDirectory of subdirectories(pluginDirectory)) {
    const record = await readJson<ClientPluginRecord>(new File(versionDirectory, RECORD_FILE));
    if (record !== null) return record;
  }
  return null;
}

export const clientPluginStore = createClientPluginStore({
  listPackages: async () => {
    const records: ClientPluginRecord[] = [];
    for (const pluginDirectory of subdirectories(packagesRoot())) {
      const record = await readPackage(pluginDirectory);
      if (record !== null) records.push(record);
    }
    return records;
  },
  getPackage: (pluginId) => readPackage(new Directory(packagesRoot(), pluginId)),
  putPackage: async (record) => {
    const pluginDirectory = new Directory(packagesRoot(), record.pluginId);
    const versionDirectory = new Directory(pluginDirectory, record.version);
    versionDirectory.create({ idempotent: true, intermediates: true });
    await writeFileAtomically(new File(versionDirectory, RECORD_FILE), JSON.stringify(record));
    for (const other of subdirectories(pluginDirectory)) {
      if (other.name !== record.version) other.delete();
    }
  },
  deletePackage: async (pluginId) => {
    const pluginDirectory = new Directory(packagesRoot(), pluginId);
    if (pluginDirectory.exists) pluginDirectory.delete();
  },
  listStateKeys: async () => {
    const root = stateRoot();
    if (!root.exists) return [];
    return root
      .list()
      .filter((entry): entry is File => entry instanceof File && entry.name.endsWith(STATE_SUFFIX))
      .map((entry) => decodeURIComponent(entry.name.slice(0, -STATE_SUFFIX.length)));
  },
  getState: (key) => readJson<ClientPluginPanelState>(stateFile(key)),
  putState: async (key, state) => {
    stateRoot().create({ idempotent: true, intermediates: true });
    await writeFileAtomically(stateFile(key), JSON.stringify(state));
  },
  deleteState: async (key) => {
    const file = stateFile(key);
    if (file.exists) file.delete();
  },
});
