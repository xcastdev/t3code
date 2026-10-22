import { createExternalNotificationEnvironmentAtoms } from "@t3tools/client-runtime/state/external-notifications";

import { connectionAtomRuntime } from "../connection/runtime";

export const externalNotificationsEnvironment =
  createExternalNotificationEnvironmentAtoms(connectionAtomRuntime);
