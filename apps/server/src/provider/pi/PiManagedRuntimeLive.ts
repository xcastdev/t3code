import * as NodeCrypto from "node:crypto";
import {
  IsoDateTime,
  ProviderDriverKind,
  TurnId,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  ProjectTeamAuthorization,
  type ProjectTeamAuthority,
} from "../../projectWork/ProjectTeamAuthorization.ts";
import { makeProjectTeamPiOperations } from "../../projectWork/ProjectTeamPiOperations.ts";
import { make as makeAccounting } from "../../projectWork/ProjectTeamModelAccounting.ts";
import { ProjectWorkGateway } from "../../projectWork/ProjectWorkGateway.ts";
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
import { makePiRuntimeEventTranslator } from "./PiRuntimeEvents.ts";
import { makePiSessionRuntime } from "./PiSessionRuntime.ts";
import { piLocalToolDefinitions } from "./PiLocalTools.ts";
import {
  executePiProjectWorkBridgeTool,
  preparePiProjectWorkTools,
  piProjectWorkToolCapabilities,
} from "./PiProjectWorkTools.ts";
import type { PiModelBrokerConfig, PiModelTool } from "./PiModelBroker.ts";
import type { PiNativeReference, PiWorkerIdentity, PiWorkerOperation } from "./PiWorkerProtocol.ts";

