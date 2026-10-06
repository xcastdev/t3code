import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type { PiProductionRuntimeAssets } from "../provider/pi/PiProductionRuntime.ts";
import {
  MAX_PI_RUNTIME_FILES,
  MAX_PI_RUNTIME_FILE_BYTES,
  piRuntimeClosureByteLimit,
} from "../provider/pi/PiManagedProcess.ts";

const fs = process.getBuiltinModule("fs");
const path = process.getBuiltinModule("path");
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

export class ProjectWorkVerificationExecutableError extends Schema.TaggedError<ProjectWorkVerificationExecutableError>()(
  "ProjectWorkVerificationExecutableError",
  { reason: Schema.String },
) {}
const denied = () =>
  new ProjectWorkVerificationExecutableError({
    reason: "Verification executable closure is unavailable or changed",
  });
const fileIdentity = (stat: import("node:fs").BigIntStats) => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  mode: String(stat.mode),
  byteCount: String(stat.size),
  modified: String(stat.mtimeNs),
  changed: String(stat.ctimeNs),
});
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

export interface ProjectWorkVerificationExecutableCapture {
  readonly executableTarget: string;
  readonly sha256: string;
  readonly runtimeClosureSha256: string;
}

/** Root supplies assets borrowed from the currently published provider instance.
 * This helper fingerprints that existing closure; it neither prepares nor launches it. */
export function withProjectWorkVerificationExecutable<A, E, R>(
  assets: PiProductionRuntimeAssets,
  executableTarget: string,
  use: (capture: ProjectWorkVerificationExecutableCapture) => Effect.Effect<A, E, R>,
) {
  return assets.borrow(
    Effect.scoped(
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        yield* assets.revalidate;
        const files = assets.runtimeFiles
          .map((file) => ({ ...file }))
          .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
        if (
          platform !== "linux" ||
          files.length === 0 ||
          files.length > MAX_PI_RUNTIME_FILES ||
          new Set(files.map((file) => file.target)).size !== files.length ||
          files.filter((file) => file.target === executableTarget).length !== 1 ||
          files.some((file) =>
            [file.source, file.target].some(
              (value) => value.length > 4_096 || value.includes("\0") || !path.isAbsolute(value),
            ),
          )
        )
          return yield* denied();

        const held = [];
        let totalBytes = 0n;
        for (const file of files) {
          const handle = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: async () => {
                if ((await fs.promises.realpath(file.source)) !== file.source) throw denied();
                return fs.promises.open(file.source, flags);
              },
              catch: denied,
            }),
            (handle) => Effect.promise(() => handle.close()),
          );
          const size = yield* Effect.tryPromise({
            try: async () => (await handle.stat({ bigint: true })).size,
            catch: denied,
          });
          totalBytes += size;
          if (
            size > BigInt(MAX_PI_RUNTIME_FILE_BYTES) ||
            totalBytes > BigInt(piRuntimeClosureByteLimit(true))
          )
            return yield* denied();
          const read = Effect.tryPromise({
            try: async (signal) => {
              if (signal.aborted) throw denied();
              const stat = await handle.stat({ bigint: true });
              if (
                !stat.isFile() ||
                stat.size !== size ||
                stat.size > BigInt(MAX_PI_RUNTIME_FILE_BYTES) ||
                stat.nlink !== 1n ||
                (file.target === executableTarget && (stat.mode & 0o111n) === 0n)
              )
                throw denied();
              const identity = fileIdentity(stat);
              const current = await fs.promises.lstat(file.source, { bigint: true });
              if (
                canonicalProjectWorkPayload(fileIdentity(current)) !==
                  canonicalProjectWorkPayload(identity) ||
                (await fs.promises.realpath(`/proc/self/fd/${handle.fd}`)) !== file.source
              )
                throw denied();
              const hash = NodeCrypto.createHash("sha256");
              const buffer = Buffer.alloc(65_536);
              let position = 0;
              while (position < Number(stat.size)) {
                const { bytesRead } = await handle.read(
                  buffer,
                  0,
                  Math.min(buffer.length, Number(stat.size) - position),
                  position,
                );
                if (signal.aborted || bytesRead === 0) throw denied();
                hash.update(buffer.subarray(0, bytesRead));
                position += bytesRead;
              }
              const after = await handle.stat({ bigint: true });
              const afterPath = await fs.promises.lstat(file.source, { bigint: true });
              if (
                canonicalProjectWorkPayload(fileIdentity(after)) !==
                  canonicalProjectWorkPayload(identity) ||
                canonicalProjectWorkPayload(fileIdentity(afterPath)) !==
                  canonicalProjectWorkPayload(identity) ||
                (await fs.promises.realpath(file.source)) !== file.source
              )
                throw denied();
              return {
                source: file.source,
                target: file.target,
                ...identity,
                sha256: hash.digest("hex"),
              };
            },
            catch: denied,
          });
          const entry = yield* read;
          held.push({ entry, read });
        }
        const executable = held.find((file) => file.entry.target === executableTarget);
        if (!executable) return yield* denied();
        const capture = Object.freeze({
          executableTarget,
          sha256: executable.entry.sha256,
          runtimeClosureSha256: sha256(canonicalProjectWorkPayload(held.map((file) => file.entry))),
        });
        yield* assets.revalidate;
        const result = yield* Effect.suspend(() => use(capture));
        for (const file of held) {
          const current = yield* file.read;
          if (canonicalProjectWorkPayload(current) !== canonicalProjectWorkPayload(file.entry))
            return yield* denied();
        }
        yield* assets.revalidate;
        return result;
      }),
    ),
  );
}
