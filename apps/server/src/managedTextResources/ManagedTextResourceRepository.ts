// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export type ManagedTextResourceKind = "command" | "snippet";
export type ManagedTextResourceState = "active" | "disabled" | "invalid";

export interface ManagedTextResourceEntry {
  readonly kind: ManagedTextResourceKind;
  readonly key: string;
  readonly id?: string;
  readonly name?: string;
  readonly body?: string;
  readonly revision: string;
  readonly state: ManagedTextResourceState;
}

export interface ManagedTextResourceThreadEntry {
  readonly threadId: string;
  readonly kind: ManagedTextResourceKind;
  readonly key: string;
  readonly enabled: boolean;
  readonly revision: string;
}

export type ManagedTextResourceCommitGuard = (commit: () => void) => Promise<void>;

export interface ManagedTextResourceRepositoryOptions {
  readonly onChange?: (change: ManagedTextResourceRepositoryChange) => void;
}

export interface ManagedTextResourceRepositoryChange {
  readonly scope: "environment" | "project" | "thread";
  readonly scopeId: string;
  readonly catalogRevision: number;
  readonly changedKeys: ReadonlyArray<{
    readonly kind: ManagedTextResourceKind;
    readonly key: string;
  }>;
}

export class ManagedTextResourceRepositoryError extends Error {
  readonly code:
    | "not_found"
    | "revision_conflict"
    | "already_exists"
    | "invalid_content"
    | "invalid_override"
    | "mutation_failed";

  constructor(
    code: ManagedTextResourceRepositoryError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(`managed_text_resource_${code}: ${message}`, options);
    this.name = "ManagedTextResourceRepositoryError";
    this.code = code;
  }
}

interface StoredDefinition {
  readonly version: 1;
  readonly kind: ManagedTextResourceKind;
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly body: string;
  readonly state?: "active" | "disabled" | "override";
}

interface StoredDisabledEntry {
  readonly version: 1;
  readonly kind: ManagedTextResourceKind;
  readonly key: string;
  readonly state: "disabled";
}

interface StoredThreadEntry {
  readonly version: 1;
  readonly threadId: string;
  readonly kind: ManagedTextResourceKind;
  readonly key: string;
  readonly enabled: boolean;
}

interface StoredCatalogState {
  readonly version: 1;
  readonly revision: number;
  readonly fingerprints: Readonly<Record<string, string>>;
}

interface ScopeInput {
  readonly projectRoot?: string | undefined;
  readonly projectId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly environmentId?: string | undefined;
}

interface MutationResult<A> {
  readonly value: A;
  readonly catalogRevision: number;
  readonly change: ManagedTextResourceRepositoryChange;
}

const RESOURCE_KINDS = ["command", "snippet"] as const;
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_WINDOWS_COMPONENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const BODY_MAX_LENGTH = 65_536;
const NAME_MAX_LENGTH = 128;

const lockTails = new Map<string, Promise<void>>();

const withLock = async <A>(key: string, run: () => Promise<A>): Promise<A> => {
  const previous = lockTails.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  lockTails.set(key, current);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (lockTails.get(key) === current) lockTails.delete(key);
  }
};

const digest = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const identity = (kind: ManagedTextResourceKind, key: string) => `${kind}:${key}`;

const isKind = (value: unknown): value is ManagedTextResourceKind =>
  typeof value === "string" && RESOURCE_KINDS.includes(value as ManagedTextResourceKind);

const assertKey = (key: string): void => {
  if (
    key.length === 0 ||
    key.length > 64 ||
    !KEY_PATTERN.test(key) ||
    RESERVED_WINDOWS_COMPONENT.test(key)
  ) {
    throw new ManagedTextResourceRepositoryError(
      "invalid_content",
      `The key '${key}' is not a portable managed text resource key.`,
    );
  }
};

const validateBody = (body: string): void => {
  if (body.length > BODY_MAX_LENGTH) {
    throw new ManagedTextResourceRepositoryError(
      "invalid_content",
      `Resource content exceeds ${BODY_MAX_LENGTH} characters.`,
    );
  }
};

const normalizeName = (name: string | undefined, key: string): string => {
  const normalized = name?.trim() || key;
  if (normalized.length > NAME_MAX_LENGTH) {
    throw new ManagedTextResourceRepositoryError(
      "invalid_content",
      `Resource names cannot exceed ${NAME_MAX_LENGTH} characters.`,
    );
  }
  return normalized;
};

const revisionForDefinition = (entry: {
  readonly kind: ManagedTextResourceKind;
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly body: string;
  readonly state?: "active" | "disabled" | "override";
}) =>
  digest(
    JSON.stringify([
      entry.kind,
      entry.key,
      entry.id,
      entry.name,
      entry.body,
      ...(entry.state === undefined || entry.state === "override" ? [] : [entry.state]),
    ]),
  );

const revisionForDisabled = (entry: StoredDisabledEntry) =>
  digest(JSON.stringify([entry.kind, entry.key, entry.state]));

const revisionForThread = (entry: StoredThreadEntry) =>
  digest(JSON.stringify([entry.threadId, entry.kind, entry.key, entry.enabled]));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isResourceId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 128 &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) &&
  !RESERVED_WINDOWS_COMPONENT.test(value);

const isName = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= NAME_MAX_LENGTH;

const definitionPath = (directory: string, key: string) => NodePath.join(directory, `${key}.json`);

const fingerprintForEntries = (
  environment: ReadonlyArray<ManagedTextResourceEntry>,
  project: ReadonlyArray<ManagedTextResourceEntry>,
  thread: ReadonlyArray<ManagedTextResourceThreadEntry>,
) =>
  digest(
    JSON.stringify({
      environment: environment.map(({ kind, key, id, name, revision, state }) => ({
        kind,
        key,
        id,
        name,
        revision,
        state,
      })),
      project: project.map(({ kind, key, id, name, revision, state }) => ({
        kind,
        key,
        id,
        name,
        revision,
        state,
      })),
      thread: thread.map(({ threadId, kind, key, enabled, revision }) => ({
        threadId,
        kind,
        key,
        enabled,
        revision,
      })),
    }),
  );

const scopeFingerprintKey = (input: ScopeInput) =>
  `catalog:${digest(
    JSON.stringify([
      input.projectRoot === undefined ? undefined : NodePath.resolve(input.projectRoot),
      input.threadId,
    ]),
  )}`;

