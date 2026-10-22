import { createThreadHistoryEnvironmentAtoms } from "@t3tools/client-runtime/state/thread-history";
import {
  makeHistoryOperationPersistence,
  type HistoryOperationPersistence,
} from "@t3tools/client-runtime/state/thread-history-storage";

import { connectionAtomRuntime } from "../../connection/runtime";
import { randomUUID } from "~/lib/utils";

const CLIENT_NAMESPACE_KEY = "t3.threadHistory.clientNamespace";

/**
 * Resolved on first use so a blocked localStorage surfaces as a failed hydration,
 * which refuses every history mutation instead of silently dropping retry identities.
 */
function localStoragePersistence(): HistoryOperationPersistence {
  let resolved: HistoryOperationPersistence | null = null;
  const resolve = () => {
    if (resolved !== null) return resolved;
    const storage = window.localStorage;
    let clientSessionId = storage.getItem(CLIENT_NAMESPACE_KEY);
    if (!clientSessionId) {
      clientSessionId = randomUUID();
      storage.setItem(CLIENT_NAMESPACE_KEY, clientSessionId);
    }
    resolved = makeHistoryOperationPersistence({ clientSessionId, storage });
    return resolved;
  };
  return {
    load: async (target) => resolve().load(target),
    save: async (target, record) => resolve().save(target, record),
  };
}

export const threadHistoryEnvironment = createThreadHistoryEnvironmentAtoms(connectionAtomRuntime, {
  operationPersistence: localStoragePersistence(),
});
