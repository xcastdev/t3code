import {
  createClientPluginStore,
  type ClientPluginPanelState,
  type ClientPluginRecord,
} from "@t3tools/client-runtime/plugins/client-packages";

const DATABASE_NAME = "t3code-plugins";
const DATABASE_VERSION = 1;
const PACKAGES = "packages";
const PANEL_STATE = "panelState";
type StoreName = typeof PACKAGES | typeof PANEL_STATE;
let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      for (const name of [PACKAGES, PANEL_STATE]) {
        if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name);
        }
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => reject(new Error("Plugin storage is blocked.")));
  }));
}

function completed(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function withStore<A>(
  name: StoreName,
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<A> | void,
) {
  const transaction = (await openDatabase()).transaction(name, mode);
  const request = use(transaction.objectStore(name));
  await completed(transaction);
  return request?.result;
}

export const clientPluginStore = createClientPluginStore({
  listPackages: async () =>
    ((await withStore(PACKAGES, "readonly", (store) => store.getAll())) ??
      []) as ReadonlyArray<ClientPluginRecord>,
  getPackage: async (pluginId) =>
    ((await withStore(PACKAGES, "readonly", (store) => store.get(pluginId))) ??
      null) as ClientPluginRecord | null,
  putPackage: async (record) => {
    await withStore(PACKAGES, "readwrite", (store) => store.put(record, record.pluginId));
  },
  deletePackage: async (pluginId) => {
    await withStore(PACKAGES, "readwrite", (store) => store.delete(pluginId));
  },
  listStateKeys: async () =>
    ((await withStore(PANEL_STATE, "readonly", (store) => store.getAllKeys())) ?? []).filter(
      (key): key is string => typeof key === "string",
    ),
  getState: async (key) =>
    ((await withStore(PANEL_STATE, "readonly", (store) => store.get(key))) ??
      null) as ClientPluginPanelState | null,
  putState: async (key, state) => {
    await withStore(PANEL_STATE, "readwrite", (store) => store.put(state, key));
  },
  deleteState: async (key) => {
    await withStore(PANEL_STATE, "readwrite", (store) => store.delete(key));
  },
});
