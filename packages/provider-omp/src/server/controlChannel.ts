// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { requiredGuards } from "./compatibility.ts";

interface ControlBase {
  v: 1;
  providerSession: string;
  epoch: string;
  id: string;
}
export type ControlEnvelope = ControlBase &
  (
    | {
        type: "approval_request";
        payload: {
          prompt: { full: string; compact: string };
          origin: { nativeCallId: string; tool?: string };
        };
      }
    | { type: "approval_answer"; answer: "once" | "deny" }
    | {
        type: "ready";
        payload: {
          recipe: "omp-18.16.0-bun-1.4.4";
          guards: string[];
          mode: "approval-required" | "auto-accept-edits" | "full-access";
        };
      }
    | { type: "invalidate" | "cancel"; payload?: { reason: string } }
  );
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
export function decodeControlEnvelope(
  value: unknown,
): { ok: true; value: ControlEnvelope } | { ok: false } {
  if (typeof value !== "object" || value === null) return { ok: false };
  const v = value as Record<string, unknown>;
  if (
    v.v !== 1 ||
    !["ready", "approval_request", "approval_answer", "invalidate", "cancel"].includes(
      String(v.type),
    ) ||
    ![v.providerSession, v.epoch, v.id].every(
      (x) => typeof x === "string" && x.length > 0 && x.length < 256,
    ) ||
    (v.type === "approval_answer" && v.answer !== "once" && v.answer !== "deny")
  )
    return { ok: false };
  if (v.type === "approval_request") {
    if (
      !record(v.payload) ||
      !record(v.payload.prompt) ||
      !record(v.payload.origin) ||
      ![v.payload.prompt.full, v.payload.prompt.compact, v.payload.origin.nativeCallId].every(
        (x) => typeof x === "string" && x.length > 0 && x.length < 64 * 1024,
      ) ||
      (v.payload.origin.tool !== undefined &&
        (typeof v.payload.origin.tool !== "string" ||
          v.payload.origin.tool.length === 0 ||
          v.payload.origin.tool.length > 256))
    )
      return { ok: false };
  }
  if (v.type === "ready") {
    if (
      !record(v.payload) ||
      v.payload.recipe !== "omp-18.16.0-bun-1.4.4" ||
      !["approval-required", "auto-accept-edits", "full-access"].includes(String(v.payload.mode)) ||
      !Array.isArray(v.payload.guards) ||
      v.payload.guards.length !== requiredGuards.length ||
      requiredGuards.some((name) => !(v.payload as { guards: unknown[] }).guards.includes(name))
    )
      return { ok: false };
  }
  if (
    (v.type === "invalidate" || v.type === "cancel") &&
    v.payload !== undefined &&
    (!record(v.payload) || typeof v.payload.reason !== "string")
  )
    return { ok: false };
  return { ok: true, value: value as ControlEnvelope };
}
export class ApprovalBroker {
  private pending = new Map<string, (answer: "once" | "deny") => void>();
  private closed = false;
  readonly providerSession: string;
  readonly epoch: string;
  private send: (frame: ControlEnvelope) => void;
  constructor(providerSession: string, epoch: string, send: (frame: ControlEnvelope) => void) {
    this.providerSession = providerSession;
    this.epoch = epoch;
    this.send = send;
  }
  request(
    prompt: { full: string; compact: string },
    origin: { nativeCallId: string; tool?: string },
  ) {
    if (this.closed) return Promise.resolve("deny" as const);
    const id = NodeCrypto.randomUUID();
    return new Promise<"once" | "deny">((resolve) => {
      this.pending.set(id, resolve);
      try {
        this.send({
          v: 1,
          type: "approval_request",
          providerSession: this.providerSession,
          epoch: this.epoch,
          id,
          payload: { prompt, origin },
        });
      } catch {
        this.pending.delete(id);
        resolve("deny");
      }
    });
  }
  answer(frame: ControlEnvelope) {
    if (
      this.closed ||
      frame.type !== "approval_answer" ||
      frame.providerSession !== this.providerSession ||
      frame.epoch !== this.epoch ||
      (frame.answer !== "once" && frame.answer !== "deny")
    )
      return false;
    const resolve = this.pending.get(frame.id);
    if (!resolve) return false;
    this.pending.delete(frame.id);
    resolve(frame.answer);
    return true;
  }
  expire(id: string) {
    const resolve = this.pending.get(id);
    this.pending.delete(id);
    resolve?.("deny");
  }
  close() {
    this.closed = true;
    for (const resolve of this.pending.values()) resolve("deny");
    this.pending.clear();
  }
}

