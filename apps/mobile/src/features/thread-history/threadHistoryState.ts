import AsyncStorage from "@react-native-async-storage/async-storage";
import { createThreadHistoryEnvironmentAtoms } from "@t3tools/client-runtime/state/thread-history";
import {
  makeHistoryOperationPersistence,
  type HistoryOperationPersistence,
} from "@t3tools/client-runtime/state/thread-history-storage";

import { connectionAtomRuntime } from "../../connection/runtime";
import { uuidv4 } from "../../lib/uuid";

const CLIENT_NAMESPACE_KEY = "t3code.thread-history.client-namespace";

const storage = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
  removeItem: (key: string) => AsyncStorage.removeItem(key),
};

/**
 * Resolved once per launch; a storage failure rejects hydration, which refuses every
 * history mutation rather than letting a retry identity be silently forgotten.
 */
function asyncStoragePersistence(): HistoryOperationPersistence {
  let resolving: Promise<HistoryOperationPersistence> | null = null;
  const resolve = () => {
    resolving ??= (async () => {
      let clientSessionId = await storage.getItem(CLIENT_NAMESPACE_KEY);
      if (!clientSessionId) {
        clientSessionId = uuidv4();
        await storage.setItem(CLIENT_NAMESPACE_KEY, clientSessionId);
      }
      return makeHistoryOperationPersistence({ clientSessionId, storage });
    })().catch((error: unknown) => {
      resolving = null;
      throw error;
    });
    return resolving;
  };
  return {
    load: async (target) => (await resolve()).load(target),
    save: async (target, record) => (await resolve()).save(target, record),
  };
}

export const threadHistoryEnvironment = createThreadHistoryEnvironmentAtoms(connectionAtomRuntime, {
  operationPersistence: asyncStoragePersistence(),
});
