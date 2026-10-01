// @effect-diagnostics nodeBuiltinImport:off - Linux descriptor-relative opens and nanosecond fstat are required for nonmutating containment checks.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PiNativeReference } from "./PiWorkerProtocol.ts";

// SDK 0.99.1 core/session-manager defines version 3 and these entry tags.
// Payloads stay opaque JSON: this reader does not assert SDK message/context types.
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_JSON_DEPTH = 64;
const CHUNK_BYTES = 64 * 1024;
const Token = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const BoundedPath = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter(
    (value) =>
      NodePath.isAbsolute(value) && NodePath.normalize(value) === value && !value.includes("\0"),
  ),
);
const Timestamp = Schema.String.check(
  Schema.isMaxLength(32),
  Schema.makeFilter((value) => {
    const date = DateTime.make(value);
    return Option.isSome(date) && DateTime.formatIso(date.value) === value;
  }),
);
const Header = Schema.Struct({
  type: Schema.Literal("session"),
  version: Schema.Literal(3),
  id: Token,
  timestamp: Timestamp,
  cwd: BoundedPath,
  parentSession: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
});
const EntryMetadata = Schema.Struct({
  type: Schema.Literals([
    "message",
    "thinking_level_change",
    "model_change",
    "usage",
    "compaction",
    "branch_summary",
    "custom",
    "label",
    "session_info",
    "custom_message",
    "context_edit",
  ]),
  id: Token,
  parentId: Schema.NullOr(Token),
  timestamp: Timestamp,
});
const Input = Schema.Struct({
  sessionDirectoryRoot: BoundedPath,
  expectedCwd: BoundedPath,
  native: PiNativeReference,
});
const decodeInput = Schema.decodeUnknownSync(Input);
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.JsonObject));
const decodeHeader = Schema.decodeUnknownSync(Header, { onExcessProperty: "error" });
const decodeMetadata = Schema.decodeUnknownSync(EntryMetadata);

export class PiNativeSessionReadError extends Schema.TaggedError<PiNativeSessionReadError>()(
  "PiNativeSessionReadError",
  {
    code: Schema.Literals([
      "unavailable",
      "invalid",
      "unsupported",
      "oversize",
      "incomplete",
      "changed",
    ]),
  },
) {
  // This error can cross the private port; retain no stack paths or raw causes.
  override readonly stack = this.message;

  override get message() {
    return `Native Pi session read failed (${this.code}).`;
  }
}
const isReadError = Schema.is(PiNativeSessionReadError);
function fail(code: PiNativeSessionReadError["code"]): never {
  throw new PiNativeSessionReadError({ code });
}

// Check nesting before Schema's recursive JSON decoder. Brackets in strings and
// escaped quotes must not affect the depth bound; the schema checks JSON syntax.
function checkDepth(line: string) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of line) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      if (++depth > MAX_JSON_DEPTH) fail("oversize");
    } else if (character === "}" || character === "]") depth--;
  }
}

function parseBytes(bytes: Buffer, input: typeof Input.Type) {
  if (bytes.length === 0 || bytes.at(-1) !== 10) fail("incomplete");
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail("invalid");
  }
  const lines = content.slice(0, -1).split("\n");
  if (lines.length > MAX_ENTRIES + 1) fail("oversize");
  const objects = lines.map((line) => {
    checkDepth(line);
    try {
      return decodeJson(line);
    } catch {
      return fail("invalid");
    }
  });
  const rawHeader = objects[0];
  if (!rawHeader || rawHeader.type !== "session") fail("invalid");
  if (rawHeader.version !== 3) fail("unsupported");
  let header: typeof Header.Type;
  try {
    header = decodeHeader(rawHeader);
  } catch {
    return fail("invalid");
  }
  if (header.cwd !== input.expectedCwd || header.id !== input.native.sessionId) fail("invalid");
  const entries = objects.slice(1).map((payload) => {
    try {
      return { ...decodeMetadata(payload), payload };
    } catch {
      return fail("invalid");
    }
  });
  if (entries.length === 0 || input.native.leafId === null) fail("incomplete");
  const byId = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    // The pinned SDK appends a child only after its parent exists. This also
    // rejects cycles, dangling parents and forward references on unused branches.
    if (byId.has(entry.id) || (entry.parentId !== null && !byId.has(entry.parentId)))
      fail("invalid");
    byId.set(entry.id, entry);
  }
  const selectedBranch: typeof entries = [];
  let entry = byId.get(input.native.leafId);
  if (!entry) fail("incomplete");
  while (entry) {
    selectedBranch.push(entry);
    entry = entry.parentId === null ? undefined : byId.get(entry.parentId);
  }
  return { header, entries, selectedBranch: selectedBranch.toReversed() };
}

