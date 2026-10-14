import { ProjectTeamReviewReportOperation } from "../../projectWork/ProjectTeamReviewCompletionProposals.ts";
import { ProjectMemoryOperation } from "../../projectWork/memory/ProjectMemoryModelAccounting.ts";
import { ProjectMemoryServiceError } from "../../projectWork/memory/ProjectMemoryService.ts";
import * as NodeCrypto from "node:crypto";
import {
  IsoDateTime,
  canonicalProjectWorkPayload,
  ManagedSkillKey,
  ManagedSkillManifest,
  ProviderInstanceId,
  SkillCatalogRevision,
  ThreadId,
  ProviderDriverKind,
  ProjectTeamRunBinding,
  TurnId,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  ProjectTeamAuthorization,
  type ProjectTeamAuthority,
} from "../../projectWork/ProjectTeamAuthorization.ts";
import { makeProjectTeamPiOperations } from "../../projectWork/ProjectTeamPiOperations.ts";
import {
  make as makeAccounting,
  makeProjectTeamPiSubscriptionParentPolicy,
  type ProjectTeamPiSubscriptionTestSelection,
  type ProjectTeamPiSubscriptionGrantIdentity,
} from "../../projectWork/ProjectTeamModelAccounting.ts";
import { SqlClient } from "effect/unstable/sql";
import { inspectPiSubscriptionConfiguration } from "./PiSubscriptionConfiguration.ts";
import { readPiSubscriptionCredential } from "./PiSubscriptionCredential.ts";
import { ProjectWorkGateway } from "../../projectWork/ProjectWorkGateway.ts";
import { ManagedSkillRepository } from "../../skills/ManagedSkillRepository.ts";
import { ServerConfig } from "../../config.ts";
import { DEFAULT_SKILL_PACKAGE_LIMITS, SKILL_MANIFEST_FILE } from "../../skills/SkillPackage.ts";
import { SkillMaterializationService } from "../../skills/SkillMaterializationService.ts";
import type { ProviderSkillPlan } from "../../skills/ProviderSkillAdapter.ts";
import {
  resolvePiManagedSkillSelection,
  type PiManagedSkillSelection,
} from "./PiManagedSkillSelection.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import {
  PiManagedRuntime,
  PiManagedRuntimeError,
  type PiManagedRuntimeInstance,
  type PiManagedPreparedOperation,
} from "./PiManagedRuntime.ts";
import { preallocatePiManagedProcess, type PiManagedLaunch } from "./PiManagedProcess.ts";
import {
  inspectPiNativeConfiguration,
  readPiSavedLiteralCredential,
} from "./PiNativeConfiguration.ts";
import { readPiNativeSession } from "./PiNativeSessionReader.ts";
import { makeProjectTeamReviewFreshness } from "../../projectWork/ProjectTeamReviewFreshness.ts";
import { makeProjectTeamContext } from "../../projectWork/ProjectTeamContext.ts";
import { makeProjectTeamMailboxConsumption } from "../../projectWork/ProjectTeamMailboxConsumption.ts";
import { makeProjectTeamMailboxTurns } from "../../projectWork/ProjectTeamMailboxTurns.ts";
import { makePiRuntimeEventTranslator } from "./PiRuntimeEvents.ts";
import { makePiSessionRuntime } from "./PiSessionRuntime.ts";
import { piLocalToolDefinitions } from "./PiLocalTools.ts";
import {
  executePiProjectWorkBridgeTool,
  preparePiProjectWorkTools,
  piProjectWorkToolCapabilities,
} from "./PiProjectWorkTools.ts";
import type { PiModelBrokerConfig, PiModelTool } from "./PiModelBroker.ts";
import {
  PiWorkerOperation,
  type PiNativeReference,
  type PiWorkerIdentity,
} from "./PiWorkerProtocol.ts";
import type { PiSkillStageLifetime } from "./PiSkillStageLifetime.ts";
import {
  piManagedSkillResourceIdentity,
  preparePiManagedSkillResources,
  validatePiManagedSkillPlan,
} from "./PiManagedSkillResources.ts";

import { PiManagedModel, piBrokerModelRoute, piManagedModels } from "./PiManagedModels.ts";

const provider = ProviderDriverKind.make("piAgent");
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeBinding = Schema.decodeUnknownSync(ProjectTeamRunBinding);
const isRuntimeError = Schema.is(PiManagedRuntimeError);
const skillAbsolute = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.isPattern(/^\/[^\0\r\n]*$/),
);
const decodeSkillCandidates = Schema.decodeUnknownEffect(
  Schema.Struct({
    runtime: Schema.Struct({
      providerInstanceId: ProviderInstanceId,
      threadId: ThreadId,
      cwd: skillAbsolute,
      sessionId: Schema.String.check(Schema.isMaxLength(128)),
    }),
    desiredRevision: SkillCatalogRevision,
    skills: Schema.Array(Schema.Struct({ key: ManagedSkillKey, packagePath: skillAbsolute })).check(
      Schema.isMaxLength(4096),
    ),
  }),
  { onExcessProperty: "error" },
);
const decodeOperation = Schema.decodeEffect(PiWorkerOperation);
const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const deny = (detail: string, code: PiManagedRuntimeError["code"] = "denied") =>
  new PiManagedRuntimeError({ code, detail });
const guard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      isRuntimeError(error) ? error : deny("Pi managed runtime unavailable", "unavailable"),
    ),
  );
// A final synchronous receipt closes the asynchronous SQL/workspace-check gap.
// Fixed metadata only: no Git child, directory scan, includes, or credential read.
const NodeFS = process.getBuiltinModule("fs");
const directoryFlags =
  NodeFS.constants.O_RDONLY |
  NodeFS.constants.O_DIRECTORY |
  NodeFS.constants.O_NOFOLLOW |
  NodeFS.constants.O_NONBLOCK;
