import { definePluginBackend } from "@t3tools/plugin-sdk/backend";

import addonSource from "./addon.py";
import { createInspectorBackend } from "./inspector.ts";

definePluginBackend(createInspectorBackend({ addonSource }));
