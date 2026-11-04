// @effect-diagnostics nodeBuiltinImport:off - Test fixtures for the builtin-only inspector backend.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import type { PluginSubscriptionEvent } from "@t3tools/contracts";
import { definePluginBackend } from "@t3tools/plugin-sdk/backend";
import {
  type FakeContextResolver,
  makeWorkerClient,
  type WorkerClient,
} from "@t3tools/plugin-sdk/testing";

import { createInspectorBackend, type InspectorDeps } from "./inspector.ts";
import { CONTROL_ENV, type MitmSpawner, MitmStartError } from "./mitm.ts";
import type { ReplayMessage } from "./replay.ts";
import { deferred, makeFakeTimer } from "./replay.testkit.ts";

export const ADDON_SOURCE = "# fake addon for tests\n";

export type CallContext = NonNullable<Parameters<WorkerClient["invoke"]>[3]>;

/** A caller context for a thread, optionally a subagent of `parentThreadId`. */
export const threadContext = (
  threadId: string,
  projectId: string,
  parentThreadId: string | null = null,
): CallContext => ({
  projectId,
  thread: {
    id: threadId,
    parentThreadId,
    rootThreadId: parentThreadId ?? threadId,
    relationshipToParent: parentThreadId === null ? null : "subagent",
  },
});

const b64 = (text: string | Uint8Array) => Buffer.from(text).toString("base64");

export interface FlowRecordInput {
  readonly method?: string;
  readonly host?: string;
  readonly path?: string;
  readonly headers?: ReadonlyArray<readonly [string, string]>;
  readonly body?: string;
  readonly status?: number;
  readonly responseHeaders?: ReadonlyArray<readonly [string, string]>;
  readonly responseBody?: string;
}

/** A flow line as the addon writes it. */
export const flowRecord = (input: FlowRecordInput = {}) => ({
  type: "flow",
  startedAt: 1_700_000_000_000,
  flowType: "http",
  method: input.method ?? "POST",
  scheme: "http",
  host: input.host ?? "upstream.test",
  port: 80,
  authority: "",
  path: input.path ?? "/login",
  httpVersion: "HTTP/1.1",
  headers: (input.headers ?? [["content-type", "text/plain"]]).map(([name, value]) => [
    b64(name),
    b64(value),
  ]),
  body: { data: b64(input.body ?? "hello"), truncated: false },
  response: {
    status: input.status ?? 200,
    reason: "OK",
    httpVersion: "HTTP/1.1",
    headers: (input.responseHeaders ?? [["content-type", "text/plain"]]).map(([name, value]) => [
      b64(name),
      b64(value),
    ]),
    body: { data: b64(input.responseBody ?? "world"), truncated: false },
  },
  error: null,
});

export interface FakeSpawn {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly pid: number;
  readonly signals: Array<NodeJS.Signals>;
  readonly replays: Array<ReplayMessage>;
  /** record and hosts control messages, in arrival order. */
  readonly controls: Array<Readonly<Record<string, unknown>>>;
  readonly exited: Promise<void>;
  readonly send: (message: unknown) => void;
  readonly sendLine: (line: string) => void;
}

/** The listen port a fake capture spawn was given, from its argv. */
export const listenPortOf = (spawn: FakeSpawn) =>
  Number(spawn.args[spawn.args.indexOf("--listen-port") + 1]);

/**
 * A spawner whose "mitmdump" is an in-test fake addon: it connects to the control socket from
 * env, says hello, acknowledges record and hosts controls, and answers each replay with a 200
 * response, or with `replyTo`'s result. `send` a `{"type":"flow"}` or `{"type":"tunnel"}` line
 * to report traffic.
 */
export function makeFakeMitmdump(
  replyTo?: (message: ReplayMessage) => Readonly<Record<string, unknown>> | undefined,
) {
  const spawns: Array<FakeSpawn> = [];
  let next = deferred<FakeSpawn>();
  const spawner: MitmSpawner = (command, args, env) => {
    const exited = deferred<void>();
    const socket = NodeNet.connect(Number(env[CONTROL_ENV.port]), "127.0.0.1");
    socket.on("error", () => undefined);
    socket.on("close", () => exited.resolve());
    const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
    const spawn: FakeSpawn = {
      command,
      args,
      env,
      pid: 4_000_000 + spawns.length,
      signals: [],
      replays: [],
      controls: [],
      exited: exited.promise,
      send,
      sendLine: (line) => socket.write(`${line}\n`),
    };
    send({ type: "hello", token: env[CONTROL_ENV.token] });
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
        const parsed = JSON.parse(buffered.slice(0, newline)) as Readonly<Record<string, unknown>>;
        buffered = buffered.slice(newline + 1);
        if (parsed.type === "record" || parsed.type === "hosts") {
          spawn.controls.push(parsed);
          send({ type: "applied", id: parsed.id });
          continue;
        }
        const message = parsed as unknown as ReplayMessage;
        spawn.replays.push(message);
        const reply = replyTo === undefined ? undefined : replyTo(message);
        send(
          reply ?? {
            type: "replayResult",
            replayId: message.replayId,
            flow: { ...flowRecord(), path: message.request.path },
          },
        );
      }
    });
    spawns.push(spawn);
    const current = next;
    next = deferred();
    current.resolve(spawn);
    return {
      pid: spawn.pid,
      exited: exited.promise,
      kill: (signal) => {
        spawn.signals.push(signal);
        socket.destroy();
        exited.resolve();
      },
      stderrTail: () => "",
    };
  };
  return {
    spawner,
    spawns,
    nextSpawn: (index: number) =>
      spawns[index] !== undefined ? Promise.resolve(spawns[index]) : next.promise,
  };
}