const fileFlags =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK;
const nativeStateReceipt = (
  identity: { readonly path: string; readonly dev: number; readonly ino: number },
  expectedPath: string,
) => {
  try {
    if (identity.path !== expectedPath || NodeFS.realpathSync(expectedPath) !== expectedPath)
      throw deny("Pi replay native ownership changed", "uncertain");
    const fd = NodeFS.openSync(expectedPath, directoryFlags);
    try {
      const stat = NodeFS.fstatSync(fd, { bigint: true });
      const linked = NodeFS.lstatSync(expectedPath, { bigint: true });
      if (
        !stat.isDirectory() ||
        !linked.isDirectory() ||
        String(stat.dev) !== String(identity.dev) ||
        String(stat.ino) !== String(identity.ino) ||
        stat.dev !== linked.dev ||
        stat.ino !== linked.ino ||
        NodeFS.realpathSync(`/proc/self/fd/${fd}`) !== expectedPath
      )
        throw deny("Pi replay native ownership changed", "uncertain");
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch {
    throw deny("Pi replay native ownership changed", "uncertain");
  }
};
const sourceStat = (stat: import("node:fs").BigIntStats) =>
  encode({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtime: String(stat.mtimeNs),
    ctime: String(stat.ctimeNs),
  });
const sourceChanged = () => deny("Pi selected source or catalogue changed", "conflict");
const verifySource = (fence: () => void) =>
  Effect.try({ try: fence, catch: () => sourceChanged() });
const sourceMissing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));
const decodeSourceManifest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      ...ManagedSkillManifest.fields,
      projectState: Schema.optionalKey(Schema.Literal("override")),
    }),
  ),
);
// Trusted repository mutations serialize per owned root and publish by rename. Capturing
// those root identities before resolution fences winner/override/tombstone changes without
// scanning unbounded catalogues in SQL callbacks. Unrelated in-place catalogue edits are
// outside that mutation model; selected files themselves are always descriptor-validated.
const skillCatalogueReceipt = (
  directories: ReadonlyArray<string>,
  catalogues: ReadonlySet<string>,
) => {
  const fingerprint = (path: string, stat: import("node:fs").BigIntStats) =>
    catalogues.has(path)
      ? sourceStat(stat)
      : encode({
          dev: String(stat.dev),
          ino: String(stat.ino),
          uid: String(stat.uid),
          mode: String(stat.mode),
        });
  const before = directories.map((path) => {
    try {
      const fd = NodeFS.openSync(path, directoryFlags);
      try {
        const stat = NodeFS.fstatSync(fd, { bigint: true });
        if (
          !stat.isDirectory() ||
          NodeFS.realpathSync(path) !== path ||
          NodeFS.realpathSync(`/proc/self/fd/${fd}`) !== path ||
          sourceStat(stat) !== sourceStat(NodeFS.lstatSync(path, { bigint: true }))
        )
          throw sourceChanged();
        return fingerprint(path, stat);
      } finally {
        NodeFS.closeSync(fd);
      }
    } catch (error) {
      if (sourceMissing(error)) return null;
      throw error;
    }
  });
  return () => {
    directories.forEach((path, index) => {
      try {
        const stat = NodeFS.lstatSync(path, { bigint: true });
        if (
          !stat.isDirectory() ||
          NodeFS.realpathSync(path) !== path ||
          fingerprint(path, stat) !== before[index]
        )
          throw sourceChanged();
      } catch (error) {
        if (before[index] !== null || !sourceMissing(error)) throw sourceChanged();
      }
    });
  };
};
const captureSkillSources = async (
  paths: Path.Path,
  selection: ReadonlyArray<PiManagedSkillSelection>,
  catalogue: () => void,
  roots: { readonly global: string; readonly project: string },
) => {
  const receipts: Array<{ path: string; directory: boolean; stat: string }> = [];
  const limits = DEFAULT_SKILL_PACKAGE_LIMITS;
  // Selection is bounded to 32 packages; each inventory uses the shared package limits.
  if (selection.length > 32) throw sourceChanged();
  const validate = (path: string) => {
    if (!paths.isAbsolute(path) || paths.normalize(path) !== path || path.length > 4096)
      throw sourceChanged();
  };
  for (const selected of selection) {
    let entries = 0;
    let files = 0;
    let bytes = 0n;
    const inventory: Array<{ relative: string; path: string; bytes: Buffer }> = [];
    const walk = async (path: string, relative: string, depth: number): Promise<void> => {
      validate(path);
      if (depth > limits.maxDepth || (relative !== "" && ++entries > limits.maxEntries))
        throw sourceChanged();
      const initial = await NodeFS.promises.lstat(path, { bigint: true });
      if (
        initial.isSymbolicLink() ||
        (!initial.isDirectory() && !initial.isFile()) ||
        (!initial.isDirectory() && initial.nlink !== 1n)
      )
        throw sourceChanged();
      const fd = await NodeFS.promises.open(
        path,
        initial.isDirectory() ? directoryFlags : fileFlags,
      );
      try {
        const fingerprint = sourceStat(initial);
        if (
          sourceStat(await fd.stat({ bigint: true })) !== fingerprint ||
          (await NodeFS.promises.realpath(`/proc/self/fd/${fd.fd}`)) !== path ||
          (await NodeFS.promises.realpath(path)) !== path
        )
          throw sourceChanged();
        if (initial.isDirectory()) {
          const directory = await NodeFS.promises.opendir(`/proc/self/fd/${fd.fd}`);
          try {
            for (;;) {
              const entry = await directory.read();
              if (!entry) break;
              await walk(
                path + "/" + entry.name,
                relative ? relative + "/" + entry.name : entry.name,
                depth + 1,
              );
            }
          } finally {
            await directory.close();
          }
        } else {
          bytes += initial.size;
          if (
            ++files > limits.maxFiles ||
            initial.size < 0n ||
            bytes > BigInt(limits.maxBytes) ||
            (relative === SKILL_MANIFEST_FILE && initial.size > BigInt(limits.maxManifestBytes))
          )
            throw sourceChanged();
          const content = Buffer.alloc(Number(initial.size));
          let offset = 0;
          while (offset < content.length) {
            const read = await fd.read(content, offset, content.length - offset, offset);
            if (read.bytesRead === 0) throw sourceChanged();
            offset += read.bytesRead;
          }
          if ((await fd.read(Buffer.alloc(1), 0, 1, content.length)).bytesRead !== 0)
            throw sourceChanged();
          inventory.push({ relative, path, bytes: content });
        }
        if (
          sourceStat(await fd.stat({ bigint: true })) !== fingerprint ||
          sourceStat(await NodeFS.promises.lstat(path, { bigint: true })) !== fingerprint
        )
          throw sourceChanged();
        receipts.push({ path, directory: initial.isDirectory(), stat: fingerprint });
      } finally {
        await fd.close();
      }
    };
    await walk(selected.packagePath, "", 0);
    const manifestFile = inventory.find((file) => file.relative === SKILL_MANIFEST_FILE);
    if (!manifestFile) throw sourceChanged();
    const manifest = decodeSourceManifest(manifestFile.bytes.toString("utf8"));
    if (
      manifest.id !== selected.skillId ||
      manifest.key !== selected.key ||
      manifest.ownership !== "t3" ||
      manifest.revision.hash !== selected.expectedHash ||
      paths.basename(selected.packagePath) !== selected.key ||
      paths.dirname(selected.packagePath) !==
        (manifest.scope === "global" ? roots.global : roots.project)
    )
      throw sourceChanged();
    const hash = NodeCrypto.createHash("sha256");
    for (const file of inventory.sort((a, b) => a.relative.localeCompare(b.relative))) {
      if (file.relative === SKILL_MANIFEST_FILE) continue;
      hash
        .update(file.relative)
        .update("\0")
        .update(String(file.bytes.length))
        .update("\0")
        .update(file.bytes);
    }
    if (hash.digest("hex") !== selected.expectedHash) throw sourceChanged();
  }
  const check = () => {
    catalogue();
    for (const receipt of receipts) {
      const fd = NodeFS.openSync(receipt.path, receipt.directory ? directoryFlags : fileFlags);
      try {
        const stat = NodeFS.fstatSync(fd, { bigint: true });
        if (
          sourceStat(stat) !== receipt.stat ||
          sourceStat(NodeFS.lstatSync(receipt.path, { bigint: true })) !== receipt.stat ||
          NodeFS.realpathSync(receipt.path) !== receipt.path ||
          NodeFS.realpathSync(`/proc/self/fd/${fd}`) !== receipt.path
        )
          throw sourceChanged();
      } finally {
        NodeFS.closeSync(fd);
      }
    }
  };
  check();
  return check;
};
interface WorkspaceMetadata {
  readonly directories: ReadonlyArray<string>;
  readonly assigned: string;
  readonly primary: string;
  readonly common: string;
  readonly gitDirectory: string;
  readonly assignedHead: string;
  readonly primaryHead: string | null;
}
interface WorkspaceFence {
  readonly metadata: WorkspaceMetadata;
  readonly directories: ReadonlyArray<{
    readonly path: string;
    readonly dev: string;
    readonly ino: string;
  }>;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly dev: string;
    readonly ino: string;
    readonly digest: string;
  } | null>;
}
const workspaceReceipt = (
  paths: Path.Path,
  metadata: WorkspaceMetadata,
  expected?: WorkspaceFence,
): WorkspaceFence => {
  const handles = new Map<string, number>();
  const identity = (stat: { readonly dev: number | bigint; readonly ino: number | bigint }) => ({
    dev: String(stat.dev),
    ino: String(stat.ino),
  });
  const invalid = () => {
    throw deny("Pi final workspace metadata fence changed or is unavailable");
  };
  const canonical = (path: string) => {
    if (
      !paths.isAbsolute(path) ||
      paths.normalize(path) !== path ||
      path.length > 4096 ||
      path.split("/").length > 64
    )
      invalid();
  };
  const directory = (path: string): number => {
    canonical(path);
    const cached = handles.get(path);
    if (cached !== undefined) return cached;
    const parent = path === "/" ? undefined : directory(paths.dirname(path));
    const entry = parent === undefined ? "/" : `/proc/self/fd/${parent}/${paths.basename(path)}`;
    const before = NodeFS.lstatSync(entry, { bigint: true });
    if (!before.isDirectory()) return invalid();
    const fd = NodeFS.openSync(entry, directoryFlags);
    handles.set(path, fd);
    const stat = NodeFS.fstatSync(fd, { bigint: true });
    if (
      encode(identity(before)) !== encode(identity(stat)) ||
      NodeFS.realpathSync(`/proc/self/fd/${fd}`) !== path ||
      NodeFS.realpathSync(path) !== path
    )
      invalid();
    return fd;
  };
  const read = (path: string, optional = false) => {
    canonical(path);
    const parent = directory(paths.dirname(path));
    const entry = `/proc/self/fd/${parent}/${paths.basename(path)}`;
    const before = NodeFS.lstatSync(entry, { throwIfNoEntry: false });
    if (!before) {
      if (optional) return null;
      return invalid();
    }
    if (!before.isFile() || before.size > 16384 || before.nlink !== 1) return invalid();
    const fd = NodeFS.openSync(entry, fileFlags);
    try {
      const stat = NodeFS.fstatSync(fd, { bigint: true });
      if (
        !stat.isFile() ||
        stat.dev !== BigInt(before.dev) ||
        stat.ino !== BigInt(before.ino) ||
        stat.size > 16384n
      )
        return invalid();
      const buffer = Buffer.alloc(16385);
      const count = NodeFS.readSync(fd, buffer, 0, buffer.length, 0);
      const after = NodeFS.fstatSync(fd, { bigint: true });
      const current = NodeFS.lstatSync(entry, { bigint: true });
      if (
        BigInt(count) !== stat.size ||
        count > 16384 ||
        stat.dev !== after.dev ||
        stat.ino !== after.ino ||
        stat.size !== after.size ||
        stat.mtimeNs !== after.mtimeNs ||
        stat.ctimeNs !== after.ctimeNs ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        current.size !== stat.size ||
        current.mtimeNs !== stat.mtimeNs ||
        current.ctimeNs !== stat.ctimeNs
      )
        return invalid();
      const bytes = buffer.subarray(0, count);
      return {
        path,
        dev: String(stat.dev),
        ino: String(stat.ino),
        digest: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } finally {
      NodeFS.closeSync(fd);
    }
  };
  try {
    if (metadata.directories.length > 8) invalid();
    const directories = metadata.directories.map((path) => ({
      path,
      ...identity(NodeFS.fstatSync(directory(path), { bigint: true })),
    }));
    const assignedLink = read(metadata.assigned + "/.git");
    const gitdir = read(metadata.gitDirectory + "/gitdir");
    const commondir = read(metadata.gitDirectory + "/commondir");
    if (
      !assignedLink ||
      !gitdir ||
      !commondir ||
      !assignedLink.text.startsWith("gitdir: ") ||
      paths.resolve(metadata.assigned, assignedLink.text.slice(8).trim()) !==
        metadata.gitDirectory ||
      paths.resolve(metadata.gitDirectory, gitdir.text.trim()) !== metadata.assigned + "/.git" ||
      paths.resolve(metadata.gitDirectory, commondir.text.trim()) !== metadata.common
    )
      invalid();
    const primaryEntry = `/proc/self/fd/${directory(metadata.primary)}/.git`;
    const primaryStat = NodeFS.lstatSync(primaryEntry);
    const primaryLink = primaryStat.isDirectory() ? null : read(metadata.primary + "/.git");
    if (
      primaryLink &&
      (!primaryLink.text.startsWith("gitdir: ") ||
        paths.resolve(metadata.primary, primaryLink.text.slice(8).trim()) !== metadata.common)
    )
      invalid();
    if (primaryStat.isDirectory() && NodeFS.realpathSync(primaryEntry) !== metadata.common)
      invalid();
    const files = [
      assignedLink,
      gitdir,
      commondir,
      primaryLink,
      read(metadata.common + "/config", true),
      read(metadata.common + "/config.worktree", true),
      read(metadata.gitDirectory + "/config.worktree", true),
    ].map((file) =>
      file ? { path: file.path, dev: file.dev, ino: file.ino, digest: file.digest } : null,
    );
    const assignedHead = read(metadata.gitDirectory + "/HEAD");
    const primaryHead = read(metadata.common + "/HEAD");
    if (
      !assignedHead ||
      assignedHead.text.trim() !== metadata.assignedHead ||
      !primaryHead ||
      (metadata.primaryHead === null
        ? !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(primaryHead.text.trim())
        : primaryHead.text.trim() !== metadata.primaryHead)
    )
      invalid();
    if (
      expected &&
      (encode(directories) !== encode(expected.directories) ||
        encode(files) !== encode(expected.files))
    )
      invalid();
    for (const [path, fd] of handles) {
      if (
        NodeFS.realpathSync(`/proc/self/fd/${fd}`) !== path ||
        NodeFS.realpathSync(path) !== path ||
        encode(identity(NodeFS.fstatSync(fd, { bigint: true }))) !==
          encode(identity(NodeFS.lstatSync(path, { bigint: true })))
      )
        invalid();
    }
    return { metadata, directories, files };
  } finally {
    const closed = [...handles.values()].toReversed().map((fd) => {
      try {
        NodeFS.closeSync(fd);
        return true;
      } catch {
        return false;
      }
    });
    if (closed.some((value) => !value)) invalid();
  }
};
const finalWorkspaceFence = (paths: Path.Path, fence: WorkspaceFence, signal?: AbortSignal) =>
  Effect.try({
    try: () => {
      if (signal?.aborted) throw deny("Pi operation canceled");
      workspaceReceipt(paths, fence.metadata, fence);
      if (signal?.aborted) throw deny("Pi operation canceled");
    },
    catch: (error) =>
      isRuntimeError(error) ? error : deny("Pi final workspace metadata fence is unavailable"),
  });

export interface PiManagedRuntimeLiveOptions {
  /** One factory shares cancellation across its instances; never a wire option. */
  readonly subscriptionAbortControllers?: Set<AbortController>;
  /** One production factory retains uncertain accounting across its per-instance runtimes. */
  readonly subscriptionAccountingState?: { failure: unknown };
  /** Root-only disposable subscription selection, never provider configuration. */
  readonly subscriptionTest?: {
    readonly selection: ProjectTeamPiSubscriptionTestSelection;
    readonly credentialSource: { readonly directory: string; readonly format: "pi" | "codex" };
  };
  readonly environmentId: string;
  readonly agentDirectory: string;
  readonly nativeStateRoot: string;
  readonly protectedRoots: ReadonlyArray<string>;
  readonly runtimeFiles: PiManagedLaunch["runtimeFiles"];
  readonly revalidateRuntime?: Effect.Effect<void, PiManagedRuntimeError>;
  /** Private factory allocation; invoked only for the current nonempty frozen selection. */
  readonly allocateSkillStage?: Effect.Effect<
    PiSkillStageLifetime,
    PiManagedRuntimeError,
    Scope.Scope
  >;
  /** The owned state is mounted at /state; the worker must use /state/sessions. */
  readonly workerArgv: (
    identity: PiWorkerIdentity,
    operation: PiWorkerOperation,
    nativeStateDirectory: string,
  ) => ReadonlyArray<string>;
  readonly memoryBytes: number;
  readonly cleanupDeadlineMs: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly readCatalogue: Effect.Effect<
    | {
        readonly source: "https://api.commandcode.ai/provider/v1/models";
        readonly fetchedAt: string;
        readonly selectedEntry: {
          readonly id: typeof PiManagedModel.Type;
          readonly owned_by: "command-code";
          readonly context_length: number;
          readonly supported_endpoints: ReadonlyArray<string>;
          readonly max_output_tokens?: number;
        };
      }
    | undefined,
    PiManagedRuntimeError
  >;
  readonly transport: PiModelBrokerConfig["transport"];
}

/** Builds the production port. Only this parent-owned constructor supplies the worker closure. */
export const makePiManagedRuntimeLive = Effect.fn("makePiManagedRuntimeLive")(function* (
  supplied: PiManagedRuntimeLiveOptions,
) {
  const options = {
    ...supplied,
    runtimeFiles: structuredClone(supplied.runtimeFiles),
    protectedRoots: [
      ...supplied.protectedRoots,
      ...(supplied.subscriptionTest === undefined
        ? []
        : [supplied.subscriptionTest.credentialSource.directory]),
    ],
    subscriptionTest:
      supplied.subscriptionTest === undefined
        ? undefined
        : Object.freeze({
            selection: Object.freeze({ ...supplied.subscriptionTest.selection }),
            credentialSource: Object.freeze({ ...supplied.subscriptionTest.credentialSource }),
          }),
  };
  const operations = yield* makeProjectTeamPiOperations({ environmentId: options.environmentId });
  const mailbox = yield* makeProjectTeamMailboxConsumption({
    environmentId: options.environmentId,
  });
  const mailboxTurns = yield* makeProjectTeamMailboxTurns({
    environmentId: options.environmentId,
    lookupInTransaction: operations.lookupInTransaction,
  });
  const reviewFreshness = yield* makeProjectTeamReviewFreshness({
    environmentId: options.environmentId,
  });
  const requiredContext = yield* makeProjectTeamContext({
    environmentId: options.environmentId,
    maximumEnvironmentModelCalls: 128,
  });
  const authorization = yield* ProjectTeamAuthorization;
  const gateway = yield* ProjectWorkGateway;
  const skillRepository = yield* Effect.serviceOption(ManagedSkillRepository);
  const serverConfig = yield* Effect.serviceOption(ServerConfig);
  const materialization = yield* Effect.serviceOption(SkillMaterializationService);
  const sql = yield* SqlClient.SqlClient;
  const subscriptionPolicy =
    options.subscriptionTest === undefined
      ? undefined
      : makeProjectTeamPiSubscriptionParentPolicy(sql, options.subscriptionTest.selection);
  const subscriptionControllers =
    supplied.subscriptionAbortControllers ?? new Set<AbortController>();
  const stopSubscription = () => {
    for (const controller of subscriptionControllers) controller.abort();
  };
  const subscriptionAccountingState: { failure: unknown } =
    supplied.subscriptionAccountingState ?? { failure: undefined };
  const assertSubscriptionAccountingHealthy = () =>
    subscriptionAccountingState.failure === undefined
      ? Effect.void
      : Effect.fail(deny("Pi subscription accounting requires reconciliation", "uncertain"));
  const stopAfterSubscriptionAccountingFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() => {
          subscriptionAccountingState.failure ??= cause;
          stopSubscription();
        }),
      ),
    );
  const accountingModels =
    options.subscriptionTest === undefined
      ? piManagedModels
      : [...piManagedModels, "gpt-6-luna" as const];
  const accountings = yield* Effect.forEach(accountingModels, (model) =>
    Effect.gen(function* () {
      const route = piBrokerModelRoute(model);
      const accounting = yield* makeAccounting({
        environmentId: options.environmentId,
        routeId: route.routeId,
        model,
        acceptedReportedModels: route.acceptedReportedModels,
        resolveOperation: operations.resolveOperation,
        ...(model === "gpt-6-luna" && options.subscriptionTest !== undefined
          ? { subscriptionTest: options.subscriptionTest.selection }
          : {}),
      });
      return { model, accounting };
    }),
  );
  const crypto = yield* Crypto.Crypto;
  const clock = yield* Clock.Clock;
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const services = yield* Effect.context<
    Crypto.Crypto | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const perform = Effect.runPromiseWith(services);
  const git = Effect.fn("PiManagedRuntimeLive.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("/usr/bin/git", ["-C", cwd, ...args], {
            env: {
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_TERMINAL_PROMPT: "0",
            },
            extendEnv: false,
            stdin: "ignore",
          }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: 262144 }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: 8192 }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (
          Number(code) !== 0 ||
          stderr.truncated ||
          stdout.truncated ||
          stdout.invalidUtf8 ||
          stderr.invalidUtf8
        )
          return yield* deny("Assigned Git worktree cannot be verified");
        return stdout.text;
      }),
    );
  });
  const verifyWorkspace = Effect.fn("PiManagedRuntimeLive.verifyWorkspace")(function* (
    authority: ProjectTeamAuthority,
    agentDirectory: string,
    expected?: {
      readonly protectedRoots: ReadonlyArray<string>;
      readonly fingerprint: string;
      readonly fence: WorkspaceFence;
    },
  ) {
    const cwd = authority.binding.worktree;
    const branchRef = authority.binding.branch.startsWith("refs/heads/")
      ? authority.binding.branch
      : `refs/heads/${authority.binding.branch}`;
    const directoryIdentity = Effect.fn("PiManagedRuntimeLive.directoryIdentity")(function* (
      directory: string,
    ) {
      if ((yield* fs.realPath(directory)) !== directory)
        return yield* deny("Pi Git directory is not canonical");
      const stat = yield* fs.stat(directory);
      if (stat.type !== "Directory" || Option.isNone(stat.ino))
        return yield* deny("Pi Git directory identity is unavailable");
      return { directory, dev: stat.dev, ino: stat.ino.value };
    });
    const assigned = yield* directoryIdentity(cwd);
    const agent = yield* directoryIdentity(agentDirectory);
    if (
      (yield* git(cwd, ["rev-parse", "--show-toplevel"])).trim() !== cwd ||
      (yield* git(cwd, ["symbolic-ref", "HEAD"])).trim() !== branchRef
    )
      return yield* deny("Assigned canonical Git worktree or branch changed");
    const records = (yield* git(cwd, ["worktree", "list", "--porcelain", "-z"]))
      .split("\0\0")
      .filter(Boolean)
      .map((record) => record.split("\0"));
    const primaryRecord = records[0];
    const primaryEntries = primaryRecord?.filter((entry) => entry.startsWith("worktree "));
    if (
      branchRef === "refs/heads/main" ||
      branchRef === "refs/heads/master" ||
      primaryRecord?.includes(`branch ${branchRef}`) ||
      primaryRecord?.includes(`worktree ${cwd}`) ||
      !primaryEntries ||
      primaryEntries.length !== 1 ||
      !records.some(
        (record) => record.includes(`worktree ${cwd}`) && record.includes(`branch ${branchRef}`),
      )
    )
      return yield* deny("Pi requires a registered isolated worktree");
    const primaryDirectory = primaryEntries[0]!.slice("worktree ".length);
    const primary = yield* directoryIdentity(primaryDirectory);
    const commonDirectory = (yield* git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).trim();
    const common = yield* directoryIdentity(commonDirectory);
    if (
      commonDirectory === cwd ||
      commonDirectory.startsWith(cwd + "/") ||
      primaryDirectory.startsWith(cwd + "/") ||
      (yield* git(primaryDirectory, ["rev-parse", "--show-toplevel"])).trim() !==
        primaryDirectory ||
      (yield* git(primaryDirectory, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])).trim() !== commonDirectory
    )
      return yield* deny("Pi primary checkout or common Git directory changed");
    const gitDirectory = (yield* git(cwd, ["rev-parse", "--absolute-git-dir"])).trim();
    const ownedGit = yield* directoryIdentity(gitDirectory);
    if (
      (yield* git(primaryDirectory, ["rev-parse", "--absolute-git-dir"])).trim() !== commonDirectory
    )
      return yield* deny("Pi primary Git metadata layout is unsupported");
    const configurationEntries = (yield* git(cwd, ["config", "--null", "--list"])).split("\0");
    if (
      configurationEntries.some((entry) =>
        /^(?:include|includeif)\./i.test(entry.split("\n", 1)[0]!),
      )
    )
      return yield* deny("Pi Git configuration includes are unsupported");
    // HEAD may advance in the primary checkout; its registered path, branch and
    // actual directory identities must remain the same for this owned launch.
    const fingerprint = encode({
      assigned,
      ownedGit,
      agent,
      primary,
      common,
      primaryRecord: primaryRecord!.filter((entry) => !entry.startsWith("HEAD ")),
    });
    if (
      (expected && expected.fingerprint !== fingerprint) ||
      encode(assigned) !== encode(yield* directoryIdentity(cwd)) ||
      encode(agent) !== encode(yield* directoryIdentity(agentDirectory)) ||
      encode(primary) !== encode(yield* directoryIdentity(primaryDirectory)) ||
      encode(common) !== encode(yield* directoryIdentity(commonDirectory))
    )
      return yield* deny("Pi registered workspace ownership changed");
    const primaryBranch = primaryRecord!
      .find((entry) => entry.startsWith("branch "))
      ?.slice("branch ".length);
    if (!primaryBranch && !primaryRecord!.includes("detached"))
      return yield* deny("Pi primary Git HEAD layout is unsupported");
    const fence =
      expected?.fence ??
      (yield* Effect.try({
        try: () =>
          workspaceReceipt(paths, {
            directories: [cwd, agentDirectory, primaryDirectory, commonDirectory, gitDirectory],
            assigned: cwd,
            primary: primaryDirectory,
            common: commonDirectory,
            gitDirectory,
            assignedHead: `ref: ${branchRef}`,
            primaryHead: primaryBranch ? `ref: ${primaryBranch}` : null,
          }),
        catch: () => deny("Pi fixed workspace metadata is unavailable"),
      }));
    yield* finalWorkspaceFence(paths, fence);
    return {
      fence,
      protectedRoots: [
        ...new Set([...options.protectedRoots, agentDirectory, primaryDirectory, commonDirectory]),
      ],
      fingerprint,
    };
  });
  const configuration = Effect.fn("PiManagedRuntimeLive.configuration")(function* (
    agentDirectory: string,
    authority?: ProjectTeamAuthority,
  ) {
    if (
      authority?.binding.model === "gpt-6-luna" ||
      (!authority && options.subscriptionTest !== undefined)
    ) {
      const selected = options.subscriptionTest;
      if (!selected || (authority && authority.binding.projectId !== selected.selection.projectId))
        return yield* deny("Pi subscription requires its private root selection");
      return yield* inspectPiSubscriptionConfiguration({
        agentDirectory,
        runtimeVersion: "0.99.1",
        nodeVersion: process.versions.node,
        selectedModel: { provider: "openai-codex", model: "gpt-6-luna" },
        reasoningEffort: "high",
        serviceTier: "default",
        limits: {
          maxInputTokens: options.maxInputTokens,
          maxOutputTokens: options.maxOutputTokens,
          deadlineMs: Math.min(300_000, authority?.binding.configuration.maxDurationMs ?? 300_000),
        },
      }).pipe(
        Effect.mapError(() => deny("Pi subscription configuration unavailable", "unavailable")),
      );
    }
    const catalogue = yield* options.readCatalogue.pipe(
      Effect.mapError(() => deny("Pi catalogue read unavailable", "unavailable")),
    );
    if (!catalogue) return yield* deny("Refresh the Pi model catalogue explicitly", "unavailable");
    const fetchedAt = Date.parse(catalogue.fetchedAt);
    const now = yield* Clock.currentTimeMillis;
    if (!Number.isSafeInteger(fetchedAt) || fetchedAt > now || now - fetchedAt >= 86_400_000)
      return yield* deny("Pi model catalogue is stale", "unavailable");
    const maxInputTokens = options.maxInputTokens;
    const maxOutputTokens = options.maxOutputTokens;
    if (authority && maxInputTokens + maxOutputTokens > authority.binding.configuration.maxTokens)
      return yield* deny("Pi request limits exceed the frozen run budget");
    return yield* inspectPiNativeConfiguration({
      agentDirectory,
      selectedModel: {
        provider: "command-code",
        model: authority?.binding.model ?? catalogue.selectedEntry.id,
      },
      catalogue,
      limits: {
        maxInputTokens,
        maxOutputTokens,
        deadlineMs: Math.min(300_000, authority?.binding.configuration.maxDurationMs ?? 300_000),
      },
      nodeVersion: process.versions.node,
    });
  });
  const contextFor = (authority: ProjectTeamAuthority) => {
    const binding = authority.binding;
    const task = authority.state.tasks.find((entry) => entry.taskId === binding.taskId);
    const records = authority.state.foundationRecords ?? [];
    return encode({
      binding,
      role: authority.role,
      task,
      specification: task?.specification,
      plan: records.filter(
        (entry) =>
          entry.kind === "plan-revision" &&
          entry.taskId === binding.taskId &&
          entry.planRevision === binding.planRevision,
      ),
      gates: records.filter(
        (entry) =>
          entry.kind === "gate" &&
          [binding.authorizationGateId, binding.specificationGateId, binding.planGateId].includes(
            entry.recordId,
          ),
      ),
    });
  };
  const forInstance: PiManagedRuntime["Service"]["forInstance"] = (instance) =>
    guard(
      Effect.gen(function* () {
        const agentDirectory = instance.configuration.agentDirectory ?? options.agentDirectory;
        const stageScopes = new Set<Scope.Closeable>();
        let closing = false;
        const active = new Map<
          ThreadId,
          {
            readonly prepared: PiManagedPreparedOperation;
            readonly stop: Effect.Effect<void, PiManagedRuntimeError>;
          }
        >();
        const preparing = new Map<ThreadId, Effect.Effect<void>>();
        const replayReceipts = new Map<ThreadId, () => void>();
        const sessionFor = (
          authority: ProjectTeamAuthority,
          native?: PiNativeReference,
        ): ProviderSession => ({
          provider,
          providerInstanceId: instance.instanceId,
          threadId: authority.binding.threadId,
          status: "ready",
          runtimeMode: "approval-required",
          cwd: authority.binding.worktree,
          model: authority.binding.model,
          createdAt: IsoDateTime.make(authority.binding.updatedAt),
          updatedAt: IsoDateTime.make(authority.binding.updatedAt),
          ...(native ? { resumeCursor: native } : {}),
        });
        const identity = (threadId: ThreadId) => ({
          providerInstanceId: instance.instanceId,
          threadId,
        });
        const inspect = guard(
          Effect.gen(function* () {
            const native = yield* configuration(agentDirectory);
            const checkedAt = DateTime.formatIso(yield* DateTime.now);
            return buildServerProvider({
              presentation: { displayName: "Pi Agent" },
              enabled: instance.enabled,
              checkedAt,
              models: [
                {
                  slug: native.model,
                  name: piBrokerModelRoute(native.model).name,
                  isCustom: false,
                  capabilities: {},
                },
              ],
              probe: {
                installed: true,
                version: "0.99.1",
                status: "ready",
                auth: { status: "unknown" },
                message: `Managed Linux runtime; catalogue checked ${native.catalogue.fetchedAt}.`,
              },
            });
          }),
        );
        const selectedSkills = Effect.fn("PiManagedRuntimeLive.selectedSkills")(function* (
          authority: ProjectTeamAuthority,
          workspace: { readonly fence: WorkspaceFence },
        ) {
          if (authority.binding.configuration.skillIds.length === 0) return Object.freeze([]);
          if (Option.isNone(skillRepository))
            return yield* deny("Managed skill repository is unavailable", "unavailable");
          return yield* resolvePiManagedSkillSelection({
            projectRoot: workspace.fence.metadata.primary,
            selectedSkillIds: authority.binding.configuration.skillIds,
            roleSkillIds: authority.role.skills,
          }).pipe(
            Effect.provideService(ManagedSkillRepository, skillRepository.value),
            Effect.mapError((error) => deny(error.detail, error.code)),
          );
        });
        const selectedSnapshot = Effect.fn("PiManagedRuntimeLive.selectedSnapshot")(function* (
          authority: ProjectTeamAuthority,
          workspace: { readonly fence: WorkspaceFence },
        ) {
          if (authority.binding.configuration.skillIds.length === 0)
            return { selection: Object.freeze([]), fence: () => {} };
          if (Option.isNone(serverConfig))
            return yield* deny("Managed skill roots are unavailable", "unavailable");
          const project = workspace.fence.metadata.primary;
          const catalogue = yield* Effect.try({
            try: () =>
              skillCatalogueReceipt(
                [
                  serverConfig.value.stateDir,
                  serverConfig.value.managedSkillsDir,
                  project + "/.t3code",
                  project + "/.t3code/skills",
                ],
                new Set([serverConfig.value.managedSkillsDir, project + "/.t3code/skills"]),
              ),
            catch: () => sourceChanged(),
          });
          const selection = yield* selectedSkills(authority, workspace);
          const fence = yield* Effect.tryPromise({
            try: () =>
              captureSkillSources(paths, selection, catalogue, {
                global: serverConfig.value.managedSkillsDir,
                project: project + "/.t3code/skills",
              }),
            catch: () => sourceChanged(),
          }).pipe(Effect.uninterruptible);
          return { selection, fence };
        });
        const authorizeSkills: PiManagedRuntimeInstance["authorizeSkills"] = (suppliedRequest) =>
          guard(
            Effect.gen(function* () {
              if (!instance.enabled) return yield* deny("Pi instance disabled");
              const snapshot = yield* Effect.try({
                try: () => structuredClone(suppliedRequest),
                catch: () => deny("Pi skill request cannot be copied"),
              });
              const request = yield* decodeSkillCandidates(snapshot).pipe(
                Effect.mapError(() => deny("Pi skill request is invalid")),
              );
              if (
                request.runtime.providerInstanceId !== instance.instanceId ||
                request.runtime.sessionId !==
                  `thread-${digest(request.runtime.threadId).slice(0, 24)}` ||
                new Set(request.skills.map((skill) => skill.key)).size !== request.skills.length
              )
                return yield* deny("Pi skill request identity is invalid");
              const authority = yield* operations.current(identity(request.runtime.threadId), true);
              if (
                authority.binding.configuration.runtimeVersion !== "0.99.1" ||
                authority.binding.configuration.instructionsHash !==
                  digest(authority.role.instructions)
              )
                return yield* deny("Pi frozen runtime or instructions digest mismatch");
              if (request.runtime.cwd !== authority.binding.worktree)
                return yield* deny("Pi skill cwd differs from durable assignment");
              const context = contextFor(authority);
              const workspace = yield* verifyWorkspace(authority, agentDirectory);
              const { selection, fence: sourceFence } = yield* selectedSnapshot(
                authority,
                workspace,
              );
              if (
                selection.some(
                  (selected) =>
                    !request.skills.some(
                      (candidate) =>
                        candidate.key === selected.key &&
                        candidate.packagePath === selected.packagePath,
                    ),
                )
              )
                return yield* deny(
                  "Selected owned skill is missing from current catalogue candidates",
                );
              const current = yield* operations.current(identity(request.runtime.threadId), true);
              if (contextFor(current) !== context)
                return yield* deny("Pi skill authority changed during admission", "conflict");
              yield* verifyWorkspace(current, agentDirectory, workspace);
              return yield* operations.admitCurrent(
                identity(request.runtime.threadId),
                (latest) => {
                  if (contextFor(latest) !== context)
                    throw deny(
                      "Pi skill authority changed during workspace validation",
                      "conflict",
                    );
                  workspaceReceipt(paths, workspace.fence.metadata, workspace.fence);
                  sourceFence();
                  return Object.freeze(selection.map((selected) => selected.key));
                },
              );
            }),
          );
        const prepareOperation: PiManagedRuntimeInstance["prepareOperation"] = (
          suppliedRequest,
          observe,
        ) => {
          let request: typeof suppliedRequest;
          try {
            request = structuredClone(suppliedRequest);
          } catch {
            return Effect.fail(deny("Pi operation request cannot be copied"));
          }
          let attempted = false;
          return Effect.suspend(() => {
            if (attempted || closing)
              return Effect.fail(deny("Pi preparation already attempted or closing", "conflict"));
            attempted = true;
            if (active.has(request.threadId) || preparing.has(request.threadId))
              return Effect.fail(deny("Pi operation is already preparing or active", "conflict"));
            // A new preparation supersedes the completed receipt's ephemeral lifetime.
            replayReceipts.get(request.threadId)?.();
            const preparation = { canceled: false, done: Promise.withResolvers<void>() };

            const assertPreparing = () => {
              if (preparation.canceled || closing)
                throw deny("Pi preparation canceled", "conflict");
            };
            const preparationCurrent = Effect.try({
              try: assertPreparing,
              catch: () => deny("Pi preparation canceled", "conflict"),
            });
            let resourceScope: Scope.Closeable | undefined;
            const closeResources = Effect.suspend(() => {
              const scope = resourceScope;
              return scope
                ? Scope.close(scope, Exit.void).pipe(
                    Effect.ensuring(Effect.sync(() => stageScopes.delete(scope))),
                  )
                : Effect.void;
            });
            let skillStage: PiSkillStageLifetime | undefined;
            let stageSealed = false;
            let durableAttempted = false;
            let preparationFiber:
              | Fiber.Fiber<PiManagedPreparedOperation, PiManagedRuntimeError>
              | undefined;
            preparing.set(
              request.threadId,
              Effect.suspend(() => {
                preparation.canceled = true;
                // A durable handoff must complete before we can settle its never-started owner.
                // Earlier interruptible reads are canceled; owned descriptor IO joins its closes.
                const cancel =
                  !durableAttempted && preparationFiber
                    ? Fiber.interrupt(preparationFiber)
                    : Effect.void;
                return cancel.pipe(Effect.andThen(Effect.promise(() => preparation.done.promise)));
              }),
            );
            const prepare = guard(
              Effect.gen(function* () {
                yield* preparationCurrent;
                if (!instance.enabled) return yield* deny("Pi instance disabled");
                if (active.has(request.threadId))
                  return yield* deny("Pi operation is already prepared or active", "conflict");
                const authority = yield* operations.current(
                  identity(request.threadId),
                  request.kind === "initialize",
                );
                const binding = authority.binding;
                const laterTurn =
                  request.kind === "prompt"
                    ? yield* mailboxTurns.readForOperation({
                        projectId: binding.projectId,
                        bindingId: binding.recordId,
                        generation: binding.generation,
                        providerInstanceId: binding.providerInstanceId,
                        request,
                      })
                    : { _tag: "NotLaterTurn" as const };
                if (laterTurn._tag === "LaterTurn")
                  request = structuredClone(laterTurn.decision.request);
                const compactBoundary =
                  request.kind === "compact"
                    ? yield* operations.readCompaction(identity(request.threadId), request)
                    : undefined;
                if (
                  (request.cwd !== undefined && request.cwd !== binding.worktree) ||
                  (request.runtimeMode !== undefined &&
                    request.runtimeMode !== "approval-required") ||
                  (request.modelSelection !== undefined &&
                    (request.modelSelection.instanceId !== instance.instanceId ||
                      request.modelSelection.model !== binding.model))
                )
                  return yield* deny("Pi caller hints differ from durable assignment");
                if (
                  binding.configuration.runtimeVersion !== "0.99.1" ||
                  binding.configuration.instructionsHash !== digest(authority.role.instructions)
                )
                  return yield* deny("Pi frozen runtime or instructions digest mismatch");
                const supported = new Set<string>([
                  ...piProjectWorkToolCapabilities,
                  ...piLocalToolDefinitions.map((tool) => tool.capabilityId),
                ]);
                if (
                  binding.configuration.toolIds.some(
                    (tool) => !supported.has(tool) || !authority.role.tools.includes(tool),
                  )
                )
                  return yield* deny("Pi profile includes an unsupported tool", "unavailable");
                const localTools = piLocalToolDefinitions.filter(
                  (tool) =>
                    binding.configuration.toolIds.includes(tool.capabilityId) &&
                    authority.role.tools.includes(tool.capabilityId),
                );
                const workspace = yield* verifyWorkspace(authority, agentDirectory);
                const { selection, fence: sourceFence } = yield* selectedSnapshot(
                  authority,
                  workspace,
                );
                yield* preparationCurrent;
                const resourceHash = piManagedSkillResourceIdentity(selection);
                const requestHash = digest(canonicalProjectWorkPayload(request));
                if (compactBoundary?.association) {
                  const prefix = contextFor(authority);
                  yield* requiredContext.readRequired(compactBoundary.original, {
                    optionalTextBudgetBytes: Math.max(
                      0,
                      65536 - Buffer.byteLength(prefix + "\n\n", "utf8"),
                    ),
                  });
                }
                const replay = yield* operations.lookup(
                  identity(request.threadId),
                  request,
                  requestHash,
                  resourceHash,
                );
                if (replay) {
                  const context = contextFor(replay.authority);
                  const nativeStateDirectory =
                    options.nativeStateRoot +
                    "/" +
                    digest(
                      encode([
                        options.environmentId,
                        instance.instanceId,
                        request.threadId,
                        binding.recordId,
                        binding.generation,
                      ]),
                    );
                  const nativeFence = () =>
                    nativeStateReceipt(
                      (replay.replayHead ?? replay).nativeState,
                      nativeStateDirectory,
                    );
                  const validateReplay = guard(
                    Effect.gen(function* () {
                      yield* preparationCurrent;
                      const current = yield* operations.lookup(
                        identity(request.threadId),
                        request,
                        requestHash,
                        resourceHash,
                      );
                      if (
                        !current ||
                        canonicalProjectWorkPayload(current.terminal) !==
                          canonicalProjectWorkPayload(replay.terminal) ||
                        encode(current.replayHead ?? null) !== encode(replay.replayHead ?? null) ||
                        contextFor(current.authority) !== context
                      )
                        return yield* deny("Pi replay receipt or authority changed", "conflict");
                      const head = current.replayHead ?? {
                        operation: current.operation,
                        native: current.native,
                        deadlineAtMs: current.deadlineAtMs,
                        resourceHash,
                      };
                      if (head.resourceHash !== resourceHash)
                        return yield* deny("Pi replay head resource identity changed", "conflict");
                      if (current.authority.role.role === "reviewer") {
                        const owner = current.authority.binding;
                        const retained =
                          request.kind === "initialize"
                            ? yield* reviewFreshness.readRetained(current.operation.operationId)
                            : yield* reviewFreshness.readForSession({
                                projectId: owner.projectId,
                                taskId: owner.taskId,
                                bindingId: owner.recordId,
                                generation: owner.generation,
                                providerInstanceId: owner.providerInstanceId,
                                threadId: owner.threadId,
                                sessionId: current.native.sessionId,
                                specRevision: owner.specRevision,
                                planRevision: owner.planRevision,
                              });
                        if (
                          !retained ||
                          retained.projectId !== owner.projectId ||
                          retained.taskId !== owner.taskId ||
                          retained.bindingId !== owner.recordId ||
                          retained.generation !== owner.generation ||
                          retained.providerInstanceId !== owner.providerInstanceId ||
                          retained.threadId !== owner.threadId ||
                          retained.specRevision !== owner.specRevision ||
                          retained.planRevision !== owner.planRevision ||
                          retained.native.sessionId !== current.native.sessionId ||
                          (request.kind === "initialize" &&
                            encode(retained.native) !== encode(current.native))
                        )
                          return yield* deny(
                            "Reviewer initialization has no retained fresh-session proof",
                            "uncertain",
                          );
                      }
                      const physical = workspace.fence.directories.find(
                        (entry) => entry.path === binding.worktree,
                      );
                      if (
                        !physical ||
                        physical.dev !== String(current.workspace.dev) ||
                        physical.ino !== String(current.workspace.ino)
                      )
                        return yield* deny(
                          "Pi replay workspace physical identity changed",
                          "conflict",
                        );
                      if (
                        piManagedSkillResourceIdentity(
                          yield* selectedSkills(current.authority, workspace),
                        ) !== resourceHash
                      )
                        return yield* deny("Pi replay selected content changed", "conflict");
                      yield* verifyWorkspace(current.authority, agentDirectory, workspace);
                      yield* configuration(agentDirectory, current.authority);
                      if (request.skillPlan !== undefined) {
                        if (Option.isNone(materialization))
                          return yield* deny(
                            "Pi replay skill materialization unavailable",
                            "unavailable",
                          );
                        yield* validatePiManagedSkillPlan({
                          selection,
                          skillPlan: request.skillPlan,
                          materialization: materialization.value,
                          threadId: request.threadId,
                          providerInstanceId: instance.instanceId,
                          authorizeCurrent: preparationCurrent,
                        }).pipe(
                          Effect.provideService(FileSystem.FileSystem, fs),
                          Effect.provideService(Path.Path, paths),
                        );
                      }
                      yield* Effect.try({
                        try: nativeFence,
                        catch: () => deny("Pi replay native ownership changed", "uncertain"),
                      });
                      yield* Effect.tryPromise({
                        try: () =>
                          readPiNativeSession({
                            sessionDirectoryRoot: nativeStateDirectory + "/sessions",
                            expectedCwd: "/workspace",
                            native: head.native,
                          }),
                        catch: () => deny("Pi replay native checkpoint unavailable", "uncertain"),
                      }).pipe(Effect.uninterruptible);
                      yield* Effect.try({
                        try: nativeFence,
                        catch: () => deny("Pi replay native ownership changed", "uncertain"),
                      });
                      return yield* operations.admitCurrent(
                        identity(request.threadId),
                        (latest) => {
                          assertPreparing();
                          if (
                            contextFor(latest) !== context ||
                            clock.currentTimeMillisUnsafe() >=
                              Math.min(current.deadlineAtMs, head.deadlineAtMs)
                          )
                            throw deny("Pi replay authority or deadline changed", "conflict");
                          workspaceReceipt(paths, workspace.fence.metadata, workspace.fence);
                          sourceFence();
                          nativeFence();
                          return {
                            terminal: current.terminal,
                            session: sessionFor(latest, head.native),
                          };
                        },
                        {
                          operationId: head.operation.operationId,
                          native: head.native,
                          resourceHash,
                        },
                      );
                    }),
                  );
                  yield* validateReplay;
                  const run = guard(
                    Effect.gen(function* () {
                      yield* preparationCurrent;
                      const owner = active.get(request.threadId);
                      if ((owner && owner.prepared !== prepared) || preparing.has(request.threadId))
                        return yield* deny("Pi replay thread has a newer owner", "conflict");
                      active.set(request.threadId, { prepared, stop });
                      return yield* validateReplay.pipe(
                        Effect.tap(preparationCurrent),
                        Effect.tap(() =>
                          Effect.sync(() => {
                            if (active.get(request.threadId)?.prepared === prepared)
                              active.delete(request.threadId);
                          }),
                        ),
                      );
                    }),
                  );
                  const steer: PiManagedPreparedOperation["steer"] = () =>
                    Effect.fail(deny("Completed Pi operation cannot receive controls", "conflict"));
                  const interrupt = Effect.fail(
                    deny("Completed Pi operation cannot receive controls", "conflict"),
                  );
                  const prepared: PiManagedPreparedOperation =
                    request.kind === "prompt"
                      ? {
                          kind: "prompt",
                          turnId: TurnId.make(replay.operation.operationId),
                          operation: replay.operation,
                          run,
                          steer,
                          interrupt,
                        }
                      : {
                          kind: request.kind,
                          operation: replay.operation,
                          ...(request.kind !== "compact"
                            ? {}
                            : {
                                replayHeadOperationId:
                                  replay.replayHead?.operation.operationId ??
                                  replay.operation.operationId,
                              }),
                          run,
                          steer,
                          interrupt,
                        };
                  // Successful reads release the work slot; one cancellation handle remains
                  // until stop or the next preparation, without rewriting settled history.
                  const cancelReplay = () => {
                    preparation.canceled = true;
                    if (active.get(request.threadId)?.prepared === prepared)
                      active.delete(request.threadId);
                    if (replayReceipts.get(request.threadId) === cancelReplay)
                      replayReceipts.delete(request.threadId);
                  };
                  const stop = Effect.sync(cancelReplay);
                  replayReceipts.set(request.threadId, cancelReplay);
                  active.set(request.threadId, { prepared, stop });
                  assertPreparing();
                  return prepared;
                }
                const nativeConfig = yield* configuration(agentDirectory, authority);
                const previous =
                  request.kind === "initialize" && binding.status === "reserved"
                    ? undefined
                    : yield* operations.nativeFor(identity(request.threadId));
                if (authority.role.role === "reviewer" && request.kind !== "initialize") {
                  if (!previous) return yield* deny("Reviewer requires its original fresh session");
                  const retained = yield* reviewFreshness.readForSession({
                    projectId: binding.projectId,
                    taskId: binding.taskId,
                    bindingId: binding.recordId,
                    generation: binding.generation,
                    providerInstanceId: binding.providerInstanceId,
                    threadId: binding.threadId,
                    sessionId: previous.native.sessionId,
                    specRevision: binding.specRevision,
                    planRevision: binding.planRevision,
                  });
                  if (!retained)
                    return yield* deny(
                      "Reviewer requires retained fresh-session proof",
                      "uncertain",
                    );
                }
                if (
                  previous &&
                  (previous.resourceHash ?? piManagedSkillResourceIdentity([])) !== resourceHash
                )
                  return yield* deny(
                    "Changed selected Pi skill content requires a new session",
                    "conflict",
                  );
                if (
                  request.resumeCursor !== undefined &&
                  encode(request.resumeCursor) !== encode(previous?.native ?? null)
                )
                  return yield* deny("Pi resume hint differs from durable native identity");
                const context = contextFor(authority);
                let authorityContext = context;
                const contextOperation = {
                  projectId: binding.projectId,
                  bindingId: binding.recordId,
                  generation: binding.generation,
                  providerInstanceId: binding.providerInstanceId,
                  threadId: binding.threadId,
                  operationId: request.operationId ?? "",
                  operationKind: request.kind === "compact" ? ("prompt" as const) : request.kind,
                };
                const readOperationContext = Effect.gen(function* () {
                  const currentTurn =
                    compactBoundary === undefined
                      ? yield* mailboxTurns.readForOperation({
                          projectId: binding.projectId,
                          bindingId: binding.recordId,
                          generation: binding.generation,
                          providerInstanceId: binding.providerInstanceId,
                          request,
                        })
                      : { _tag: "NotLaterTurn" as const };
                  if (encode(currentTurn) !== encode(laterTurn))
                    return yield* deny(
                      "Retained mailbox context changed before allocation",
                      "conflict",
                    );
                  const textOptions = {
                    optionalTextBudgetBytes: Math.max(
                      0,
                      65536 - Buffer.byteLength(context + "\n\n", "utf8"),
                    ),
                  };
                  return yield* compactBoundary !== undefined
                    ? requiredContext.readRequired(compactBoundary.original, textOptions)
                    : currentTurn._tag === "LaterTurn"
                      ? requiredContext.readRequired(currentTurn.original, textOptions)
                      : requiredContext.readForOperation(contextOperation, textOptions);
                });
                const required = yield* readOperationContext;
                const protectedContext = (snapshot: typeof required) =>
                  encode({
                    required: { ...snapshot.required, sourceRevision: 0, remaining: null },
                    communication: snapshot.communication,
                    retainedKnowledge: snapshot.retainedKnowledge,
                    provenance: {
                      ...snapshot.provenance,
                      sourceRevision: 0,
                      ledgerReservationIds: [],
                    },
                  });
                const requiredIdentity = protectedContext(required);
                const checkRequiredContext = (signal: AbortSignal) =>
                  guard(
                    Effect.gen(function* () {
                      if (signal.aborted) return yield* deny("Pi operation canceled");
                      const currentContext = yield* readOperationContext;
                      if (protectedContext(currentContext) !== requiredIdentity)
                        return yield* deny(
                          "Required context changed before compaction execution",
                          "conflict",
                        );
                      if (signal.aborted) return yield* deny("Pi operation canceled");
                    }),
                  );
                if (
                  required.required.projectId !== binding.projectId ||
                  required.required.runId !== binding.recordId ||
                  required.required.taskId !== binding.taskId ||
                  required.required.attemptId !== binding.attemptId ||
                  required.required.generation !== binding.generation ||
                  encode(required.required.role) !== encode(authority.role) ||
                  required.required.tasks[0]?.task.specRevision !== binding.specRevision ||
                  (required.required.tasks[0]?.plan?.planRevision ?? 0) !== binding.planRevision
                )
                  return yield* deny(
                    "Required context differs from current assignment",
                    "conflict",
                  );
                const requiredText = required.text;
                const promptBytes =
                  request.kind === "prompt" ? Buffer.byteLength(request.prompt) : 0;
                if (
                  Buffer.byteLength(requiredText) > 65536 ||
                  promptBytes > 65536 ||
                  Buffer.byteLength(requiredText) + promptBytes > 131072
                )
                  return yield* deny("Pi required context exceeds transfer bounds", "unavailable");
                const authorizeResources = guard(
                  Effect.gen(function* () {
                    yield* preparationCurrent;
                    const current = yield* operations.current(
                      identity(request.threadId),
                      request.kind === "initialize",
                    );
                    if (contextFor(current) !== authorityContext)
                      return yield* deny("Pi selected resource authority changed", "conflict");
                    if (
                      piManagedSkillResourceIdentity(yield* selectedSkills(current, workspace)) !==
                      resourceHash
                    )
                      return yield* deny("Pi selected resource content changed", "conflict");
                    yield* verifyWorkspace(current, agentDirectory, workspace);
                    yield* operations.admitCurrent(identity(request.threadId), (latest) => {
                      if (contextFor(latest) !== authorityContext)
                        throw deny(
                          "Pi selected resource authority changed during admission",
                          "conflict",
                        );
                      assertPreparing();
                      workspaceReceipt(paths, workspace.fence.metadata, workspace.fence);
                      sourceFence();
                    });
                  }),
                );
                if (selection.length !== 0) {
                  if (!options.allocateSkillStage || Option.isNone(materialization))
                    return yield* deny("Selected Pi skill staging is unavailable", "unavailable");
                  yield* validatePiManagedSkillPlan({
                    selection,
                    skillPlan: request.skillPlan,
                    materialization: materialization.value,
                    threadId: request.threadId,
                    providerInstanceId: instance.instanceId,
                    authorizeCurrent: authorizeResources,
                  }).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                    Effect.provideService(Path.Path, paths),
                  );
                  yield* preparationCurrent;
                  resourceScope = yield* Scope.make();
                  stageScopes.add(resourceScope);
                  const ownedScope = resourceScope;
                  skillStage = yield* options.allocateSkillStage.pipe(
                    Effect.provideService(Scope.Scope, ownedScope),
                  );
                }
                const resources =
                  selection.length === 0 && request.skillPlan === undefined
                    ? {
                        runtimeFiles: [],
                        resources: { skills: [] },
                        identityHash: resourceHash,
                        revalidate: Effect.void,
                      }
                    : Option.isNone(materialization)
                      ? yield* deny("Owned Pi skill materialization is unavailable", "unavailable")
                      : yield* preparePiManagedSkillResources({
                          selection,
                          skillPlan: request.skillPlan,
                          materialization: materialization.value,
                          threadId: request.threadId,
                          providerInstanceId: instance.instanceId,
                          stagingRoot: skillStage?.stagingRoot ?? options.nativeStateRoot,
                          stagingDirectory: skillStage?.stagingDirectory ?? options.nativeStateRoot,
                          existingRuntimeFiles: options.runtimeFiles,
                          protectedRoots: workspace.protectedRoots,
                          writableRoots: [binding.worktree, options.nativeStateRoot],
                          authorizeCurrent: authorizeResources,
                        }).pipe(
                          Effect.provideService(FileSystem.FileSystem, fs),
                          Effect.provideService(Path.Path, paths),
                        );
                if (resources.identityHash !== resourceHash)
                  return yield* deny("Pi staged selected content identity changed", "conflict");
                yield* resources.revalidate;
                if (skillStage) {
                  yield* skillStage.captureSealedTree(resources.runtimeFiles);
                  stageSealed = true;
                }
                const settleResources = (disposition: "drained" | "uncertain") =>
                  Effect.suspend(() => {
                    if (!skillStage || !resourceScope) return Effect.void;
                    return (
                      disposition === "drained" ? skillStage.remove() : skillStage.retain()
                    ).pipe(Effect.ensuring(closeResources));
                  });
                const persistTerminal = (
                  terminal: import("./PiSessionRuntime.ts").PiSessionTerminal,
                ) =>
                  operations
                    .persistTerminal(durable, terminal)
                    .pipe(Effect.flatMap(settleResources));
                if (Buffer.byteLength(context) > 131072)
                  return yield* deny(
                    "Pi current assignment context exceeds its bound",
                    "unavailable",
                  );
                const operation: PiWorkerOperation = {
                  operationId:
                    request.operationId === undefined
                      ? yield* crypto.randomUUIDv4
                      : (yield* decodeOperation({
                          operationId: request.operationId,
                          operationKind: request.kind,
                        }).pipe(
                          Effect.mapError(() => deny("Invalid stable Pi operation identity")),
                        )).operationId,
                  operationKind: request.kind,
                };
                let subscriptionIdentity: ProjectTeamPiSubscriptionGrantIdentity | undefined;
                if (nativeConfig.provider === "openai-codex") {
                  const selected = options.subscriptionTest;
                  if (!selected || !subscriptionPolicy)
                    return yield* deny("Pi subscription selection unavailable");
                  const original = yield* operations.readRootBudget(
                    authority,
                    operation,
                    request,
                    resourceHash,
                  );
                  if (
                    original.rootTaskId !== selected.selection.rootTaskId ||
                    original.maximumTokens !== selected.selection.maximumTokens
                  )
                    return yield* deny("Pi subscription original root differs");
                  subscriptionIdentity = {
                    environmentId: options.environmentId,
                    projectId: binding.projectId,
                    rootTaskId: original.rootTaskId,
                    model: "gpt-6-luna",
                    routeId: "openai-subscription-luna",
                    maximumTokens: selected.selection.maximumTokens,
                    maximumDurationMs: selected.selection.maximumDurationMs,
                    deadlineAtMs: original.deadlineAtMs,
                  };
                  yield* assertSubscriptionAccountingHealthy();
                  yield* subscriptionPolicy.check(subscriptionIdentity);
                }
                const workerId = yield* crypto.randomUUIDv4;
                const workerIdentity = { workerId, generation: binding.generation };
                const nativeStateDirectory =
                  options.nativeStateRoot +
                  "/" +
                  digest(
                    encode([
                      options.environmentId,
                      instance.instanceId,
                      request.threadId,
                      binding.recordId,
                      binding.generation,
                    ]),
                  );
                if (
                  workspace.protectedRoots.some(
                    (root) =>
                      root === nativeStateDirectory ||
                      nativeStateDirectory.startsWith(root + "/") ||
                      root.startsWith(nativeStateDirectory + "/"),
                  )
                )
                  return yield* deny("Pi native state overlaps a protected Git checkout");
                yield* fs.makeDirectory(nativeStateDirectory, { recursive: true, mode: 0o700 });
                if ((yield* fs.realPath(nativeStateDirectory)) !== nativeStateDirectory)
                  return yield* deny("Pi native state directory is not canonical");
                const launch: PiManagedLaunch = {
                  workspaceRoot: binding.worktree,
                  workspaceAccess: localTools.some((tool) => tool.name !== "read")
                    ? "readwrite"
                    : "readonly",
                  nativeStateRoot: nativeStateDirectory,
                  protectedWorkspaceEntries: [".git"],
                  protectedRoots: workspace.protectedRoots,
                  runtimeFiles: [...options.runtimeFiles, ...resources.runtimeFiles],
                  argv: options.workerArgv(workerIdentity, operation, nativeStateDirectory),
                  memoryBytes: options.memoryBytes,
                  runtimeSeconds: Math.ceil(nativeConfig.deadlineMs / 1000),
                };
                yield* options.revalidateRuntime ?? Effect.void;
                const allocationAuthority = yield* operations.current(
                  identity(request.threadId),
                  request.kind === "initialize",
                );
                const qualified = yield* readOperationContext;
                if (encode(qualified.provenance) !== encode(required.provenance))
                  return yield* deny(
                    "Required context provenance changed before allocation",
                    "conflict",
                  );
                if (contextFor(allocationAuthority) !== context)
                  return yield* deny("Pi assignment changed before managed allocation", "conflict");
                yield* verifyWorkspace(allocationAuthority, agentDirectory, workspace);
                if (
                  contextFor(
                    yield* operations.current(
                      identity(request.threadId),
                      request.kind === "initialize",
                    ),
                  ) !== context
                )
                  return yield* deny(
                    "Pi assignment changed during managed allocation checks",
                    "conflict",
                  );
                yield* finalWorkspaceFence(paths, workspace.fence);
                yield* preparationCurrent;
                yield* verifySource(sourceFence);
                const allocation = yield* preallocatePiManagedProcess(launch).pipe(
                  Effect.provide(services),
                );
                yield* preparationCurrent;
                yield* verifySource(sourceFence);
                durableAttempted = true;
                const durable = yield* operations.prepare(
                  identity(request.threadId),
                  request,
                  request.operationId === undefined ? digest(encode(request)) : requestHash,
                  {
                    allocation,
                    workerId,
                    operationId: operation.operationId,
                    resourceHash,
                    ...(compactBoundary === undefined
                      ? {}
                      : {
                          compactContext: {
                            provenanceSha256: digest(encode(required.provenance)),
                            textSha256: digest(requiredText),
                          },
                        }),
                  },
                );
                if (contextFor(durable.authority) !== context)
                  return yield* deny("Pi assignment changed before durable handoff", "conflict");
                const sealedMailbox =
                  request.kind === "prompt"
                    ? laterTurn._tag === "LaterTurn"
                      ? yield* mailboxTurns.seal({
                          operationId: operation.operationId,
                          baseSystemText: requiredText,
                        })
                      : yield* mailbox.sealAssignmentContext({
                          operationId: operation.operationId,
                          baseSystemText: requiredText,
                        })
                    : undefined;
                const turnId = TurnId.make(operation.operationId);
                const translator =
                  request.kind === "prompt"
                    ? makePiRuntimeEventTranslator({
                        providerInstanceId: instance.instanceId,
                        threadId: request.threadId,
                        turnId,
                        identity: workerIdentity,
                        operation: { ...operation, operationKind: "prompt" },
                        operationOrdinal: durable.ordinal,
                        ...(previous ? { sessionId: previous.native.sessionId } : {}),
                      })
                    : undefined;
                const tools: PiModelTool[] = [];
                const toolCapabilities: import("./PiSessionRuntime.ts").PiSessionToolCapability[] =
                  [];
                const bridgeTools = yield* Effect.try({
                  try: () =>
                    preparePiProjectWorkTools({
                      roleTools: authority.role.tools,
                      bindingTools: binding.configuration.toolIds,
                    }),
                  catch: () => deny("Pi frozen bridge tool configuration is invalid"),
                });
                for (const { tool, capability } of bridgeTools) {
                  tools.push(tool);
                  toolCapabilities.push({
                    name: tool.function.name,
                    capability,
                    execution: "bridge",
                  });
                }
                for (const tool of localTools) {
                  tools.push({
                    type: "function",
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.parameters,
                    },
                  });
                  toolCapabilities.push({
                    name: tool.name,
                    capability: tool.capabilityId,
                    execution: "local",
                  });
                }
                const texts = [
                  { transferId: "context", text: sealedMailbox?.systemText ?? requiredText },
                  ...(request.kind === "prompt"
                    ? [{ transferId: "prompt", text: request.prompt }]
                    : []),
                  ...tools.map((tool) => ({
                    transferId: tool.function.name,
                    text: encode(tool.function.parameters),
                  })),
                ];
                const descriptor = (transferId: string) => ({
                  transferId,
                  totalBytes: Buffer.byteLength(
                    texts.find((item) => item.transferId === transferId)!.text,
                  ),
                });
                const check = (signal: AbortSignal, verify = false, revalidate = false) =>
                  guard(
                    Effect.gen(function* () {
                      if (signal.aborted) return yield* deny("Pi operation canceled");
                      if (subscriptionIdentity && subscriptionPolicy) {
                        yield* assertSubscriptionAccountingHealthy();
                        yield* subscriptionPolicy.check(subscriptionIdentity);
                      }
                      const current = yield* operations.authorize(durable);
                      if (
                        piManagedSkillResourceIdentity(
                          yield* selectedSkills(current, workspace),
                        ) !== resourceHash
                      )
                        return yield* deny(
                          "Pi current selected content identity changed",
                          "conflict",
                        );
                      if (verify) yield* resources.revalidate;
                      if (verify) yield* verifyWorkspace(current, agentDirectory, workspace);
                      if (revalidate) {
                        if (signal.aborted) return yield* deny("Pi operation canceled");
                        yield* options.revalidateRuntime ?? Effect.void;
                        if (signal.aborted) return yield* deny("Pi operation canceled");
                        yield* verifyWorkspace(
                          yield* operations.authorize(durable),
                          agentDirectory,
                          workspace,
                        );
                      }
                      yield* operations.authorize(durable);
                      if (signal.aborted) return yield* deny("Pi operation canceled");
                      yield* verifySource(sourceFence);
                      if (request.kind === "compact" && revalidate) {
                        // Ledger charges and time can advance; protected task context cannot.
                        yield* checkRequiredContext(signal);
                      }
                    }),
                  );
                const route = piBrokerModelRoute(nativeConfig.model);
                const accounting = accountings.find(
                  (entry) => entry.model === nativeConfig.model,
                )?.accounting;
                if (!accounting) return yield* deny("Selected model accounting is unavailable");
                const runtime = yield* makePiSessionRuntime({
                  identity: workerIdentity,
                  operation,
                  bootstrap: {
                    type: "bootstrap",
                    executionMode: "managed",
                    expectedCwd: "/workspace",
                    native: previous?.native ?? null,
                    resources: resources.resources,
                    context: descriptor("context"),
                    prompt: request.kind === "prompt" ? descriptor("prompt") : null,
                    model:
                      nativeConfig.provider === "openai-codex"
                        ? {
                            provider: nativeConfig.provider,
                            modelId: nativeConfig.model,
                            api: nativeConfig.api,
                            contextWindow: nativeConfig.contextWindow,
                            maxTokens: nativeConfig.maxOutputTokens,
                            reasoning: true,
                            reasoningEffort: nativeConfig.reasoningEffort,
                            serviceTier: nativeConfig.serviceTier,
                          }
                        : {
                            provider: nativeConfig.provider,
                            modelId: nativeConfig.model,
                            api: nativeConfig.api,
                            contextWindow: nativeConfig.contextWindow,
                            maxTokens: nativeConfig.maxOutputTokens,
                            reasoning: false,
                          },
                    allowedTools: tools.map((tool) => ({
                      name: tool.function.name,
                      execution: toolCapabilities.find(
                        (entry) => entry.name === tool.function.name,
                      )!.execution,
                      description: tool.function.description,
                      inputSchema: descriptor(tool.function.name),
                    })),
                  },
                  transferTexts: texts,
                  launch,
                  persistence: operations.persistence(durable),
                  toolCapabilities,
                  deadlineMs: Math.max(
                    1,
                    Math.min(
                      nativeConfig.deadlineMs,
                      durable.deadlineAtMs - (yield* Clock.currentTimeMillis),
                    ),
                  ),
                  cleanupDeadlineMs: options.cleanupDeadlineMs,
                  authorizeCurrent: (input, signal) =>
                    perform(
                      check(
                        signal,
                        [
                          "beforeAcquire",
                          "beforeStart",
                          "beforeTool",
                          "beforeToolInvoke",
                          "beforeToolReturn",
                        ].includes(input.phase),
                        input.phase === "beforeAcquire" || input.phase === "beforeStart",
                      ).pipe(
                        Effect.andThen(
                          input.tool
                            ? authorization.capability(
                                durable.principal,
                                input.tool.capability,
                                binding.projectId,
                              )
                            : Effect.void,
                        ),
                        // Capability checks can await SQL or another authority receipt.
                        // Recheck the frozen run after that receipt, then fence the workspace.
                        Effect.andThen(check(signal)),
                        Effect.andThen(
                          [
                            "beforeAcquire",
                            "beforeStart",
                            "beforeTool",
                            "beforeToolInvoke",
                            "beforeToolReturn",
                          ].includes(input.phase)
                            ? finalWorkspaceFence(paths, workspace.fence, signal)
                            : Effect.void,
                        ),
                        Effect.andThen(
                          request.kind === "compact" &&
                            (input.phase === "beforeAcquire" || input.phase === "beforeStart")
                            ? checkRequiredContext(signal)
                            : Effect.void,
                        ),
                      ),
                    ),
                  executeBridgeTool: (call, input, signal) =>
                    perform(
                      guard(
                        Effect.gen(function* () {
                          yield* check(signal);
                          const result = yield* executePiProjectWorkBridgeTool({
                            toolName: call.toolName,
                            arguments: input.arguments,
                            principal: durable.principal,
                            source: { kind: "mcp", id: workerId },
                          }).pipe(
                            Effect.provideService(ProjectWorkGateway, gateway),
                            (effect) =>
                              durable.operation.operationKind === "prompt"
                                ? Effect.provideService(
                                    effect,
                                    ProjectTeamReviewReportOperation,
                                    Object.freeze({
                                      environmentId: binding.environmentId,
                                      projectId: binding.projectId,
                                      reviewTaskId: binding.taskId,
                                      bindingId: binding.recordId,
                                      generation: binding.generation,
                                      providerInstanceId: binding.providerInstanceId,
                                      threadId: binding.threadId,
                                      operationId: durable.operation.operationId,
                                      operationKind: "prompt" as const,
                                      workerId: durable.workerId,
                                      ordinal: durable.ordinal,
                                    }),
                                  )
                                : effect,
                            (effect) =>
                              durable.operation.operationKind === "prompt"
                                ? Effect.provideService(effect, ProjectMemoryOperation, {
                                    identity: {
                                      environmentId: binding.environmentId,
                                      projectId: binding.projectId,
                                      taskId: binding.taskId,
                                      bindingId: binding.recordId,
                                      generation: binding.generation,
                                      providerInstanceId: binding.providerInstanceId,
                                      threadId: binding.threadId,
                                      operationId: durable.operation.operationId,
                                      workerId: durable.workerId,
                                      ordinal: durable.ordinal,
                                    },
                                    readCurrentInTransaction: (principal) =>
                                      operations
                                        .readMemoryOperationOwnerInTransaction(
                                          {
                                            environmentId: binding.environmentId,
                                            projectId: binding.projectId,
                                            taskId: binding.taskId,
                                            bindingId: binding.recordId,
                                            generation: binding.generation,
                                            providerInstanceId: binding.providerInstanceId,
                                            threadId: binding.threadId,
                                            operationId: durable.operation.operationId,
                                            workerId: durable.workerId,
                                            ordinal: durable.ordinal,
                                          },
                                          principal,
                                        )
                                        .pipe(
                                          Effect.mapError(
                                            () =>
                                              new ProjectMemoryServiceError({
                                                reason:
                                                  "Original memory operation owner is unavailable",
                                              }),
                                          ),
                                        ),
                                  })
                                : effect,
                          );
                          yield* check(signal);
                          return { kind: "text" as const, text: encode(result) };
                        }),
                      ),
                      { signal },
                    ),
                  persistNative: (frame, signal) =>
                    perform(
                      guard(
                        Effect.gen(function* () {
                          yield* check(signal);
                          if (!("native" in frame.message))
                            return yield* deny("Pi native receipt absent");
                          const beforeNative = yield* operations.authorize(durable);
                          if (contextFor(beforeNative) !== authorityContext)
                            return yield* deny(
                              "Pi native authority changed before commit",
                              "conflict",
                            );
                          const committed = yield* operations.persistNative(
                            durable,
                            frame.message.native,
                          );
                          // Initial native persistence alone may advance the reserved binding.
                          // Keep the SDK's original context, then fence the complete committed snapshot.
                          const expected =
                            binding.status === "reserved" && authorityContext === context
                              ? contextFor({
                                  ...authority,
                                  binding: decodeBinding({
                                    ...binding,
                                    revision: binding.revision + 1,
                                    status: "running",
                                    sessionId: frame.message.native.sessionId,
                                    updatedAt: committed.binding.updatedAt,
                                  }),
                                })
                              : authorityContext;
                          const committedContext = contextFor(committed);
                          if (committedContext !== expected)
                            return yield* deny(
                              "Pi native authority changed during commit",
                              "conflict",
                            );
                          authorityContext = committedContext;
                          yield* resources.revalidate;
                          yield* check(signal);
                        }),
                      ),
                    ),
                  onSdkEvent: () => Promise.resolve(),
                  onWorkerFrame: (frame, signal) =>
                    perform(
                      guard(
                        Effect.gen(function* () {
                          yield* check(signal);
                          if (!translator) return;
                          const translated = translator.accept(
                            frame,
                            IsoDateTime.make(DateTime.formatIso(yield* DateTime.now)),
                          );
                          for (const event of translated.events) {
                            yield* check(signal);
                            yield* observe(event);
                          }
                          yield* check(signal);
                        }),
                      ),
                    ),
                  persistControl: (receipt, signal) =>
                    perform(
                      guard(
                        Effect.gen(function* () {
                          if (receipt.status === "received") yield* check(signal);
                          yield* operations.persistControl(durable, receipt);
                          if (receipt.status === "received") yield* check(signal);
                        }),
                      ),
                    ),
                  persistTerminal: (terminal) => perform(persistTerminal(terminal)),
                  broker: {
                    ...workerIdentity,
                    operationId: operation.operationId,
                    routeId: route.routeId,
                    provider: nativeConfig.provider,
                    model: nativeConfig.model,
                    endpoint: nativeConfig.endpoint,
                    acceptedReportedModels: route.acceptedReportedModels,
                    tools,
                    maxInputTokens: nativeConfig.maxInputTokens,
                    maxOutputTokens: nativeConfig.maxOutputTokens,
                    deadlineMs: Math.max(
                      1,
                      Math.min(
                        30000,
                        Math.floor((durable.deadlineAtMs - (yield* Clock.currentTimeMillis)) / 2),
                      ),
                    ),
                    authorizeCurrent: (_phase, signal) => perform(check(signal)),
                    ...(subscriptionIdentity === undefined
                      ? {}
                      : {
                          authorizeSubscriptionTest: (signal: AbortSignal) =>
                            perform(check(signal)),
                        }),
                    getCredential: (signal) =>
                      perform(
                        check(signal).pipe(
                          Effect.andThen(
                            subscriptionIdentity && options.subscriptionTest
                              ? readPiSubscriptionCredential(
                                  options.subscriptionTest.credentialSource,
                                  subscriptionIdentity.deadlineAtMs,
                                ).pipe(
                                  Effect.map(
                                    (credential) => Redacted.value(credential).accessToken,
                                  ),
                                )
                              : readPiSavedLiteralCredential(agentDirectory).pipe(
                                  Effect.map(Redacted.value),
                                ),
                          ),
                        ),
                      ),
                    reserveRequest: (reservation, signal) =>
                      perform(
                        guard(
                          check(signal).pipe(
                            Effect.andThen(accounting.reserve(durable.principal, reservation)),
                            Effect.flatMap((receipt) =>
                              receipt.status === "existing"
                                ? Effect.fail(deny("Pi model request already reserved", "conflict"))
                                : Effect.succeed({ reservationId: receipt.reservationId }),
                            ),
                          ),
                        ),
                      ),
                    ...(sealedMailbox === undefined
                      ? {}
                      : {
                          requiredSystemText: sealedMailbox.systemText,
                          bindRequestInput: (
                            input: {
                              readonly reservationId: string;
                              readonly encodedRequestSha256: string;
                            },
                            signal: AbortSignal,
                          ) =>
                            perform(
                              Effect.gen(function* () {
                                yield* check(signal);
                                if (laterTurn._tag === "LaterTurn")
                                  yield* mailboxTurns.bindInput({
                                    operationId: operation.operationId,
                                    ...input,
                                  });
                                else
                                  yield* mailbox.bindRequestInput({
                                    operationId: operation.operationId,
                                    ...input,
                                  });
                              }),
                            ),
                        }),
                    settleRequest: (settlement) => {
                      const settle = Effect.gen(function* () {
                        const receipt = yield* accounting.settle(settlement);
                        if (
                          subscriptionIdentity &&
                          subscriptionPolicy &&
                          (yield* subscriptionPolicy.readStop(subscriptionIdentity))
                        )
                          stopSubscription();
                        return receipt;
                      });
                      return perform(
                        subscriptionIdentity
                          ? stopAfterSubscriptionAccountingFailure(settle)
                          : settle,
                      );
                    },
                    transport: options.transport,
                  },
                });
                let controlId = 0;
                const done = Promise.withResolvers<void>();
                let stopFailure: PiManagedRuntimeError | undefined;
                let started = false;
                const cancellation = new AbortController();
                if (subscriptionIdentity) subscriptionControllers.add(cancellation);
                let execution:
                  | Promise<import("./PiSessionRuntime.ts").PiSessionTerminal>
                  | undefined;
                const run = Effect.suspend(() => {
                  let ownsRun = false;
                  return guard(
                    Effect.gen(function* () {
                      if (started) return yield* deny("Pi operation already attempted", "conflict");
                      yield* operations.assertIndependent();
                      if (started) return yield* deny("Pi operation already attempted", "conflict");
                      started = true;
                      ownsRun = true;
                      const terminal = yield* Effect.tryPromise({
                        try: (signal) => {
                          execution = perform(Effect.scoped(runtime.run()), {
                            signal: AbortSignal.any([signal, cancellation.signal]),
                          });
                          return execution;
                        },
                        catch: () => deny("Pi operation requires reconciliation", "uncertain"),
                      }).pipe(Effect.onInterrupt(() => Effect.sync(() => cancellation.abort())));
                      yield* operations.current(identity(request.threadId));
                      if (terminal.outcome !== "success" || !terminal.native)
                        return yield* deny("Pi operation requires reconciliation", "uncertain");
                      const beforePublication = yield* operations.current(
                        identity(request.threadId),
                      );
                      if (
                        contextFor(beforePublication) !== authorityContext ||
                        piManagedSkillResourceIdentity(
                          yield* selectedSkills(beforePublication, workspace),
                        ) !== resourceHash
                      )
                        return yield* deny(
                          "Pi publication selected content or authority changed",
                          "conflict",
                        );
                      yield* verifyWorkspace(beforePublication, agentDirectory, workspace);
                      if (
                        request.kind === "initialize" &&
                        beforePublication.role.role === "reviewer"
                      ) {
                        const assertFreshnessOwner = Effect.gen(function* () {
                          if (
                            cancellation.signal.aborted ||
                            active.get(request.threadId)?.prepared.operation.operationId !==
                              operation.operationId
                          )
                            return yield* deny("Reviewer initialization owner changed", "conflict");
                          const current = yield* operations.publication(durable, terminal);
                          if (contextFor(current) !== authorityContext)
                            return yield* deny(
                              "Reviewer initialization authority changed",
                              "conflict",
                            );
                          yield* verifyWorkspace(current, agentDirectory, workspace);
                          yield* verifySource(sourceFence);
                          yield* finalWorkspaceFence(paths, workspace.fence);
                        });
                        yield* reviewFreshness.capture({
                          projectId: binding.projectId,
                          taskId: binding.taskId,
                          bindingId: binding.recordId,
                          generation: binding.generation,
                          providerInstanceId: binding.providerInstanceId,
                          threadId: binding.threadId,
                          operationId: operation.operationId,
                          specRevision: binding.specRevision,
                          planRevision: binding.planRevision,
                          native: terminal.native,
                          expectedBriefing: requiredText,
                          expectedCwd: "/workspace",
                          sessionDirectoryRoot: nativeStateDirectory + "/sessions",
                          assertCurrent: assertFreshnessOwner,
                        });
                      }
                      const current = yield* operations.publication(durable, terminal);
                      yield* verifySource(sourceFence);
                      yield* finalWorkspaceFence(paths, workspace.fence);
                      // No asynchronous work separates these owner checks from publication.
                      if (
                        cancellation.signal.aborted ||
                        active.get(request.threadId)?.prepared.operation.operationId !==
                          operation.operationId
                      )
                        return yield* deny("Pi operation publication canceled", "conflict");
                      const result = { terminal, session: sessionFor(current, terminal.native) };
                      active.delete(request.threadId);
                      subscriptionControllers.delete(cancellation);
                      done.resolve();
                      ownsRun = false;
                      return result;
                    }),
                  ).pipe(
                    Effect.ensuring(
                      Effect.suspend(() =>
                        ownsRun
                          ? Effect.gen(function* () {
                              cancellation.abort();
                              subscriptionControllers.delete(cancellation);
                              if (execution)
                                yield* Effect.promise(() =>
                                  execution!.then(
                                    () => {},
                                    () => {},
                                  ),
                                );
                              if (
                                active.get(request.threadId)?.prepared.operation.operationId ===
                                operation.operationId
                              )
                                active.delete(request.threadId);
                              done.resolve();
                            })
                          : Effect.void,
                      ),
                    ),
                  );
                });
                const steer: PiManagedPreparedOperation["steer"] = (kind, text) =>
                  guard(
                    runtime
                      .control({ type: "control", controlId: ++controlId, kind, text })
                      .pipe(Effect.as({ controlId, status: "received" as const })),
                  );
                const interrupt = guard(
                  Effect.suspend(() => {
                    const id = ++controlId;
                    return runtime
                      .interrupt(id)
                      .pipe(Effect.as({ controlId: id, status: "received" as const }));
                  }),
                );
                const prepared: PiManagedPreparedOperation =
                  request.kind === "prompt"
                    ? { kind: "prompt", turnId, operation, run, steer, interrupt }
                    : { kind: request.kind, operation, run, steer, interrupt };
                const stop = guard(
                  Effect.uninterruptible(
                    Effect.gen(function* () {
                      preparation.canceled = true;
                      if (!started) {
                        started = true;
                        yield* persistTerminal({
                          identity: workerIdentity,
                          operation,
                          outcome: "canceled",
                          ownerCaptured: false,
                          native: null,
                          drain: null,
                          accountingReceipts: [],
                        }).pipe(
                          Effect.tapError((error) =>
                            Effect.sync(() => {
                              stopFailure = error;
                            }),
                          ),
                          Effect.ensuring(Effect.sync(() => done.resolve())),
                        );
                        if (
                          active.get(request.threadId)?.prepared.operation.operationId ===
                          operation.operationId
                        )
                          active.delete(request.threadId);
                        subscriptionControllers.delete(cancellation);
                        done.resolve();
                        return;
                      }
                      cancellation.abort();
                      subscriptionControllers.delete(cancellation);
                      yield* Effect.promise(() => done.promise);
                      if (stopFailure) return yield* stopFailure;
                    }),
                  ),
                );
                active.set(request.threadId, { prepared, stop });
                if (preparation.canceled || closing) {
                  yield* stop;
                  return yield* deny("Pi preparation canceled", "conflict");
                }
                try {
                  sourceFence();
                } catch {
                  yield* stop;
                  return yield* sourceChanged();
                }
                return prepared;
              }),
            ).pipe(
              Effect.onExit((exit) => {
                if (!Exit.isFailure(exit) || !resourceScope) return Effect.void;
                // Before entering durable preparation, a sealed view has no native consumer.
                const cleanup =
                  stageSealed && !durableAttempted && skillStage
                    ? skillStage.remove()
                    : Effect.void;
                return cleanup.pipe(Effect.ensuring(closeResources));
              }),
              Effect.ensuring(
                Effect.sync(() => {
                  preparing.delete(request.threadId);
                  preparation.done.resolve();
                }),
              ),
            );
            return Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                preparationFiber = yield* prepare.pipe(
                  Effect.forkChild({ uninterruptible: false }),
                );
                const exit = yield* restore(Fiber.await(preparationFiber));
                if (
                  (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) ||
                  (Exit.isSuccess(exit) && (preparation.canceled || closing))
                )
                  return yield* deny("Pi preparation canceled", "conflict");
                return yield* exit;
              }),
            );
          });
        };
        const requestStop = (threadId: ThreadId) =>
          guard(
            Effect.gen(function* () {
              const replay = replayReceipts.get(threadId);
              replay?.();
              const pending = preparing.get(threadId);
              if (pending) yield* pending;
              const running = active.get(threadId);
              if (!running) {
                if (pending || replay) return;
                yield* operations.current(identity(threadId));
                return;
              }
              yield* running.stop;
            }),
          );
        const stopAll = Effect.suspend(() =>
          Effect.forEach(
            [...new Set([...preparing.keys(), ...active.keys(), ...replayReceipts.keys()])],
            requestStop,
            {
              discard: true,
            },
          ),
        ).pipe(Effect.asVoid);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closing = true;
          }).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                Effect.forEach(
                  [...new Set([...preparing.keys(), ...active.keys(), ...replayReceipts.keys()])],
                  (threadId) => requestStop(threadId).pipe(Effect.catch(() => Effect.void)),
                  { discard: true },
                ),
              ),
            ),
            Effect.ensuring(
              Effect.forEach(stageScopes, (scope) => Scope.close(scope, Exit.void), {
                discard: true,
              }),
            ),
          ),
        );
        const readCommitted = <A>(
          threadId: ThreadId,
          skillPlan: ProviderSkillPlan | undefined,
          read: (
            committed: Effect.Success<ReturnType<typeof operations.nativeFor>>,
          ) => Effect.Effect<A, PiManagedRuntimeError>,
        ) => {
          // Capture caller hints before any database or filesystem admission.
          let plan: ProviderSkillPlan | undefined;
          try {
            plan = skillPlan === undefined ? undefined : structuredClone(skillPlan);
          } catch {
            return Effect.fail(deny("Pi skill plan cannot be copied"));
          }
          return guard(
            Effect.gen(function* () {
              const committed = yield* operations.nativeFor(identity(threadId));
              if (
                committed.authority.binding.configuration.runtimeVersion !== "0.99.1" ||
                committed.authority.binding.configuration.instructionsHash !==
                  digest(committed.authority.role.instructions)
              )
                return yield* deny(
                  "Pi native view frozen runtime or instructions changed",
                  "conflict",
                );
              const context = contextFor(committed.authority);
              const workspace = yield* verifyWorkspace(committed.authority, agentDirectory);
              const { selection, fence: sourceFence } = yield* selectedSnapshot(
                committed.authority,
                workspace,
              );
              const resourceHash = piManagedSkillResourceIdentity(selection);
              if ((committed.resourceHash ?? piManagedSkillResourceIdentity([])) !== resourceHash)
                return yield* deny("Changed Pi skills require a new native session", "conflict");
              const authorizeCurrent = guard(
                Effect.gen(function* () {
                  const latest = yield* operations.current(identity(threadId));
                  if (
                    contextFor(latest) !== context ||
                    piManagedSkillResourceIdentity(yield* selectedSkills(latest, workspace)) !==
                      resourceHash
                  )
                    return yield* deny(
                      "Pi native view authority or selected content changed",
                      "conflict",
                    );
                  yield* verifyWorkspace(latest, agentDirectory, workspace);
                }),
              );
              if (plan !== undefined) {
                if (Option.isNone(materialization))
                  return yield* deny("Managed skill materialization is unavailable", "unavailable");
                yield* validatePiManagedSkillPlan({
                  selection,
                  skillPlan: plan,
                  materialization: materialization.value,
                  threadId,
                  providerInstanceId: instance.instanceId,
                  authorizeCurrent,
                }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, paths),
                );
              }
              const result = yield* read(committed);
              yield* authorizeCurrent;
              return yield* operations.admitCurrent(
                identity(threadId),
                (latest) => {
                  if (contextFor(latest) !== context)
                    throw deny("Pi native view authority changed", "conflict");
                  workspaceReceipt(paths, workspace.fence.metadata, workspace.fence);
                  sourceFence();
                  return result;
                },
                {
                  operationId: committed.operationId,
                  native: committed.native,
                  resourceHash: committed.resourceHash,
                },
              );
            }),
          );
        };
        return {
          inspect,
          prepareOperation,
          requestStop,
          stopAll,
          readSession: (threadId: ThreadId, skillPlan?: ProviderSkillPlan) =>
            readCommitted(threadId, skillPlan, (committed) =>
              Effect.succeed(sessionFor(committed.authority, committed.native)),
            ),
          readThread: (threadId: ThreadId) =>
            readCommitted(threadId, undefined, (committed) =>
              Effect.tryPromise({
                try: () =>
                  readPiNativeSession({
                    sessionDirectoryRoot:
                      options.nativeStateRoot +
                      "/" +
                      digest(
                        encode([
                          options.environmentId,
                          instance.instanceId,
                          threadId,
                          committed.authority.binding.recordId,
                          committed.authority.binding.generation,
                        ]),
                      ) +
                      "/sessions",
                    expectedCwd: "/workspace",
                    native: committed.native,
                  }),
                catch: () => deny("Pi native session read unavailable", "unavailable"),
              }).pipe(
                Effect.uninterruptible,
                Effect.map((native) => ({
                  threadId,
                  turns: [
                    {
                      id: TurnId.make(committed.operationId),
                      items: native.selectedBranch.map((entry) => entry.payload),
                    },
                  ],
                })),
              ),
            ),
          authorizeSkills,
          discoverNativeSkills: () =>
            Effect.fail(deny("Pi native extension discovery unavailable", "unavailable")),
        };
      }),
    );
  return PiManagedRuntime.of({ forInstance });
});
export const piManagedRuntimeLayer = (options: PiManagedRuntimeLiveOptions) =>
  Layer.effect(PiManagedRuntime, makePiManagedRuntimeLive(options));