export const makeManagedTextResourceRepository = (
  stateDir: string,
  options: ManagedTextResourceRepositoryOptions = {},
) => {
  const stateRoot = NodePath.resolve(stateDir);
  const resourceRoot = NodePath.join(stateRoot, "managed-text-resources");
  const lockKey = resourceRoot;
  const catalogStatePath = NodePath.join(resourceRoot, "catalog-state.json");
  let capturingSnapshot = false;
  let activeGuard: ManagedTextResourceCommitGuard | undefined;
  let observedFiles: Map<string, string> | undefined;
  let observedDirectories: Map<string, { readonly dev: number; readonly ino: number }> | undefined;
  const auditPath = NodePath.join(resourceRoot, "audit.jsonl");
  const pendingPath = NodePath.join(resourceRoot, "pending-mutation.json");
  type RecoveryFile = {
    readonly filePath: string;
    readonly recoveryPath: string | undefined;
    readonly originalHash: string | undefined;
    readonly publishedHash: string | undefined;
    readonly maxBytes: number;
    readonly directory: { readonly dev: number; readonly ino: number };
    published: boolean;
  };
  type MutationRecovery = {
    readonly directory: string;
    catalog: RecoveryFile;
    readonly auditSize: number;
    readonly auditExisted: boolean;
    auditAppend: Buffer | undefined;
    resource: RecoveryFile | undefined;
    phase: "prepared" | "committed";
  };
  let activeRecovery: MutationRecovery | undefined;

  const environmentKindDirectory = (kind: ManagedTextResourceKind) =>
    NodePath.join(resourceRoot, `${kind}s`);

  const projectKindDirectory = async (
    projectRoot: string,
    kind: ManagedTextResourceKind,
    create: boolean,
  ) => {
    const root = NodePath.resolve(projectRoot);
    const metadataDirectory = NodePath.join(root, ".t3code");
    const kindDirectory = NodePath.join(metadataDirectory, `${kind}s`);
    if (create) {
      await NodeFSP.mkdir(metadataDirectory, { recursive: true });
      const metadataStat = await NodeFSP.lstat(metadataDirectory);
      if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink()) {
        throw new ManagedTextResourceRepositoryError(
          "invalid_override",
          "The project .t3code directory must be a real directory.",
        );
      }
      await NodeFSP.mkdir(kindDirectory, { recursive: true });
      const kindStat = await NodeFSP.lstat(kindDirectory);
      if (!kindStat.isDirectory() || kindStat.isSymbolicLink()) {
        throw new ManagedTextResourceRepositoryError(
          "invalid_override",
          `The project .t3code/${kind}s directory must be a real directory.`,
        );
      }
      return kindDirectory;
    }
    try {
      const metadataStat = await NodeFSP.lstat(metadataDirectory);
      if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink()) {
        return undefined;
      }
      const kindStat = await NodeFSP.lstat(kindDirectory);
      if (!kindStat.isDirectory() || kindStat.isSymbolicLink()) {
        return undefined;
      }
      return kindDirectory;
    } catch (cause) {
      if (isNodeError(cause, "ENOENT")) return undefined;
      throw cause;
    }
  };

  const threadOverlayPath = (threadId: string) =>
    NodePath.join(resourceRoot, "threads", `${digest(threadId).slice(0, 32)}.json`);

  const verifyObservedFile = (filePath: string) => {
    const directory = NodePath.dirname(filePath);
    const expectedDirectory = observedDirectories?.get(directory);
    if (expectedDirectory) {
      const actualDirectory = NodeFS.statSync(directory);
      if (
        actualDirectory.dev !== expectedDirectory.dev ||
        actualDirectory.ino !== expectedDirectory.ino
      )
        throw new ManagedTextResourceRepositoryError(
          "revision_conflict",
          "The resource directory changed during mutation preparation.",
        );
    }
    const expected = observedFiles?.get(filePath);
    let actual: string | undefined;
    try {
      const stat = NodeFS.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 400_000)
        throw new ManagedTextResourceRepositoryError(
          "invalid_override",
          "Resource paths must be regular files.",
        );
      actual = digest(NodeFS.readFileSync(filePath));
    } catch (cause) {
      if (!isNodeError(cause, "ENOENT")) throw cause;
    }
    if (actual !== expected)
      throw new ManagedTextResourceRepositoryError(
        "revision_conflict",
        "The resource changed during mutation preparation.",
      );
  };
  const assertNoPendingRecovery = async (writing: boolean) => {
    let pending: unknown;
    try {
      pending = JSON.parse(await NodeFSP.readFile(pendingPath, "utf8"));
    } catch (cause) {
      if (isNodeError(cause, "ENOENT")) return;
      throw cause;
    }
    if (!writing && isObject(pending) && pending.phase === "committed") return;
    throw new ManagedTextResourceRepositoryError(
      "mutation_failed",
      `A prior mutation needs recovery before ${writing ? "writing" : "reading"} this catalog. Recovery record: ${pendingPath}`,
    );
  };
  const persistIntent = async (recovery: MutationRecovery) => {
    await writeAtomic(
      pendingPath,
      `${JSON.stringify({
        version: 1,
        phase: recovery.phase,
        directory: recovery.directory,
        catalog: recovery.catalog,
        resource: recovery.resource,
        auditPath,
        auditSize: recovery.auditSize,
        auditExisted: recovery.auditExisted,
        auditAppend: recovery.auditAppend?.toString("utf8"),
      })}\n`,
      0o600,
    );
  };
  const readOwnedHash = (filePath: string, maxBytes: number) => {
    try {
      const stat = NodeFS.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
        throw new Error("Recovery target is not a regular file.");
      return digest(NodeFS.readFileSync(filePath));
    } catch (cause) {
      if (isNodeError(cause, "ENOENT")) return undefined;
      throw cause;
    }
  };
  const restoreFile = (file: RecoveryFile) => {
    if (!file.published) return;
    const currentDirectory = NodeFS.statSync(NodePath.dirname(file.filePath));
    if (currentDirectory.dev !== file.directory.dev || currentDirectory.ino !== file.directory.ino)
      throw new Error("The resource directory changed after publication.");
    const currentHash = readOwnedHash(file.filePath, file.maxBytes);
    if (currentHash === file.originalHash) return;
    if (currentHash !== file.publishedHash) throw new Error("A later edit prevents compensation.");
    if (file.recoveryPath === undefined) NodeFS.unlinkSync(file.filePath);
    else {
      if (readOwnedHash(file.recoveryPath, file.maxBytes) !== file.originalHash)
        throw new Error("The recovery copy changed.");
      NodeFS.renameSync(file.recoveryPath, file.filePath);
    }
  };
  const restoreAudit = (recovery: MutationRecovery) => {
    if (recovery.auditAppend === undefined) return;
    let handle: number | undefined;
    try {
      handle = NodeFS.openSync(auditPath, "r+");
      const stat = NodeFS.fstatSync(handle);
      const appendedLength = stat.size - recovery.auditSize;
      if (appendedLength < 0 || appendedLength > recovery.auditAppend.length)
        throw new Error("A later audit edit prevents compensation.");
      const suffix = Buffer.alloc(appendedLength);
      NodeFS.readSync(handle, suffix, 0, appendedLength, recovery.auditSize);
      if (!suffix.equals(recovery.auditAppend.subarray(0, appendedLength)))
        throw new Error("A later audit edit prevents compensation.");
      NodeFS.ftruncateSync(handle, recovery.auditSize);
      NodeFS.fsyncSync(handle);
      if (!recovery.auditExisted) NodeFS.unlinkSync(auditPath);
    } catch (cause) {
      if (!isNodeError(cause, "ENOENT") || recovery.auditExisted) throw cause;
    } finally {
      if (handle !== undefined) NodeFS.closeSync(handle);
    }
  };
  const cleanupRecovery = async (recovery: MutationRecovery) => {
    for (const file of [recovery.resource, recovery.catalog]) {
      if (file?.recoveryPath === undefined) continue;
      const actual = readOwnedHash(file.recoveryPath, file.maxBytes);
      if (actual === undefined) continue;
      if (actual !== file.originalHash)
        throw new Error("A changed recovery copy prevents cleanup.");
      NodeFS.unlinkSync(file.recoveryPath);
    }
    await NodeFSP.rmdir(recovery.directory);
    await NodeFSP.rm(pendingPath, { force: true });
  };
  const compensate = async (recovery: MutationRecovery, cause: unknown) => {
    const errors: unknown[] = [];
    for (const restore of [
      () => restoreAudit(recovery),
      () => restoreFile(recovery.catalog),
      () => {
        if (recovery.resource !== undefined) restoreFile(recovery.resource);
      },
    ]) {
      try {
        restore();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 0) {
      try {
        await cleanupRecovery(recovery);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0)
      throw new ManagedTextResourceRepositoryError(
        "mutation_failed",
        `Mutation compensation or cleanup is incomplete. Later edits were preserved. Recovery record: ${pendingPath}`,
        { cause: new AggregateError([cause, ...errors]) },
      );
  };
  const prepareRecovery = async (): Promise<MutationRecovery> => {
    const directory = NodePath.join(resourceRoot, `recovery-${NodeCrypto.randomUUID()}`);
    await NodeFSP.mkdir(directory, { mode: 0o700 });
    const recoveryPath = NodePath.join(directory, "catalog-state.json");
    try {
      const original = await NodeFSP.readFile(catalogStatePath);
      await writeAtomic(recoveryPath, original, 0o600);
      let auditSize = 0;
      let auditExisted = false;
      try {
        auditSize = (await NodeFSP.stat(auditPath)).size;
        auditExisted = true;
      } catch (cause) {
        if (!isNodeError(cause, "ENOENT")) throw cause;
      }
      const stat = await NodeFSP.stat(resourceRoot);
      const recovery: MutationRecovery = {
        directory,
        catalog: {
          filePath: catalogStatePath,
          recoveryPath,
          originalHash: digest(original),
          publishedHash: undefined,
          maxBytes: original.length,
          directory: stat,
          published: false,
        },
        auditSize,
        auditExisted,
        auditAppend: undefined,
        resource: undefined,
        phase: "prepared",
      };
      await persistIntent(recovery);
      return recovery;
    } catch (cause) {
      try {
        await NodeFSP.rm(recoveryPath, { force: true });
        await NodeFSP.rmdir(directory);
      } catch (cleanupCause) {
        throw new ManagedTextResourceRepositoryError(
          "mutation_failed",
          `Recovery preparation cleanup failed: ${directory}`,
          { cause: new AggregateError([cause, cleanupCause]) },
        );
      }
      throw cause;
    }
  };
  const commitFile = async (filePath: string, commit: () => void, publishedHash?: string) => {
    const recovery = activeRecovery;
    if (recovery === undefined)
      throw new ManagedTextResourceRepositoryError(
        "mutation_failed",
        "A resource mutation requires recovery ownership.",
      );
    const directory = await NodeFSP.stat(NodePath.dirname(filePath));
    let original: Buffer | undefined;
    let originalMode = 0o600;
    try {
      const stat = await NodeFSP.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 400_000)
        throw new ManagedTextResourceRepositoryError(
          "invalid_override",
          "Resource paths must be regular files.",
        );
      original = await NodeFSP.readFile(filePath);
      originalMode = stat.mode & 0o777;
    } catch (cause) {
      if (!isNodeError(cause, "ENOENT")) throw cause;
    }
    const originalHash = original === undefined ? undefined : digest(original);
    if (originalHash !== observedFiles?.get(filePath))
      throw new ManagedTextResourceRepositoryError(
        "revision_conflict",
        "The resource changed during mutation preparation.",
      );
    const recoveryPath =
      original === undefined ? undefined : `${filePath}.recovery-${NodeCrypto.randomUUID()}`;
    const file: RecoveryFile = {
      filePath,
      recoveryPath,
      originalHash,
      publishedHash,
      maxBytes: 400_000,
      directory,
      published: false,
    };
    recovery.resource = file;
    if (recoveryPath !== undefined && original !== undefined) {
      await writeAtomic(recoveryPath, original, originalMode);
      await NodeFSP.chmod(recoveryPath, originalMode);
    }
    await persistIntent(recovery);
    const publish = () => {
      verifyObservedFile(filePath);
      commit();
      file.published = true;
    };
    if (activeGuard === undefined) publish();
    else await activeGuard(publish);
  };
  const writeAtomic = async (
    filePath: string,
    value: string | Uint8Array,
    mode: number,
    resource = false,
  ) => {
    await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
    const directoryStat = await NodeFSP.stat(NodePath.dirname(filePath));
    const temporaryPath = `${filePath}.tmp-${process.pid}-${NodeCrypto.randomUUID()}`;
    let fileHandle: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
    try {
      fileHandle = await NodeFSP.open(temporaryPath, "wx", mode);
      await fileHandle.writeFile(value, "utf8");
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = undefined;
      if (resource)
        await commitFile(
          filePath,
          () => {
            const currentDirectory = NodeFS.statSync(NodePath.dirname(filePath));
            if (
              currentDirectory.dev !== directoryStat.dev ||
              currentDirectory.ino !== directoryStat.ino
            )
              throw new ManagedTextResourceRepositoryError(
                "revision_conflict",
                "The resource directory changed during mutation preparation.",
              );
            NodeFS.renameSync(temporaryPath, filePath);
          },
          digest(value),
        );
      else await NodeFSP.rename(temporaryPath, filePath);
    } catch (cause) {
      await fileHandle?.close().catch(() => undefined);
      await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw cause;
    }
  };

  const readJson = async (filePath: string): Promise<unknown | undefined> => {
    try {
      const directory = NodePath.dirname(filePath);
      if (capturingSnapshot && !observedDirectories?.has(directory))
        observedDirectories?.set(directory, await NodeFSP.stat(directory));
      const raw = await NodeFSP.readFile(filePath);
      if (capturingSnapshot && !observedFiles?.has(filePath))
        observedFiles?.set(filePath, digest(raw));
      return JSON.parse(raw.toString("utf8")) as unknown;
    } catch (cause) {
      if (isNodeError(cause, "ENOENT")) return undefined;
      if (cause instanceof SyntaxError) return undefined;
      throw cause;
    }
  };

  const readFiles = async (
    directory: string,
    kind: ManagedTextResourceKind,
    scope: "environment" | "project",
  ): Promise<ReadonlyArray<ManagedTextResourceEntry>> => {
    let fileNames: ReadonlyArray<string>;
    try {
      const stat = await NodeFSP.stat(directory);
      if (capturingSnapshot && !observedDirectories?.has(directory))
        observedDirectories?.set(directory, stat);
      fileNames = await NodeFSP.readdir(directory);
    } catch (cause) {
      if (isNodeError(cause, "ENOENT")) return [];
      throw cause;
    }
    const entries: ManagedTextResourceEntry[] = [];
    for (const fileName of fileNames.filter((name) => name.endsWith(".json")).sort()) {
      const key = fileName.slice(0, -".json".length);
      if (key.length > 64 || !KEY_PATTERN.test(key) || RESERVED_WINDOWS_COMPONENT.test(key))
        continue;
      const filePath = NodePath.join(directory, fileName);
      let raw: string;
      let rawBytes: Buffer;
      try {
        const stat = await NodeFSP.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 400_000) {
          entries.push({
            kind,
            key,
            name: key,
            revision: digest("invalid-file"),
            state: "invalid",
          });
          continue;
        }
        rawBytes = await NodeFSP.readFile(filePath);
        raw = rawBytes.toString("utf8");
      } catch (cause) {
        if (isNodeError(cause, "ENOENT")) continue;
        throw cause;
      }
      if (capturingSnapshot && !observedFiles?.has(filePath))
        observedFiles?.set(filePath, digest(rawBytes));
      let value: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch {
        entries.push({
          kind,
          key,
          name: key,
          revision: digest(rawBytes),
          state: "invalid",
        });
        continue;
      }

      if (!isObject(value) || value.version !== 1 || value.kind !== kind || value.key !== key) {
        entries.push({ kind, key, name: key, revision: digest(rawBytes), state: "invalid" });
        continue;
      }
      if (
        scope === "project" &&
        value.state === "disabled" &&
        value.id === undefined &&
        value.body === undefined
      ) {
        const stored: StoredDisabledEntry = { version: 1, kind, key, state: "disabled" };
        entries.push({ kind, key, revision: revisionForDisabled(stored), state: "disabled" });
        continue;
      }
      if (
        !isResourceId(value.id) ||
        !isName(value.name) ||
        typeof value.body !== "string" ||
        value.body.length > BODY_MAX_LENGTH ||
        (scope === "project" && value.state !== "override") ||
        (scope === "environment" &&
          value.state !== undefined &&
          value.state !== "active" &&
          value.state !== "disabled")
      ) {
        entries.push({ kind, key, name: key, revision: digest(rawBytes), state: "invalid" });
        continue;
      }
      const stored: StoredDefinition = {
        version: 1,
        kind,
        key,
        id: value.id,
        name: value.name,
        body: value.body,
        ...(value.state === "active" || value.state === "disabled" || value.state === "override"
          ? { state: value.state }
          : {}),
      };
      entries.push({
        kind,
        key,
        id: stored.id,
        name: stored.name,
        body: stored.body,
        revision: revisionForDefinition(stored),
        state: scope === "environment" && stored.state === "disabled" ? "disabled" : "active",
      });
    }
    return entries;
  };

  const listEnvironmentUnlocked = async () => {
    const entries = await Promise.all(
      RESOURCE_KINDS.map((kind) => readFiles(environmentKindDirectory(kind), kind, "environment")),
    );
    return entries.flat();
  };

  const listProjectUnlocked = async (projectRoot: string) => {
    const entries = await Promise.all(
      RESOURCE_KINDS.map(async (kind) => {
        const directory = await projectKindDirectory(projectRoot, kind, false);
        return directory === undefined ? [] : readFiles(directory, kind, "project");
      }),
    );
    return entries.flat();
  };

  const listThreadUnlocked = async (threadId: string) => {
    const value = await readJson(threadOverlayPath(threadId));
    if (value === undefined) return [] as ReadonlyArray<ManagedTextResourceThreadEntry>;
    if (
      !isObject(value) ||
      value.version !== 1 ||
      value.threadId !== threadId ||
      !Array.isArray(value.entries)
    ) {
      return [] as ReadonlyArray<ManagedTextResourceThreadEntry>;
    }
    const entries: ManagedTextResourceThreadEntry[] = [];
    for (const candidate of value.entries) {
      if (
        !isObject(candidate) ||
        !isKind(candidate.kind) ||
        typeof candidate.key !== "string" ||
        !KEY_PATTERN.test(candidate.key) ||
        typeof candidate.enabled !== "boolean"
      ) {
        continue;
      }
      const stored: StoredThreadEntry = {
        version: 1,
        threadId,
        kind: candidate.kind,
        key: candidate.key,
        enabled: candidate.enabled,
      };
      entries.push({
        threadId,
        kind: stored.kind,
        key: stored.key,
        enabled: stored.enabled,
        revision: revisionForThread(stored),
      });
    }
    return entries.sort((left, right) =>
      identity(left.kind, left.key).localeCompare(identity(right.kind, right.key)),
    );
  };

  const snapshotFingerprint = async (scope: ScopeInput) => {
    const environment = await listEnvironmentUnlocked();
    const project =
      scope.projectRoot === undefined ? [] : await listProjectUnlocked(scope.projectRoot);
    const thread = scope.threadId === undefined ? [] : await listThreadUnlocked(scope.threadId);
    return fingerprintForEntries(environment, project, thread);
  };

  const readCatalogState = async (): Promise<StoredCatalogState> => {
    const value = await readJson(catalogStatePath);
    if (value === undefined) return { version: 1, revision: 0, fingerprints: {} };
    if (
      !isObject(value) ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 0 ||
      !isObject(value.fingerprints) ||
      Object.values(value.fingerprints).some((fingerprint) => typeof fingerprint !== "string")
    ) {
      throw new ManagedTextResourceRepositoryError(
        "invalid_content",
        "The managed text resource catalog revision file is malformed.",
      );
    }
    return {
      version: 1,
      revision: Number(value.revision),
      fingerprints: value.fingerprints as Record<string, string>,
    };
  };

  const writeCatalogState = async (state: StoredCatalogState) => {
    await writeAtomic(catalogStatePath, `${JSON.stringify(state)}\n`, 0o600);
  };

  const synchronizeRevision = async (scope: ScopeInput, knownFingerprint?: string) => {
    const fingerprintKey = scopeFingerprintKey(scope);
    const fingerprint = knownFingerprint ?? (await snapshotFingerprint(scope));
    const state = await readCatalogState();
    if (state.fingerprints[fingerprintKey] === fingerprint) return state;
    if (state.fingerprints[fingerprintKey] === undefined) {
      const initialized: StoredCatalogState = {
        version: 1,
        revision: state.revision,
        fingerprints: { ...state.fingerprints, [fingerprintKey]: fingerprint },
      };
      await writeCatalogState(initialized);
      return initialized;
    }
    const next: StoredCatalogState = {
      version: 1,
      revision: state.revision + 1,
      fingerprints: { ...state.fingerprints, [fingerprintKey]: fingerprint },
    };
    await writeCatalogState(next);
    const scopeType =
      scope.threadId !== undefined
        ? "thread"
        : scope.projectRoot !== undefined
          ? "project"
          : "environment";
    const scopeId =
      scope.threadId ??
      scope.projectId ??
      scope.environmentId ??
      scope.projectRoot ??
      "environment";
    try {
      options.onChange?.({
        scope: scopeType,
        scopeId,
        catalogRevision: next.revision,
        changedKeys: [],
      });
    } catch {
      // An invalidation listener cannot make a disk-backed catalog read fail.
    }
    return next;
  };

  const advanceRevision = async (scope: ScopeInput) => {
    const fingerprintKey = scopeFingerprintKey(scope);
    const fingerprint = await snapshotFingerprint(scope);
    const state = await readCatalogState();
    const next: StoredCatalogState = {
      version: 1,
      revision: state.revision + 1,
      fingerprints: { ...state.fingerprints, [fingerprintKey]: fingerprint },
    };
    if (activeRecovery !== undefined) {
      activeRecovery.catalog = {
        ...activeRecovery.catalog,
        publishedHash: digest(`${JSON.stringify(next)}\n`),
        maxBytes: Math.max(
          activeRecovery.catalog.maxBytes,
          Buffer.byteLength(`${JSON.stringify(next)}\n`),
        ),
        published: true,
      };
      await persistIntent(activeRecovery);
    }
    await writeCatalogState(next);
    return next.revision;
  };

  const appendAudit = async (audit: Readonly<Record<string, unknown>>) => {
    await NodeFSP.mkdir(NodePath.dirname(auditPath), { recursive: true });
    if (activeRecovery !== undefined) {
      activeRecovery.auditAppend = Buffer.from(`${JSON.stringify(audit)}\n`);
      await persistIntent(activeRecovery);
    }
    let fileHandle: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
    try {
      fileHandle = await NodeFSP.open(auditPath, "a", 0o600);
      await fileHandle.writeFile(`${JSON.stringify(audit)}\n`, "utf8");
      await fileHandle.sync();
    } finally {
      await fileHandle?.close();
    }
  };

  const executeMutation = async <A>(input: {
    readonly scope: "environment" | "project" | "thread";
    readonly scopeId: string;
    readonly kind: ManagedTextResourceKind;
    readonly key: string;
    readonly action: string;
    readonly scopeInput: ScopeInput;
    readonly expectedCatalogRevision?: number | undefined;
    readonly commitGuard?: ManagedTextResourceCommitGuard | undefined;
    readonly operation: () => Promise<A>;
    readonly auditDetails?:
      | Readonly<Record<string, unknown>>
      | ((value: A) => Readonly<Record<string, unknown>>);
  }): Promise<MutationResult<A>> => {
    assertKey(input.key);
    return withLock(lockKey, async () => {
      await assertNoPendingRecovery(true);
      observedFiles = new Map();
      observedDirectories = new Map();
      let recovery: MutationRecovery | undefined;
      let committed = false;
      try {
        // Freeze source ownership at the same snapshot used for catalog CAS.
        capturingSnapshot = true;
        const current = await synchronizeRevision(input.scopeInput);
        capturingSnapshot = false;
        if (
          input.expectedCatalogRevision !== undefined &&
          input.expectedCatalogRevision !== current.revision
        )
          throw new ManagedTextResourceRepositoryError(
            "revision_conflict",
            `Expected catalog revision ${input.expectedCatalogRevision}, found ${current.revision}.`,
          );
        recovery = await prepareRecovery();
        activeRecovery = recovery;
        activeGuard = input.commitGuard;
        const value = await input.operation();
        const catalogRevision = await advanceRevision(input.scopeInput);
        const change: ManagedTextResourceRepositoryChange = {
          scope: input.scope,
          scopeId: input.scopeId,
          catalogRevision,
          changedKeys: [{ kind: input.kind, key: input.key }],
        };
        const auditDetails =
          typeof input.auditDetails === "function"
            ? input.auditDetails(value)
            : (input.auditDetails ?? {});
        await appendAudit({
          action: input.action,
          scope: input.scope,
          scopeId: input.scopeId,
          kind: input.kind,
          key: input.key,
          ...auditDetails,
        });
        recovery.phase = "committed";
        await persistIntent(recovery);
        committed = true;
        try {
          options.onChange?.(change);
        } catch {
          /* A listener cannot undo a durable mutation. */
        }
        try {
          await cleanupRecovery(recovery);
        } catch (cause) {
          throw new ManagedTextResourceRepositoryError(
            "mutation_failed",
            `Resource committed, but recovery cleanup is incomplete. Recovery record: ${pendingPath}`,
            { cause },
          );
        }
        return { value, catalogRevision, change };
      } catch (cause) {
        if (recovery !== undefined && !committed) await compensate(recovery, cause);
        throw cause;
      } finally {
        capturingSnapshot = false;
        activeGuard = undefined;
        activeRecovery = undefined;
        observedFiles = undefined;
        observedDirectories = undefined;
      }
    });
  };

  const createDefinition = (input: {
    readonly kind: ManagedTextResourceKind;
    readonly key: string;
    readonly name?: string | undefined;
    readonly body: string;
    readonly id?: string | undefined;
  }): StoredDefinition => {
    assertKey(input.key);
    validateBody(input.body);
    const definition: StoredDefinition = {
      version: 1,
      kind: input.kind,
      key: input.key,
      id: input.id ?? NodeCrypto.randomUUID(),
      name: normalizeName(input.name, input.key),
      body: input.body,
    };
    return definition;
  };

  const findById = async (
    entries: ReadonlyArray<ManagedTextResourceEntry>,
    id: string,
    kind?: ManagedTextResourceKind,
  ) => entries.find((entry) => entry.id === id && (kind === undefined || entry.kind === kind));

  const writeDefinition = async (
    directory: string,
    definition: StoredDefinition,
    mode: number,
    projectOverride = false,
  ) => {
    await writeAtomic(
      definitionPath(directory, definition.key),
      `${JSON.stringify({
        ...definition,
        ...(projectOverride ? { state: "override" } : {}),
      })}\n`,
      mode,
      true,
    );
  };

  const readThreadFile = async (threadId: string): Promise<StoredThreadEntry[]> =>
    (await listThreadUnlocked(threadId)).map((entry) => ({
      version: 1,
      threadId,
      kind: entry.kind,
      key: entry.key,
      enabled: entry.enabled,
    }));

  const writeThreadFile = async (threadId: string, entries: ReadonlyArray<StoredThreadEntry>) => {
    const filePath = threadOverlayPath(threadId);
    if (entries.length === 0) {
      await commitFile(filePath, () => NodeFS.rmSync(filePath, { force: true }));
      return;
    }
    await writeAtomic(
      filePath,
      `${JSON.stringify({ version: 1, threadId, entries })}\n`,
      0o600,
      true,
    );
  };

  return {
    async listEnvironment() {
      return withLock(lockKey, async () => {
        await assertNoPendingRecovery(false);
        return listEnvironmentUnlocked();
      });
    },
    async listProject(projectRoot: string) {
      return withLock(lockKey, async () => {
        await assertNoPendingRecovery(false);
        return listProjectUnlocked(projectRoot);
      });
    },
    async listThread(threadId: string) {
      return withLock(lockKey, async () => {
        await assertNoPendingRecovery(false);
        return listThreadUnlocked(threadId);
      });
    },
    async getCatalogRevision(scope: ScopeInput = {}) {
      return withLock(lockKey, async () => {
        await assertNoPendingRecovery(false);
        return (await synchronizeRevision(scope)).revision;
      });
    },
    async readCatalog(scope: ScopeInput = {}) {
      return withLock(lockKey, async () => {
        await assertNoPendingRecovery(false);
        const environment = await listEnvironmentUnlocked();
        const project =
          scope.projectRoot === undefined ? [] : await listProjectUnlocked(scope.projectRoot);
        const thread = scope.threadId === undefined ? [] : await listThreadUnlocked(scope.threadId);
        const catalogRevision = (
          await synchronizeRevision(scope, fingerprintForEntries(environment, project, thread))
        ).revision;
        return { catalogRevision, environment, project, thread };
      });
    },
    async createEnvironment(input: {
      readonly commitGuard?: ManagedTextResourceCommitGuard | undefined;
      readonly kind: ManagedTextResourceKind;
      readonly key: string;
      readonly name?: string | undefined;
      readonly body: string;
      readonly expectedCatalogRevision?: number | undefined;
      readonly environmentId?: string | undefined;
    }) {
      const { value, catalogRevision } = await executeMutation({
        scope: "environment",
        scopeId: input.environmentId ?? "environment",
        kind: input.kind,
        key: input.key,
        action: "create",
        expectedCatalogRevision: input.expectedCatalogRevision,
        scopeInput: { environmentId: input.environmentId },
        commitGuard: input.commitGuard,
        operation: async () => {
          const directory = environmentKindDirectory(input.kind);
          const entries = await readFiles(directory, input.kind, "environment");
          if (entries.some((entry) => entry.key === input.key)) {
            throw new ManagedTextResourceRepositoryError(
              "already_exists",
              `A ${input.kind} named '${input.key}' already exists in this environment.`,
            );
          }
          const definition = createDefinition(input);
          await writeDefinition(directory, definition, 0o600);
          return {
            kind: definition.kind,
            key: definition.key,
            id: definition.id,
            name: definition.name,
            body: definition.body,
            revision: revisionForDefinition(definition),
            state: "active" as const,
          } satisfies ManagedTextResourceEntry;
        },
        auditDetails: (value) => ({ id: value.id, revision: value.revision }),
      });
      return { ...value, catalogRevision };
    },
    async updateEnvironment(input: {
      readonly commitGuard?: ManagedTextResourceCommitGuard | undefined;
      readonly id: string;
      readonly kind?: ManagedTextResourceKind | undefined;
      readonly expectedRevision: string;
      readonly name?: string | undefined;
      readonly body: string;
      readonly environmentId?: string | undefined;
    }) {
      const all = await listEnvironmentUnlocked();
      const existing = await findById(all, input.id, input.kind);
      if (existing === undefined || existing.state === "invalid") {
        throw new ManagedTextResourceRepositoryError(
          "not_found",
          `Resource '${input.id}' was not found.`,
        );
      }
      const { value, catalogRevision } = await executeMutation({
        scope: "environment",
        scopeId: input.environmentId ?? "environment",
        kind: existing.kind,
        key: existing.key,
        action: "update",
        scopeInput: { environmentId: input.environmentId },
        commitGuard: input.commitGuard,
        operation: async () => {
          const current = (await listEnvironmentUnlocked()).find(
            (entry) =>
              entry.id === input.id && (input.kind === undefined || entry.kind === input.kind),
          );
          if (current === undefined || current.state === "invalid") {
            throw new ManagedTextResourceRepositoryError(
              "not_found",
              `Resource '${input.id}' was not found.`,
            );
          }
          if (current.revision !== input.expectedRevision) {
            throw new ManagedTextResourceRepositoryError(
              "revision_conflict",
              `Expected revision ${input.expectedRevision}, found ${current.revision}.`,
            );
          }
          const definition = createDefinition({
            kind: current.kind,
            key: current.key,
            id: input.id,
            name: input.name ?? current.name,
            body: input.body,
          });
          const stored: StoredDefinition = { ...definition, state: current.state };
          await writeDefinition(environmentKindDirectory(current.kind), stored, 0o600);
          return {
            ...current,
            name: definition.name,
            body: definition.body,
            revision: revisionForDefinition(stored),
          };
        },
        auditDetails: (value) => ({ id: input.id, revision: value.revision }),
      });
      return { ...value, catalogRevision };
    },
    async setEnvironmentEnabled(input: {
      readonly commitGuard?: ManagedTextResourceCommitGuard | undefined;
      readonly id: string;
      readonly expectedRevision: string;
      readonly enabled: boolean;
      readonly kind?: ManagedTextResourceKind | undefined;
      readonly environmentId?: string | undefined;
    }) {
      const all = await listEnvironmentUnlocked();
      const existing = await findById(all, input.id, input.kind);
      if (existing === undefined || existing.state === "invalid" || existing.body === undefined) {
        throw new ManagedTextResourceRepositoryError(
          "not_found",
          `Resource '${input.id}' was not found.`,
        );
      }
      const { value, catalogRevision } = await executeMutation({
        scope: "environment",
        scopeId: input.environmentId ?? "environment",
        kind: existing.kind,
        key: existing.key,
        action: input.enabled ? "set-enabled" : "set-disabled",
        scopeInput: { environmentId: input.environmentId },
        commitGuard: input.commitGuard,
        operation: async () => {
          const current = (await listEnvironmentUnlocked()).find(
            (entry) =>
              entry.id === input.id && (input.kind === undefined || entry.kind === input.kind),
          );
          if (current === undefined || current.state === "invalid" || current.body === undefined) {
            throw new ManagedTextResourceRepositoryError(
              "not_found",
              `Resource '${input.id}' was not found.`,
            );
          }
          if (current.revision !== input.expectedRevision) {
            throw new ManagedTextResourceRepositoryError(
              "revision_conflict",
              `Expected revision ${input.expectedRevision}, found ${current.revision}.`,
            );
          }
          const definition: StoredDefinition = {
            version: 1,
            kind: current.kind,
            key: current.key,
            id: input.id,
            name: current.name ?? current.key,
            body: current.body,
            state: input.enabled ? "active" : "disabled",
          };
          await writeDefinition(environmentKindDirectory(current.kind), definition, 0o600);
          return {
            ...current,
            state: input.enabled ? ("active" as const) : ("disabled" as const),
            revision: revisionForDefinition(definition),
          };
        },
        auditDetails: (entry) => ({ id: input.id, revision: entry.revision }),
      });
      return { ...value, catalogRevision };
    },
    async deleteEnvironment(input: {
      readonly commitGuard?: ManagedTextResourceCommitGuard | undefined;
      readonly id: string;
      readonly expectedRevision: string;
      readonly kind?: ManagedTextResourceKind | undefined;
      readonly environmentId?: string | undefined;
    }) {
      const all = await listEnvironmentUnlocked();
      const existing = await findById(all, input.id, input.kind);
      if (existing === undefined || existing.state === "invalid") {
        throw new ManagedTextResourceRepositoryError(
          "not_found",
          `Resource '${input.id}' was not found.`,
        );
      }
      const { value, catalogRevision } = await executeMutation({
        scope: "environment",
        scopeId: input.environmentId ?? "environment",
        kind: existing.kind,
        key: existing.key,
        action: "delete",
        scopeInput: { environmentId: input.environmentId },
        commitGuard: input.commitGuard,
        operation: async () => {
          const current = (await listEnvironmentUnlocked()).find(
            (entry) =>
              entry.id === input.id && (input.kind === undefined || entry.kind === input.kind),
          );
          if (current === undefined || current.state === "invalid") {
            throw new ManagedTextResourceRepositoryError(
              "not_found",
              `Resource '${input.id}' was not found.`,
            );
          }
          if (current.revision !== input.expectedRevision) {
            throw new ManagedTextResourceRepositoryError(
              "revision_conflict",
              `Expected revision ${input.expectedRevision}, found ${current.revision}.`,
            );
          }
          const filePath = definitionPath(environmentKindDirectory(current.kind), current.key);
          await commitFile(filePath, () => NodeFS.unlinkSync(filePath));
          return current;
        },
        auditDetails: (value) => ({ id: input.id, revision: value.revision }),
      });
      return { ...value, catalogRevision };
    },
    async getContent(input: {
      readonly id: string;
      readonly revision: string;
      readonly kind?: ManagedTextResourceKind;
      readonly projectRoot?: string;
    }) {
      return withLock(lockKey, async () => {
        await assertNoPendingRecovery(false);
        const candidates = [
          ...(input.projectRoot === undefined ? [] : await listProjectUnlocked(input.projectRoot)),
          ...(await listEnvironmentUnlocked()),
        ];
        const entry = await findById(candidates, input.id, input.kind);
        if (entry === undefined || entry.state === "invalid" || entry.body === undefined) {
          throw new ManagedTextResourceRepositoryError(
            "not_found",
            `Resource '${input.id}' was not found.`,
          );
        }
        if (entry.revision !== input.revision) {
          throw new ManagedTextResourceRepositoryError(
            "revision_conflict",
            `Expected revision ${input.revision}, found ${entry.revision}.`,
          );
        }
        return {
          kind: entry.kind,
          id: entry.id as string,
          key: entry.key,
          name: entry.name,
          revision: entry.revision,
          body: entry.body,
        };
      });
    },
    async setProjectOverride(input: {
      readonly commitGuard?: ManagedTextResourceCommitGuard | undefined;
      readonly projectRoot: string;
      readonly projectId?: string | undefined;
      readonly kind: ManagedTextResourceKind;
      readonly key: string;
      readonly name?: string | undefined;
      readonly body: string;
      readonly expectedCatalogRevision?: number | undefined;
      /** Compatibility for repository callers that need to assert absent/current entry state. */
      readonly expectedRevision?: string | null | undefined;
    }) {
      const { value, catalogRevision } = await executeMutation({
        scope: "project",
        scopeId: input.projectId ?? NodePath.resolve(input.projectRoot),
        kind: input.kind,
        key: input.key,
        action: "set-override",
        scopeInput: { projectRoot: input.projectRoot },
        expectedCatalogRevision: input.expectedCatalogRevision,
        commitGuard: input.commitGuard,
        operation: async () => {
          const current = (await listProjectUnlocked(input.projectRoot)).find(
            (entry) => entry.kind === input.kind && entry.key === input.key,
          );
          if (input.expectedRevision === null && current !== undefined) {
            throw new ManagedTextResourceRepositoryError(
              "revision_conflict",
              `Expected no project entry for '${input.key}'.`,
            );
          }
          if (
            typeof input.expectedRevision === "string" &&
            current?.revision !== input.expectedRevision
          ) {
            throw new ManagedTextResourceRepositoryError(
              "revision_conflict",
              `Expected revision ${input.expectedRevision}, found ${current?.revision ?? "none"}.`,
            );
          }
          const directory = await projectKindDirectory(input.projectRoot, input.kind, true);
          const definition = createDefinition({
            kind: input.kind,
            key: input.key,
            name: input.name ?? current?.name,
            body: input.body,
            ...(current?.state === "active" && current.id !== undefined ? { id: current.id } : {}),
          });
          if (directory === undefined) {
            throw new ManagedTextResourceRepositoryError(
              "mutation_failed",
              "The project override directory could not be created.",
            );
          }
          await writeDefinition(directory, definition, 0o644, true);
          return {
            kind: definition.kind,
            key: definition.key,
            id: definition.id,
            name: definition.name,
            body: definition.body,
            revision: revisionForDefinition(definition),
            state: "active" as const,
          } satisfies ManagedTextResourceEntry;
        },
        auditDetails: (value) => ({ id: value.id, revision: value.revision }),
      });
      return { ...value, catalogRevision };
    },
    async setProjectDisabled(input: {
      readonly commitGuard?: ManagedTextResourceCommitGuard | undefined;
      readonly projectRoot: string;
      readonly projectId?: string | undefined;
      readonly kind: ManagedTextResourceKind;
      readonly key: string;
      readonly expectedCatalogRevision?: number | undefined;
      readonly expectedRevision?: string | undefined;
    }) {
      const { value, catalogRevision } = await executeMutation({
        scope: "project",
        scopeId: input.projectId ?? NodePath.resolve(input.projectRoot),
        kind: input.kind,
        key: input.key,
        action: "set-disabled",
        scopeInput: { projectRoot: input.projectRoot },
        expectedCatalogRevision: input.expectedCatalogRevision,
        commitGuard: input.commitGuard,
        operation: async () => {
          const current = (await listProjectUnlocked(input.projectRoot)).find(
            (entry) => entry.kind === input.kind && entry.key === input.key,
          );
          if (
            input.expectedRevision !== undefined &&
            current?.revision !== input.expectedRevision
          ) {
            throw new ManagedTextResourceRepositoryError(
              "revision_conflict",
              `Expected revision ${input.expectedRevision}, found ${current?.revision ?? "none"}.`,
            );
          }
          const directory = await projectKindDirectory(input.projectRoot, input.kind, true);
          if (directory === undefined) {
            throw new ManagedTextResourceRepositoryError(
              "mutation_failed",
              "The project override directory could not be created.",
            );
          }
          const tombstone: StoredDisabledEntry = {
            version: 1,
            kind: input.kind,
            key: input.key,
            state: "disabled",
          };
          await writeAtomic(
            definitionPath(directory, input.key),
            `${JSON.stringify(tombstone)}\n`,
            0o644,
            true,
          );
          return {
            kind: input.kind,
            key: input.key,
            revision: revisionForDisabled(tombstone),
            state: "disabled" as const,
          } satisfies ManagedTextResourceEntry;
        },
        auditDetails: (value) => ({ revision: value.revision }),
      });
      return { ...value, catalogRevision };
    },
    async deleteProjectState(input: {
      readonly commitGuard?: ManagedTextResourceCommitGuard | undefined;
      readonly projectRoot: string;
      readonly projectId?: string | undefined;
      readonly kind: ManagedTextResourceKind;
      readonly key: string;
      readonly expectedCatalogRevision?: number | undefined;
      readonly expectedRevision?: string | undefined;
    }) {
      const { value, catalogRevision } = await executeMutation({
        scope: "project",
        scopeId: input.projectId ?? NodePath.resolve(input.projectRoot),
        kind: input.kind,
        key: input.key,
        action: "delete-state",
        scopeInput: { projectRoot: input.projectRoot },
        expectedCatalogRevision: input.expectedCatalogRevision,
        commitGuard: input.commitGuard,
        operation: async () => {
          const current = (await listProjectUnlocked(input.projectRoot)).find(
            (entry) => entry.kind === input.kind && entry.key === input.key,
          );
          if (current === undefined) {
            throw new ManagedTextResourceRepositoryError(
              "not_found",
              `Project state '${input.key}' was not found.`,
            );
          }
          if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
            throw new ManagedTextResourceRepositoryError(
              "revision_conflict",
              `Expected revision ${input.expectedRevision}, found ${current.revision}.`,
            );
          }
          const directory = await projectKindDirectory(input.projectRoot, input.kind, false);
          if (directory === undefined) {
            throw new ManagedTextResourceRepositoryError(
              "not_found",
              `Project state '${input.key}' was not found.`,
            );
          }
          const filePath = definitionPath(directory, input.key);
          await commitFile(filePath, () => NodeFS.unlinkSync(filePath));
          return current;
        },
        auditDetails: (value) => ({
          ...(value.id === undefined ? {} : { id: value.id }),
          revision: value.revision,
        }),
      });
      return { ...value, catalogRevision };
    },
    async setThreadEnabled(input: {
      readonly commitGuard?: ManagedTextResourceCommitGuard | undefined;
      readonly threadId: string;
      readonly projectRoot?: string | undefined;
      readonly projectId?: string | undefined;
      readonly kind: ManagedTextResourceKind;
      readonly key: string;
      readonly enabled: boolean;
      readonly expectedCatalogRevision?: number | undefined;
    }) {
      const { value, catalogRevision } = await executeMutation({
        scope: "thread",
        scopeId: input.threadId,
        kind: input.kind,
        key: input.key,
        action: "set-enabled",
        scopeInput: { projectRoot: input.projectRoot, threadId: input.threadId },
        expectedCatalogRevision: input.expectedCatalogRevision,
        commitGuard: input.commitGuard,
        operation: async () => {
          const entries = await readThreadFile(input.threadId);
          const old = entries.find((entry) => entry.kind === input.kind && entry.key === input.key);
          const stored: StoredThreadEntry = {
            version: 1,
            threadId: input.threadId,
            kind: input.kind,
            key: input.key,
            enabled: input.enabled,
          };
          await writeThreadFile(input.threadId, [
            ...entries.filter((entry) => !(entry.kind === input.kind && entry.key === input.key)),
            stored,
          ]);
          return {
            threadId: input.threadId,
            kind: input.kind,
            key: input.key,
            enabled: stored.enabled,
            revision: revisionForThread(stored),
            ...(old === undefined ? {} : { previousRevision: revisionForThread(old) }),
          };
        },
        auditDetails: (value) => ({ revision: value.revision }),
      });
      return { ...value, catalogRevision };
    },
    async resetThread(input: {
      readonly commitGuard?: ManagedTextResourceCommitGuard | undefined;
      readonly threadId: string;
      readonly projectRoot?: string | undefined;
      readonly projectId?: string | undefined;
      readonly kind: ManagedTextResourceKind;
      readonly key: string;
      readonly expectedCatalogRevision?: number | undefined;
    }) {
      const { value, catalogRevision } = await executeMutation({
        scope: "thread",
        scopeId: input.threadId,
        kind: input.kind,
        key: input.key,
        action: "reset",
        scopeInput: { projectRoot: input.projectRoot, threadId: input.threadId },
        expectedCatalogRevision: input.expectedCatalogRevision,
        commitGuard: input.commitGuard,
        operation: async () => {
          const entries = await readThreadFile(input.threadId);
          const existing = entries.find(
            (entry) => entry.kind === input.kind && entry.key === input.key,
          );
          if (existing === undefined) {
            throw new ManagedTextResourceRepositoryError(
              "not_found",
              `Thread state '${input.key}' was not found.`,
            );
          }
          await writeThreadFile(
            input.threadId,
            entries.filter((entry) => !(entry.kind === input.kind && entry.key === input.key)),
          );
          return existing;
        },
        auditDetails: (value) => ({ revision: revisionForThread(value) }),
      });
      return { ...value, revision: revisionForThread(value), catalogRevision };
    },
  };
};

const isNodeError = (cause: unknown, code: string): cause is NodeJS.ErrnoException =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
