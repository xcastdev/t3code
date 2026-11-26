// @effect-diagnostics nodeBuiltinImport:off - FileSystem does not expose no-follow
// or non-blocking open flags, and the response must keep the validated descriptor.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";

import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { relayMediaDownloadETag } from "@t3tools/shared/relayMediaDownload";

class MediaFileOpenError extends Schema.TaggedError<MediaFileOpenError>()("MediaFileOpenError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to open media file '${this.path}'.`;
  }
}

class MediaFileReadError extends Schema.TaggedError<MediaFileReadError>()("MediaFileReadError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to read media file '${this.path}'.`;
  }
}

class MediaFileStatError extends Schema.TaggedError<MediaFileStatError>()("MediaFileStatError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to read metadata for media file '${this.path}'.`;
  }
}

export interface OpenMediaFile {
  readonly handle: NodeFSP.FileHandle;
  readonly info: NodeFS.BigIntStats;
}

const realpathLikeFileSystem = (filePath: string) =>
  new Promise<string>((resolve, reject) => {
    NodeFS.realpath(filePath, (error, resolved) => (error ? reject(error) : resolve(resolved)));
  });

export const openMediaFile = Effect.fn("openMediaFile")(function* (
  filePath: string,
  identity?: { readonly device: string; readonly inode: string },
) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const before = await NodeFSP.lstat(filePath, { bigint: true });
        if (!before.isFile() || before.ino === 0n) return null;
        if (
          identity &&
          (before.dev.toString() !== identity.device || before.ino.toString() !== identity.inode)
        ) {
          return null;
        }

        // Windows lacks these flags; the descriptor/path identity checks still apply.
        const handle = await NodeFSP.open(
          filePath,
          NodeFS.constants.O_RDONLY |
            (NodeFS.constants.O_NOFOLLOW ?? 0) |
            (NodeFS.constants.O_NONBLOCK ?? 0),
        );
        let accepted = false;
        try {
          const info = await handle.stat({ bigint: true });
          if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) return null;
          if (
            identity &&
            (info.dev.toString() !== identity.device || info.ino.toString() !== identity.inode)
          ) {
            return null;
          }
          // Match FileSystem.realPath's JS behavior; native realpath expands Windows 8.3 names too.
          if ((await realpathLikeFileSystem(filePath)) !== filePath) return null;
          const after = await NodeFSP.lstat(filePath, { bigint: true });
          if (!after.isFile() || info.dev !== after.dev || info.ino !== after.ino) return null;
          accepted = true;
          return { handle, info } satisfies OpenMediaFile;
        } finally {
          if (!accepted) await handle.close();
        }
      },
      catch: (cause) => new MediaFileOpenError({ path: filePath, cause }),
    }),
    (file) => (file ? Effect.promise(() => file.handle.close()) : Effect.void),
  );
});

export const readMediaFileHeader = (filePath: string, file: OpenMediaFile, byteCount: number) =>
  Effect.tryPromise({
    try: async () => {
      const buffer = new Uint8Array(byteCount);
      const { bytesRead } = await file.handle.read(buffer, 0, byteCount, 0);
      return buffer.subarray(0, bytesRead);
    },
    catch: (cause) => new MediaFileReadError({ path: filePath, cause }),
  });

export const statMediaFile = Effect.fn("statMediaFile")(function* (
  filePath: string,
  file: OpenMediaFile,
) {
  return yield* Effect.tryPromise({
    try: () => file.handle.stat({ bigint: true }),
    catch: (cause) => new MediaFileStatError({ path: filePath, cause }),
  });
});

export const streamMediaFile = (file: OpenMediaFile, offset: bigint, bytesToRead: bigint) => {
  const start = Number(offset);
  const end = Number(offset + bytesToRead - 1n);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return null;
  }
  return NodeStream.fromReadable<Uint8Array>({
    evaluate: () =>
      file.handle.createReadStream({
        autoClose: false,
        start,
        end,
      }),
  });
};

const downloadChunkBytes = 256 * 1024;
const maxDigestFileBytes = 16n * 1024n ** 3n;
const maxCachedFileBytes = 2n * maxDigestFileBytes;
const maxCachedDigests = 128;
const maxActiveDigests = 2;
const digestTimeoutMs = 110_000;

const fileIdentity = (info: NodeFS.BigIntStats) => `${info.dev}:${info.ino}`;

