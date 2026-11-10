import * as Effect from "effect/Effect";
import { materializeOmpRuntimeAssets } from "../server/launch.ts";

const assets = await Effect.runPromise(materializeOmpRuntimeAssets(process.argv[2]!));
process.stdout.write(JSON.stringify(assets) + "\n");