function sameStat(left: NodeFS.BigIntStats, right: NodeFS.BigIntStats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

// Each pass reads at most MAX_BYTES + 1, including an oversize sentinel. The
// second pass compares against the captured first pass without retaining a copy.
async function readPass(file: NodeFSP.FileHandle, expected?: Buffer) {
  const chunk = Buffer.alloc(CHUNK_BYTES);
  const chunks: Buffer[] = [];
  let offset = 0;
  while (true) {
    const { bytesRead } = await file.read(
      chunk,
      0,
      Math.min(CHUNK_BYTES, MAX_BYTES + 1 - offset),
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
    if (offset > MAX_BYTES) fail("oversize");
    const part = chunk.subarray(0, bytesRead);
    if (expected) {
      if (!part.equals(expected.subarray(offset - bytesRead, offset))) fail("changed");
    } else chunks.push(Buffer.from(part));
  }
  if (expected && offset !== expected.length) fail("changed");
  return expected ?? Buffer.concat(chunks, offset);
}

/**
 * Read the exact SQL-committed native reference after the caller authorizes the
 * project/binding and fences active operations. Stable bytes do not prove writer
 * inactivity, process drain, task authority, or native-to-T3 turn correspondence.
 * sessionDirectoryRoot is PiWorkerOptions.sessionDirectory on the parent host.
 */
export async function readPiNativeSession(input: {
  sessionDirectoryRoot: string;
  expectedCwd: string;
  native: PiNativeReference;
}) {
  if (HostProcessPlatform.defaultValue() !== "linux") fail("unavailable");
  const handles: NodeFSP.FileHandle[] = [];
  try {
    let checked: typeof Input.Type;
    try {
      checked = decodeInput(input);
    } catch {
      return fail("invalid");
    }
    if (!checked.native.persisted) fail("incomplete");
    const match = /^sessions\/([a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.jsonl)$/.exec(
      checked.native.sessionReference,
    );
    const basename = match?.[1];
    if (!basename) fail("invalid");
    // Walk from / using pinned directory descriptors. O_NOFOLLOW on every
    // component rejects root/ancestor symlinks before opening any native bytes.
    let directory = await NodeFSP.open(
      "/",
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
    );
    handles.push(directory);
    for (const component of checked.sessionDirectoryRoot.split("/").filter(Boolean)) {
      const parent = directory;
      directory = await NodeFSP.open(
        `/proc/self/fd/${directory.fd}/${component}`,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
      );
      handles.push(directory);
      // Keep only the current directory descriptor open during the walk.
      await parent.close();
    }
    const rootFdPath = `/proc/self/fd/${directory.fd}`;
    if ((await NodeFSP.realpath(rootFdPath)) !== checked.sessionDirectoryRoot) fail("changed");
    const file = await NodeFSP.open(
      `${rootFdPath}/${basename}`,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    handles.push(file);
    const fileFdPath = `/proc/self/fd/${file.fd}`;
    const expectedPath = NodePath.join(checked.sessionDirectoryRoot, basename);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) fail("invalid");
    if (before.size > BigInt(MAX_BYTES)) fail("oversize");
    if (
      (await NodeFSP.realpath(fileFdPath)) !== expectedPath ||
      (await NodeFSP.realpath(rootFdPath)) !== checked.sessionDirectoryRoot
    )
      fail("changed");
    const bytes = await readPass(file);
    if (!sameStat(before, await file.stat({ bigint: true }))) fail("changed");
    await readPass(file, bytes);
    if (!sameStat(before, await file.stat({ bigint: true }))) fail("changed");
    if (
      (await NodeFSP.realpath(fileFdPath)) !== expectedPath ||
      (await NodeFSP.realpath(rootFdPath)) !== checked.sessionDirectoryRoot
    )
      fail("changed");
    const result = parseBytes(bytes, checked);
    return {
      ...result,
      byteCount: bytes.length,
      contentSHA256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    // Never retain platform/decoder causes: they may contain paths or file bytes.
    if (isReadError(error)) throw error;
    return fail("unavailable");
  } finally {
    let closeFailed = false;
    for (const handle of handles.toReversed()) {
      try {
        await handle.close();
      } catch {
        // Attempt every close even if one descriptor close fails.
        closeFailed = true;
      }
    }
    if (closeFailed) fail("unavailable");
  }
}