export interface InspectorHarness extends AsyncDisposable {
  readonly dataDir: string;
  readonly client: WorkerClient;
  readonly timer: ReturnType<typeof makeFakeTimer>;
  /** Invokes `operation` as `caller` with `context` and resolves with its result. */
  readonly call: (
    operation: string,
    input?: unknown,
    options?: { readonly caller?: "ui" | "agent"; readonly context?: CallContext },
  ) => Promise<unknown>;
  /** Subscribes and resolves with the first snapshot or batch whose items satisfy `match`. */
  readonly nextBatch: (
    topic: string,
    params: unknown,
    match: (items: ReadonlyArray<unknown>) => boolean,
  ) => Promise<{ readonly items: ReadonlyArray<unknown>; readonly stop: () => Promise<void> }>;
}

/** Runs the inspector backend in-process behind the real SDK worker protocol. */
export async function startInspector(options: {
  readonly config?: Readonly<Record<string, unknown>>;
  readonly deps?: Partial<InspectorDeps>;
  /** A directory holding an executable named mitmdump; the fake spawner never runs it. */
  readonly withMitmdumpOnPath?: boolean;
  readonly resolveContext?: FakeContextResolver;
  readonly busyPorts?: ReadonlyArray<number>;
}): Promise<InspectorHarness> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "request-inspector-worker-"));
  const dataDir = NodePath.join(root, "data");
  const binDir = NodePath.join(root, "bin");
  await NodeFSP.mkdir(binDir);
  if (options.withMitmdumpOnPath !== false) {
    await NodeFSP.writeFile(NodePath.join(binDir, "mitmdump"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
  }
  // As if mitmdump already ran once: an upstream-auth start links this CA into its confdir.
  await NodeFSP.mkdir(NodePath.join(dataDir, "mitmproxy"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(dataDir, "mitmproxy", "mitmproxy-ca.pem"), "FAKE CA\n");
  const timer = makeFakeTimer();
  const toWorker = new NodeStream.PassThrough();
  const fromWorker = new NodeStream.PassThrough();
  const exited = deferred<number>();
  definePluginBackend(
    createInspectorBackend({
      addonSource: ADDON_SOURCE,
      searchPath: binDir,
      timer: timer.timer,
      // No test binds a real port; `busyPorts` stands in for ports other programs hold.
      probePort: async (_host, port) => {
        if (options.busyPorts?.includes(port) === true) {
          throw new MitmStartError("port-in-use", `Port ${port} is already in use.`);
        }
      },
      ...options.deps,
    }),
    { input: toWorker, output: fromWorker, exit: (code) => exited.resolve(code) },
  );
  const client = makeWorkerClient({
    input: fromWorker,
    output: toWorker,
    ...(options.resolveContext === undefined ? {} : { resolveContext: options.resolveContext }),
    initialize: {
      pluginId: "request-inspector",
      version: "0.1.0",
      dataDir,
      config: options.config ?? {},
      secrets: {},
    },
  });
  await client.initialize();
  return {
    dataDir,
    client,
    timer,
    call: (operation, input = {}, callOptions = {}) =>
      client.invoke(operation, input, callOptions.caller ?? "ui", callOptions.context).result,
    nextBatch: async (topic, params, match) => {
      const found = deferred<ReadonlyArray<unknown>>();
      const stop = await client.subscribe(topic, params, (event: PluginSubscriptionEvent) => {
        if ((event.type === "batch" || event.type === "snapshot") && match(event.items)) {
          found.resolve(event.items);
        }
      });
      return found.promise.then((items) => ({ items, stop }));
    },
    [Symbol.asyncDispose]: async () => {
      await client.close();
      await exited.promise;
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}