export function mediaFileRevision(info: NodeFS.BigIntStats) {
  return `${fileIdentity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

export function makeMediaDownloadValidator() {
  const cache = new Map<string, { revision: string; etag: string; size: bigint }>();
  let cachedBytes = 0n;
  let active = 0;

  function evict(identity: string, revision?: string) {
    const cached = cache.get(identity);
    if (!cached || (revision !== undefined && cached.revision !== revision)) return;
    cache.delete(identity);
    cachedBytes -= cached.size;
  }

  async function checkRevision(
    path: string,
    file: OpenMediaFile,
    revision: string,
    checkPath: boolean,
  ) {
    const current = await file.handle.stat({ bigint: true });
    if (mediaFileRevision(current) !== revision) return false;
    if (!checkPath) return true;
    const named = await NodeFSP.lstat(path, { bigint: true }).catch(() => undefined);
    return named !== undefined && mediaFileRevision(named) === revision;
  }

  const validate = Effect.fn("MediaFile.validateDownload")(function* (
    path: string,
    file: OpenMediaFile,
    info: NodeFS.BigIntStats,
    ifRange: string | undefined,
  ) {
    const identity = fileIdentity(info);
    const revision = mediaFileRevision(info);
    const revisionHash = NodeCrypto.createHash("sha256").update(revision).digest("hex");
    return yield* Effect.tryPromise({
      try: async (requestSignal) => {
        if (!(await checkRevision(path, file, revision, true))) {
          evict(identity, revision);
          return { status: 412 } as const;
        }
        requestSignal.throwIfAborted();
        const previous = cache.get(identity);
        if (previous && previous.revision !== revision) evict(identity);
        if (info.size > maxDigestFileBytes) return { status: 413 } as const;
        if (ifRange !== undefined && relayMediaDownloadETag.exec(ifRange)?.[2] !== revisionHash) {
          return { status: 412 } as const;
        }
        const cached = cache.get(identity);
        if (cached) {
          cache.delete(identity);
          cache.set(identity, cached);
          return ifRange !== undefined && ifRange !== cached.etag
            ? ({ status: 412 } as const)
            : { etag: cached.etag };
        }
        if (active >= maxActiveDigests) return { status: 503 } as const;
        active += 1;
        try {
          const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(digestTimeoutMs)]);
          const hash = NodeCrypto.createHash("sha256");
          const buffer = new Uint8Array(downloadChunkBytes);
          const size = Number(info.size);
          for (let position = 0; position < size;) {
            signal.throwIfAborted();
            const { bytesRead } = await file.handle.read(
              buffer,
              0,
              Math.min(buffer.length, size - position),
              position,
            );
            if (bytesRead === 0) return { status: 412 } as const;
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
          }
          if (!(await checkRevision(path, file, revision, true))) return { status: 412 } as const;
          signal.throwIfAborted();
          const etag = `"sha256-${hash.digest("hex")}-${revisionHash}"`;
          evict(identity);
          for (const oldest of cache.keys()) {
            if (cache.size < maxCachedDigests && cachedBytes + info.size <= maxCachedFileBytes)
              break;
            evict(oldest);
          }
          cache.set(identity, { revision, etag, size: info.size });
          cachedBytes += info.size;
          return ifRange !== undefined && ifRange !== etag ? ({ status: 412 } as const) : { etag };
        } finally {
          active -= 1;
        }
      },
      catch: (cause) => new MediaFileReadError({ path, cause }),
    });
  });

  function stream(
    path: string,
    file: OpenMediaFile,
    info: NodeFS.BigIntStats,
    offset: bigint,
    bytesToRead: bigint,
  ) {
    const identity = fileIdentity(info);
    const revision = mediaFileRevision(info);
    const end = Number(offset + bytesToRead);
    return Stream.fromAsyncIterable(
      {
        async *[Symbol.asyncIterator]() {
          for (let position = Number(offset); position < end;) {
            const buffer = new Uint8Array(Math.min(downloadChunkBytes, end - position));
            const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, position);
            position += bytesRead;
            // Check before yielding the last bytes, since Content-Length can complete the HTTP body.
            if (bytesRead === 0 || !(await checkRevision(path, file, revision, position === end))) {
              evict(identity, revision);
              throw new Error("The media file changed during download.");
            }
            yield buffer.subarray(0, bytesRead);
          }
        },
      },
      (cause) => new MediaFileReadError({ path, cause }),
    );
  }

  return { validate, stream };
}
