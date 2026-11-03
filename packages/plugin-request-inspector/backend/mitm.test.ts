// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Drives the builtin-only inspector worker with a fake mitmdump.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { WorkerRequestError } from "@t3tools/plugin-sdk/testing";
import { describe, expect, it, vi } from "vite-plus/test";

import { ADDON_SOURCE, flowRecord, makeFakeMitmdump, startInspector } from "./inspector.testkit.ts";
import { makeMitm, MITMDUMP_HINT, mitmdumpArgs } from "./mitm.ts";
import type { ReplayResult } from "./replay.ts";
import { deferred, makeFakeTimer } from "./replay.testkit.ts";

const ADDON_PATH = /\/runtime\/[0-9a-f]{16}-addon\.py$/;

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => {
      if (!(error instanceof WorkerRequestError)) throw error;
      return error;
    },
  );

const hasRequest = (items: ReadonlyArray<unknown>) =>
  items.some((item) => (item as { readonly kind?: string }).kind === "request");

describe("mitmdump process control", () => {
  it("capture and replay-only argv pass the materialized addon path under dataDir/runtime", async () => {
    const mitm = makeFakeMitmdump();
    await using inspector = await startInspector({
      config: { listenHost: "127.0.0.1", listenPort: 18_080 },
      deps: { spawner: mitm.spawner },
    });
    const { client, dataDir } = inspector;
    const confdir = NodePath.join(dataDir, "mitmproxy");

    const started = (await client.invoke("start_capture", {}).result) as { captureId: string };
    const capture = await mitm.nextSpawn(0);
    const addonPath = capture.args.at(-1) as string;
    expect(addonPath.startsWith(NodePath.join(dataDir, "runtime"))).toBe(true);
    expect(addonPath).toMatch(ADDON_PATH);
    expect(NodeFS.readFileSync(addonPath, "utf8")).toBe(ADDON_SOURCE);
    expect(capture.command.endsWith(`${NodePath.sep}mitmdump`)).toBe(true);
    expect(capture.args).toEqual(
      mitmdumpArgs(
        { kind: "capture", listenHost: "127.0.0.1", listenPort: 18_080 },
        confdir,
        addonPath,
      ),
    );
    expect(capture.args.slice(0, 4)).toEqual([
      "--listen-host",
      "127.0.0.1",
      "--listen-port",
      "18080",
    ]);

    const stored = inspector.nextBatch("requests", {}, hasRequest);
    capture.send(flowRecord());
    const { items, stop } = await stored;
    await stop();
    const requestId = (items[0] as { readonly id: string }).id;
    expect(await client.invoke("stop_capture", {}).result).toEqual({
      captureId: started.captureId,
    });
    expect(capture.signals).toEqual(["SIGTERM"]);

    const preview = (await client.invoke("preview_replay", { requestId }).result) as {
      idempotencyKey: string;
    };
    const accepted = (await client.invoke("replay_request", {
      requestId,
      idempotencyKey: preview.idempotencyKey,
    }).result) as { replayId: string; state: string };
    expect(accepted.state).toBe("pending");
    const transient = await mitm.nextSpawn(1);
    expect(transient.args).toEqual(mitmdumpArgs({ kind: "replay" }, confdir, addonPath));
    expect(transient.args.slice(0, 2)).toEqual(["--set", "server=false"]);

    expect(
      await client.invoke("get_replay", { replayId: accepted.replayId, waitMs: 20_000 }).result,
    ).toMatchObject({ state: "completed", dispatched: true });
    await transient.exited;
    expect(transient.signals).toEqual(["SIGTERM"]);
  });

  it("a control message whose handler fails is dropped and later messages are still handled", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "request-inspector-mitm-"));
    try {
      const binDir = NodePath.join(root, "bin");
      await NodeFSP.mkdir(binDir);
      await NodeFSP.writeFile(NodePath.join(binDir, "mitmdump"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      const fake = makeFakeMitmdump();
      const logs: Array<string> = [];
      const result = deferred<ReplayResult>();
      let flows = 0;
      const mitm = makeMitm({
        dataDir: root,
        addonSource: ADDON_SOURCE,
        maxBodyBytes: 1024,
        searchPath: binDir,
        materialize: async () => NodePath.join(root, "addon.py"),
        timer: makeFakeTimer().timer,
        spawner: fake.spawner,
        log: (message) => logs.push(message),
      });
      const started = await mitm.start(
        { kind: "replay" },
        {
          onFlow: async () => {
            flows += 1;
            throw new Error("database is locked");
          },
          onReplayResult: async (value) => result.resolve(value),
        },
      ).ready;
      const spawn = await fake.nextSpawn(0);
      spawn.send(flowRecord());
      spawn.send(flowRecord());
      spawn.send({ type: "replayResult", replayId: "r1", error: "refused" });

      expect(await result.promise).toEqual({ replayId: "r1", error: "refused" });
      expect(flows).toBe(2);
      expect(logs).toEqual([
        "Handling a control message from mitmdump failed.",
        "Handling a control message from mitmdump failed.",
      ]);
      await started.stop();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("start fails with port-in-use when the port is bound", async () => {
    const blocker = NodeNet.createServer();
    const listening = deferred<number>();
    blocker.listen({ host: "127.0.0.1", port: 0 }, () =>
      listening.resolve((blocker.address() as NodeNet.AddressInfo).port),
    );
    const port = await listening.promise;
    try {
      const mitm = makeFakeMitmdump();
      await using inspector = await startInspector({
        config: { listenHost: "127.0.0.1", listenPort: port },
        deps: { spawner: mitm.spawner },
      });
      const error = await failure(inspector.client.invoke("start_capture", {}).result);
      expect(error.reason).toBe("operation-failed");
      expect(error.detail).toContain(`Port ${port} on 127.0.0.1 is already in use.`);
      expect(mitm.spawns).toEqual([]);
      expect(await inspector.client.invoke("list_captures", {}).result).toEqual({ items: [] });
    } finally {
      blocker.close();
    }
  });

  it("start reports missing-prerequisite when mitmdump is absent", async () => {
    const mitm = makeFakeMitmdump();
    await using inspector = await startInspector({
      withMitmdumpOnPath: false,
      deps: { spawner: mitm.spawner },
    });
    const error = await failure(inspector.client.invoke("start_capture", {}).result);
    expect(error.detail).toBe(MITMDUMP_HINT);
    expect(inspector.client.statuses).toEqual([
      { state: "missing-prerequisite", detail: MITMDUMP_HINT },
    ]);
    expect(mitm.spawns).toEqual([]);
  });

  it("logs contain no header values or bodies", async () => {
    const secrets = [
      "Bearer SECRET-AUTH-TOKEN",
      "session=SECRET-COOKIE",
      "SECRET-API-KEY",
      "SECRET-REQUEST-BODY",
      "SECRET-RESPONSE-BODY",
      "SECRET-SET-COOKIE",
    ];
    using logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mitm = makeFakeMitmdump((message) => ({
      type: "replayResult",
      replayId: message.replayId,
      error: "upstream refused",
    }));
    {
      await using inspector = await startInspector({ deps: { spawner: mitm.spawner } });
      const { client } = inspector;
      await client.invoke("start_capture", {}).result;
      const capture = await mitm.nextSpawn(0);
      const stored = inspector.nextBatch("requests", {}, hasRequest);
      capture.sendLine('{"type":"flow","headers":"SECRET-API-KEY"}');
      capture.sendLine("not json SECRET-REQUEST-BODY");
      capture.send(
        flowRecord({
          headers: [
            ["authorization", "Bearer SECRET-AUTH-TOKEN"],
            ["cookie", "session=SECRET-COOKIE"],
            ["x-api-key", "SECRET-API-KEY"],
          ],
          body: "SECRET-REQUEST-BODY",
          responseHeaders: [["set-cookie", "SECRET-SET-COOKIE"]],
          responseBody: "SECRET-RESPONSE-BODY",
        }),
      );
      const { items, stop } = await stored;
      await stop();
      const requestId = (items[0] as { readonly id: string }).id;
      await client.invoke("get_request", {
        requestId,
        bodies: "both",
        includeSensitiveHeaders: true,
      }).result;
      const preview = (await client.invoke("preview_replay", { requestId }).result) as {
        idempotencyKey: string;
      };
      const accepted = (await client.invoke("replay_request", {
        requestId,
        idempotencyKey: preview.idempotencyKey,
      }).result) as { replayId: string };
      expect(
        await client.invoke("get_replay", { replayId: accepted.replayId, waitMs: 20_000 }).result,
      ).toMatchObject({ state: "failed", dispatched: true });
      await failure(
        client.invoke("replay_request", {
          requestId,
          idempotencyKey: "rk1.SECRET-API-KEY",
        }).result,
      );
      await client.invoke("stop_capture", {}).result;
    }

    const lines = logged.mock.calls.map((call) => call.map(String).join(" "));
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(lines.filter((line) => line.includes(secret))).toEqual([]);
    }
  });
});
