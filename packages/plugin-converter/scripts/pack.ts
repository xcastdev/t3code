// @effect-diagnostics nodeBuiltinImport:off - A build script, outside any Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { packPlugin } from "@t3tools/plugin-sdk/pack";

const root = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const { id, version } = JSON.parse(
  await NodeFSP.readFile(NodePath.join(root, "t3-plugin.json"), "utf8"),
) as { id: string; version: string };
const outFile = NodePath.join(root, "dist", `${id}-${version}.t3plugin`);
await packPlugin(root, outFile);
process.stdout.write(`${outFile}\n`);