const provider = ProviderDriverKind.make("piAgent");
const routeId = "command-code-ling-free";
const model = "inclusionai/ling-3.1-flash:free";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isRuntimeError = Schema.is(PiManagedRuntimeError);
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
  readonly environmentId: string;
  readonly agentDirectory: string;
  readonly nativeStateRoot: string;
  readonly protectedRoots: ReadonlyArray<string>;
  readonly runtimeFiles: PiManagedLaunch["runtimeFiles"];
  readonly revalidateRuntime?: Effect.Effect<void, PiManagedRuntimeError>;
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
          readonly id: "inclusionai/ling-3.1-flash:free";
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
    protectedRoots: [...supplied.protectedRoots],
  };
  const operations = yield* makeProjectTeamPiOperations({ environmentId: options.environmentId });
  const authorization = yield* ProjectTeamAuthorization;
  const gateway = yield* ProjectWorkGateway;
  const accounting = yield* makeAccounting({
    environmentId: options.environmentId,
    routeId,
    model,
    acceptedReportedModels: [model, "inclusionai/ling-3.1-flash"],
    resolveOperation: operations.resolveOperation,
  });
  const crypto = yield* Crypto.Crypto;
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
      (yield* git(cwd, ["symbolic-ref", "--short", "HEAD"])).trim() !== authority.binding.branch
    )
      return yield* deny("Assigned canonical Git worktree or branch changed");
    const records = (yield* git(cwd, ["worktree", "list", "--porcelain", "-z"]))
      .split("\0\0")
      .filter(Boolean)
      .map((record) => record.split("\0"));
    const primaryRecord = records[0];
    const primaryEntries = primaryRecord?.filter((entry) => entry.startsWith("worktree "));
    if (
      authority.binding.branch === "main" ||
      authority.binding.branch === "master" ||
      primaryRecord?.includes(`branch refs/heads/${authority.binding.branch}`) ||
      primaryRecord?.includes(`worktree ${cwd}`) ||
      !primaryEntries ||
      primaryEntries.length !== 1 ||
      !records.some(
        (record) =>
          record.includes(`worktree ${cwd}`) &&
          record.includes(`branch refs/heads/${authority.binding.branch}`),
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
            assignedHead: `ref: refs/heads/${authority.binding.branch}`,
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
      selectedModel: { provider: "command-code", model },
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
        const active = new Map<
          ThreadId,
          {
            readonly prepared: PiManagedPreparedOperation;
            readonly stop: Effect.Effect<void, PiManagedRuntimeError>;
          }
        >();
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
                { slug: model, name: "Ling 3.1 Flash (free)", isCustom: false, capabilities: {} },
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
        const prepareOperation: PiManagedRuntimeInstance["prepareOperation"] = (request, observe) =>
          guard(
            Effect.gen(function* () {
              if (!instance.enabled) return yield* deny("Pi instance disabled");
              const authority = yield* operations.current(
                identity(request.threadId),
                request.kind === "initialize",
              );
              const binding = authority.binding;
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
              if (binding.configuration.skillIds.length || authority.role.skills.length)
                return yield* deny("Pi managed skill delivery is unavailable", "unavailable");
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
              const nativeConfig = yield* configuration(agentDirectory, authority);
              const previous =
                request.kind === "initialize" && binding.status === "reserved"
                  ? undefined
                  : yield* operations.nativeFor(identity(request.threadId));
              if (
                request.resumeCursor !== undefined &&
                encode(request.resumeCursor) !== encode(previous?.native ?? null)
              )
                return yield* deny("Pi resume hint differs from durable native identity");
              const context = contextFor(authority);
              if (Buffer.byteLength(context) > 131072)
                return yield* deny(
                  "Pi current assignment context exceeds its bound",
                  "unavailable",
                );
              const operation: PiWorkerOperation = {
                operationId: yield* crypto.randomUUIDv4,
                operationKind: request.kind,
              };
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
                runtimeFiles: options.runtimeFiles,
                argv: options.workerArgv(workerIdentity, operation, nativeStateDirectory),
                memoryBytes: options.memoryBytes,
                runtimeSeconds: Math.ceil(nativeConfig.deadlineMs / 1000),
              };
              yield* options.revalidateRuntime ?? Effect.void;
              const allocationAuthority = yield* operations.current(
                identity(request.threadId),
                request.kind === "initialize",
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
              const allocation = yield* preallocatePiManagedProcess(launch).pipe(
                Effect.provide(services),
              );
              const durable = yield* operations.prepare(
                identity(request.threadId),
                request,
                digest(encode(request)),
                { allocation, workerId, operationId: operation.operationId },
              );
              if (contextFor(durable.authority) !== context)
                return yield* deny("Pi assignment changed before durable handoff", "conflict");
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
                { transferId: "context", text: context },
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
                    const current = yield* operations.authorize(durable);
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
                  }),
                );
              const runtime = yield* makePiSessionRuntime({
                identity: workerIdentity,
                operation,
                bootstrap: {
                  type: "bootstrap",
                  executionMode: "managed",
                  expectedCwd: "/workspace",
                  native: previous?.native ?? null,
                  context: descriptor("context"),
                  prompt: request.kind === "prompt" ? descriptor("prompt") : null,
                  model: {
                    provider: nativeConfig.provider,
                    modelId: nativeConfig.model,
                    api: nativeConfig.api,
                    contextWindow: nativeConfig.contextWindow,
                    maxTokens: nativeConfig.maxOutputTokens,
                    reasoning: false,
                  },
                  allowedTools: tools.map((tool) => ({
                    name: tool.function.name,
                    execution: toolCapabilities.find((entry) => entry.name === tool.function.name)!
                      .execution,
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
                        }).pipe(Effect.provideService(ProjectWorkGateway, gateway));
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
                        yield* operations.persistNative(durable, frame.message.native);
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
                persistTerminal: (terminal) =>
                  perform(operations.persistTerminal(durable, terminal)),
                broker: {
                  ...workerIdentity,
                  operationId: operation.operationId,
                  routeId,
                  provider: nativeConfig.provider,
                  model: nativeConfig.model,
                  endpoint: nativeConfig.endpoint,
                  acceptedReportedModels: [model, "inclusionai/ling-3.1-flash"],
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
                  getCredential: (signal) =>
                    perform(
                      check(signal).pipe(
                        Effect.andThen(readPiSavedLiteralCredential(agentDirectory)),
                        Effect.map(Redacted.value),
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
                  settleRequest: (settlement) => perform(accounting.settle(settlement)),
                  transport: options.transport,
                },
              });
              let controlId = 0;
              const done = Promise.withResolvers<void>();
              let started = false;
              const cancellation = new AbortController();
              let execution: Promise<import("./PiSessionRuntime.ts").PiSessionTerminal> | undefined;
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
                    const current = yield* operations.publication(durable, terminal);
                    // No asynchronous work separates these owner checks from publication.
                    if (
                      cancellation.signal.aborted ||
                      active.get(request.threadId)?.prepared.operation.operationId !==
                        operation.operationId
                    )
                      return yield* deny("Pi operation publication canceled", "conflict");
                    const result = { terminal, session: sessionFor(current, terminal.native) };
                    active.delete(request.threadId);
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
                    if (!started) {
                      started = true;
                      yield* operations.persistTerminal(durable, {
                        identity: workerIdentity,
                        operation,
                        outcome: "canceled",
                        ownerCaptured: false,
                        native: null,
                        drain: null,
                        accountingReceipts: [],
                      });
                      if (
                        active.get(request.threadId)?.prepared.operation.operationId ===
                        operation.operationId
                      )
                        active.delete(request.threadId);
                      done.resolve();
                      return;
                    }
                    cancellation.abort();
                    yield* Effect.promise(() => done.promise);
                  }),
                ),
              );
              active.set(request.threadId, { prepared, stop });
              return prepared;
            }),
          );
        const requestStop = (threadId: ThreadId) =>
          guard(
            Effect.gen(function* () {
              const running = active.get(threadId);
              if (!running) {
                yield* operations.current(identity(threadId));
                return;
              }
              yield* running.stop;
            }),
          );
        const stopAll = Effect.suspend(() =>
          Effect.forEach([...active.keys()], requestStop, { discard: true }),
        ).pipe(Effect.asVoid);
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() =>
            Effect.forEach([...active.keys()], requestStop, { discard: true }),
          ).pipe(Effect.catch(() => Effect.void)),
        );
        return {
          inspect,
          prepareOperation,
          requestStop,
          stopAll,
          readSession: (threadId: ThreadId) =>
            guard(
              operations
                .current(identity(threadId))
                .pipe(Effect.map((authority) => sessionFor(authority))),
            ),
          readThread: (threadId: ThreadId) =>
            guard(
              Effect.gen(function* () {
                const committed = yield* operations.nativeFor(identity(threadId));
                const native = yield* Effect.tryPromise({
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
                }).pipe(Effect.uninterruptible);
                const current = yield* operations.nativeFor(identity(threadId));
                if (
                  current.operationId !== committed.operationId ||
                  encode(current.native) !== encode(committed.native)
                )
                  return yield* deny("Pi native reference changed", "conflict");
                return {
                  threadId,
                  turns: [
                    {
                      id: TurnId.make(committed.operationId),
                      items: native.selectedBranch.map((entry) => entry.payload),
                    },
                  ],
                };
              }),
            ),
          authorizeSkills: () =>
            Effect.fail(deny("Pi managed skill delivery unavailable", "unavailable")),
          discoverNativeSkills: () =>
            Effect.fail(deny("Pi native extension discovery unavailable", "unavailable")),
        };
      }),
    );
  return PiManagedRuntime.of({ forInstance });
});
export const piManagedRuntimeLayer = (options: PiManagedRuntimeLiveOptions) =>
  Layer.effect(PiManagedRuntime, makePiManagedRuntimeLive(options));
