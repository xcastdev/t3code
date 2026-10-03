// @effect-diagnostics nodeBuiltinImport:off - This explicit child entry validates trusted SDK assets and borrows native stdio.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { PiWorkerIdentity, PiWorkerOperation } from "./PiWorkerProtocol.ts";
import { makePiWorkerStdioTransport } from "./PiWorkerStdio.ts";

const AbsoluteDirectory = Schema.String.check(
  Schema.makeFilter((value) => NodePath.isAbsolute(value) && !value.includes("\0")),
);
const Launch = Schema.Struct({
  identity: PiWorkerIdentity,
  operation: PiWorkerOperation,
  sessionDirectory: AbsoluteDirectory,
  trustedSdkPackageDirectory: AbsoluteDirectory,
  compactionKeepRecentTokens: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 128, maximum: 4096 })),
  ),
});
const decodeLaunch = Schema.decodeUnknownSync(Schema.fromJsonString(Launch), {
  onExcessProperty: "error",
});
const decodeMetadata = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.Literal("@earendil-works/pi-coding-agent"),
      version: Schema.Literal("0.99.1"),
    }),
  ),
);

/** Private launch decoding never exposes caller JSON or schema diagnostics. */
export function decodePiWorkerLaunch(rawLaunchJson: string | undefined) {
  if (rawLaunchJson === undefined || Buffer.byteLength(rawLaunchJson, "utf8") > 16_384)
    throw Error("PI_WORKER_INVALID_LAUNCH");
  try {
    const launch = decodeLaunch(rawLaunchJson);
    return Object.freeze({
      ...launch,
      identity: Object.freeze({ ...launch.identity }),
      operation: Object.freeze({ ...launch.operation }),
    });
  } catch {
    throw Error("PI_WORKER_INVALID_LAUNCH");
  }
}

/** The child needs Node's built-in TypeScript loader and Promise.withResolvers. */
export function isPiWorkerNodeVersionSupported(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

async function validateSdkMetadata(directory: string) {
  try {
    if (!(await NodeFSP.lstat(directory)).isDirectory()) throw Error();
    const file = await NodeFSP.open(
      NodePath.join(directory, "package.json"),
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_536) throw Error();
      const bytes = Buffer.alloc(65_537);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > 65_536) throw Error();
      decodeMetadata(bytes.subarray(0, length).toString("utf8"));
    } finally {
      await file.close();
    }
  } catch {
    throw Error("PI_WORKER_INVALID_SDK_METADATA");
  }
}

let activated = false;

/**
 * Compose one parent-owned child operation. Importing this module activates nothing.
 * The parent owns isolation, current authorization, process deadlines and actual exit.
 */
export async function runPiWorkerEntrypoint(rawLaunchJson: string | undefined): Promise<void> {
  if (activated) throw Error("PI_WORKER_ALREADY_ACTIVATED");
  activated = true;
  const launch = decodePiWorkerLaunch(rawLaunchJson);
  if (!isPiWorkerNodeVersionSupported(process.versions.node))
    throw Error("PI_WORKER_UNSUPPORTED_NODE");
  await validateSdkMetadata(launch.trustedSdkPackageDirectory);
  let transport: ReturnType<typeof makePiWorkerStdioTransport>;
  try {
    transport = makePiWorkerStdioTransport();
  } catch {
    throw Error("PI_WORKER_STDIO_UNAVAILABLE");
  }
  let failed = false;
  let tools:
    | Awaited<ReturnType<typeof import("./PiLocalTools.ts").makePiIsolatedLocalTools>>
    | undefined;
  try {
    // The SDK eagerly reads VERSION during import. No parent/server import sets this.
    process.env.PI_PACKAGE_DIR = launch.trustedSdkPackageDirectory;
    const { makePiIsolatedLocalTools } = await import("./PiLocalTools.ts");
    tools = await makePiIsolatedLocalTools();
    const { runPiWorkerHost } = await import("./PiWorkerHost.ts");
    await runPiWorkerHost({
      identity: launch.identity,
      operation: launch.operation,
      sessionDirectory: launch.sessionDirectory,
      ...(launch.compactionKeepRecentTokens === undefined
        ? {}
        : { compactionKeepRecentTokens: launch.compactionKeepRecentTokens }),
      localTools: tools.localTools,
      initializeLocalResources: tools.initializeLocalResources,
      input: transport.input,
      output: transport.output,
    });
  } catch {
    failed = true;
  } finally {
    try {
      await tools?.close();
    } catch {
      failed = true;
    }
    try {
      await transport.dispose();
    } catch {
      failed = true;
    }
  }
  if (failed) throw Error("PI_WORKER_OPERATION_FAILED");
}