function frames(socket: NodeNet.Socket, consume: (frame: unknown) => void) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 128 * 1024) {
      socket.destroy(new Error("OMP control frame too large"));
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        consume(JSON.parse(line));
      } catch {
        socket.destroy(new Error("Malformed OMP control frame"));
        return;
      }
    }
  });
}
export function resolveControlAddress(root: string, platform: NodeJS.Platform) {
  return platform === "win32"
    ? `\\\\.\\pipe\\${NodePath.basename(root)}`
    : NodePath.join(root, "control.sock");
}
export async function createControlServer(
  onFrame: (frame: ControlEnvelope, reply: (frame: ControlEnvelope) => void) => void,
  onDisconnect: () => void,
) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Materialized Bun assets cannot import workspace HostProcess services.
  const platform = process.platform;
  let prefix = NodePath.join(NodeOS.tmpdir(), "t3-omp-control-");
  const maxPathBytes = platform === "linux" ? 107 : 103;
  if (
    platform !== "win32" &&
    Buffer.byteLength(NodePath.join(prefix + "XXXXXX", "control.sock")) > maxPathBytes
  )
    prefix = NodePath.join("/tmp", "t3-omp-control-");
  const root = await NodeFSP.mkdtemp(prefix);
  const path = resolveControlAddress(root, platform);
  const credentialPath = NodePath.join(root, "credential.json");
  const secret = NodeCrypto.randomUUID() + NodeCrypto.randomUUID();
  const sockets = new Set<NodeNet.Socket>();
  let connected = false;
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      onDisconnect();
    });
    let authenticated = false;
    frames(socket, (value) => {
      if (!authenticated) {
        if (
          typeof value !== "object" ||
          value === null ||
          !("secret" in value) ||
          typeof value.secret !== "string"
        )
          throw new Error("OMP control auth required");
        const bytes = Buffer.from(value.secret);
        const expected = Buffer.from(secret);
        if (
          connected ||
          bytes.length !== expected.length ||
          !NodeCrypto.timingSafeEqual(bytes, expected)
        )
          throw new Error("OMP control auth rejected");
        connected = authenticated = true;
        return;
      }
      const decoded = decodeControlEnvelope(value);
      if (!decoded.ok) throw new Error("Invalid OMP control envelope");
      onFrame(decoded.value, (frame) => socket.write(JSON.stringify(frame) + "\n"));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    if (platform !== "win32") await NodeFSP.chmod(path, 0o600);
    await NodeFSP.writeFile(credentialPath, JSON.stringify({ path, secret }), { mode: 0o600 });
  } catch (error) {
    server.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    credentialPath,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}
export async function connectControl(
  credential: { path: string; secret: string },
  onFrame: (frame: ControlEnvelope) => void,
  onDisconnect: () => void,
) {
  const socket = NodeNet.createConnection(credential.path);
  socket.on("error", () => {});
  socket.on("close", onDisconnect);
  frames(socket, (value) => {
    const decoded = decodeControlEnvelope(value);
    if (!decoded.ok) throw new Error("Invalid OMP control envelope");
    onFrame(decoded.value);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", resolve);
  });
  socket.write(JSON.stringify({ secret: credential.secret }) + "\n");
  return {
    send(frame: ControlEnvelope) {
      socket.write(JSON.stringify(frame) + "\n");
    },
    close() {
      socket.destroy();
    },
  };
}
