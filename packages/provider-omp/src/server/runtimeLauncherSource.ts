export const runtimeLauncherSource = `import * as NodeFSP from "node:fs/promises";
import { startNativeRuntime, applyRuntimeLaunchArgs } from "./runtimeMain.ts";
import {validateRuntimeConfig} from "./runtimeOptions.ts";
const config = JSON.parse(await NodeFSP.readFile(process.env.T3_OMP_RUNTIME_CONFIG, "utf8"));
const runtime = await startNativeRuntime(process.argv[2], validateRuntimeConfig(applyRuntimeLaunchArgs(config,process.argv.slice(3))));
try { await Promise.race([runtime.run(),runtime.invalidated]); } finally { await runtime.close();process.exit(0); }
`;
