// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "vite-plus/test";
import { connectControl, createControlServer, resolveControlAddress } from "./controlChannel.ts";

it("uses a distinct Windows named pipe for each private control directory", () => {
  const first = resolveControlAddress(NodePath.join("temporary", "t3-omp-control-first"), "win32");
  const second = resolveControlAddress(
    NodePath.join("temporary", "t3-omp-control-second"),
    "win32",
  );
  expect(first).toBe(String.raw`\\.\pipe\t3-omp-control-first`);
  expect(first).not.toBe(second);
});

it("authenticates and exchanges control frames when the configured temporary directory exceeds socket limits", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-omp-long-"));
  const long = NodePath.join(root, "x".repeat(110));
  await NodeFSP.mkdir(long);
  const key = HostProcess.Platform.defaultValue() === "win32" ? "TEMP" : "TMPDIR";
  const previous = process.env[key];
  process.env[key] = long;
  try {
    const received = Promise.withResolvers<unknown>();
    const answer = Promise.withResolvers<unknown>();
    const server = await createControlServer(
      (frame, reply) => {
        received.resolve(frame);
        reply({ v: 1, type: "cancel", providerSession: "s", epoch: "e", id: "response" });
      },
      () => {},
    );
    try {
      const credential = JSON.parse(await NodeFSP.readFile(server.credentialPath, "utf8"));
      const client = await connectControl(credential, answer.resolve, () => {});
      try {
        const request = {
          v: 1,
          type: "cancel",
          providerSession: "s",
          epoch: "e",
          id: "request",
        } as const;
        client.send(request);
        expect(await received.promise).toEqual(request);
        expect(await answer.promise).toMatchObject({ id: "response" });
      } finally {
        client.close();
      }
    } finally {
      await server.close();
    }
    await expect(NodeFSP.access(server.credentialPath)).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
