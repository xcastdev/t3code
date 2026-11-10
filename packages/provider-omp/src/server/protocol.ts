export type OmpRpcRecord = Record<string, unknown> & { type: string };
const MAX_OMP_FRAME_BYTES = 1024 * 1024;
export const MAX_OMP_REASSEMBLED_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
function record(v: unknown): v is OmpRpcRecord {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    "type" in v &&
    typeof v.type === "string" &&
    v.type.length > 0
  );
}
function decodeOmpRecord(v: unknown): OmpRpcRecord {
  if (!record(v)) throw new Error("OMP frame must have a type");
  if (v.type === "rpc_frame_error") throw new Error("OMP failed to deliver a required frame");
  if (
    v.type === "response" &&
    ((v.id !== undefined && (typeof v.id !== "string" || !v.id)) ||
      typeof v.command !== "string" ||
      typeof v.success !== "boolean")
  )
    throw new Error("Invalid OMP response envelope");
  if (
    v.type === "extension_ui_request" &&
    (typeof v.id !== "string" || !v.id || typeof v.method !== "string" || !v.method)
  )
    throw new Error("Invalid OMP extension UI envelope");
  return v;
}
export class OmpProtocolDecoder {
  private line = new Uint8Array(MAX_OMP_FRAME_BYTES);
  private bytes = 0;
  private frameLimit = MAX_OMP_FRAME_BYTES;
  private logicalLimit = MAX_OMP_REASSEMBLED_BYTES;
  private ready = false;
  private v2 = false;
  private pending:
    | {
        id: string;
        count: number;
        length: number;
        next: number;
        bytes: number;
        parts: Uint8Array[];
      }
    | undefined;
  enableV2() {
    if (!this.ready) throw new Error("OMP v2 requires readiness");
    this.v2 = true;
  }
  *push(input: Uint8Array): Generator<OmpRpcRecord> {
    let start = 0;
    for (let end = 0; end < input.length; end++) {
      if (input[end] !== 10) continue;
      const part = input.subarray(start, end);
      if (this.bytes + part.length + 1 > this.frameLimit)
        throw new Error("OMP physical frame limit exceeded");
      this.line.set(part, this.bytes);
      this.bytes += part.length;
      const bytes = this.line.subarray(0, this.bytes);
      this.bytes = 0;
      start = end + 1;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value = decodeOmpRecord(JSON.parse(text));
      const frame = this.accept(value);
      if (frame) yield frame;
    }
    if (start < input.length) {
      const part = input.subarray(start);
      if (this.bytes + part.length + 1 > this.frameLimit)
        throw new Error("OMP physical frame limit exceeded");
      this.line.set(part, this.bytes);
      this.bytes += part.length;
    }
  }
  end() {
    if (this.bytes || this.pending) throw new Error("OMP incomplete frame or chunk sequence");
  }
  private accept(v: OmpRpcRecord): OmpRpcRecord | undefined {
    if (v.type !== "rpc_chunk") {
      if (this.pending) throw new Error("OMP chunk sequence interrupted");
      if (v.type === "ready") {
        if (
          this.ready ||
          v.protocolVersion !== 1 ||
          !Array.isArray(v.supportedProtocolVersions) ||
          !v.supportedProtocolVersions.includes(2) ||
          !Number.isSafeInteger(v.maxFrameBytes) ||
          Number(v.maxFrameBytes) < 128 ||
          !Number.isSafeInteger(v.maxReassembledFrameBytes) ||
          Number(v.maxReassembledFrameBytes) < Number(v.maxFrameBytes)
        )
          throw new Error("Unsupported OMP readiness");
        this.ready = true;
        this.frameLimit = Math.min(MAX_OMP_FRAME_BYTES, Number(v.maxFrameBytes));
        this.logicalLimit = Math.min(MAX_OMP_REASSEMBLED_BYTES, Number(v.maxReassembledFrameBytes));
      }
      return v;
    }
    if (!this.v2) throw new Error("OMP chunks arrived before v2 negotiation");
    const { chunkId, index, count, byteLength, data } = v;
    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      Number(index) < 0 ||
      Number(index) >= Number(count) ||
      Number(count) < 2 ||
      Number(byteLength) < this.frameLimit ||
      Number(byteLength) > this.logicalLimit ||
      count !== Math.ceil(Number(byteLength) / CHUNK_BYTES)
    )
      throw new Error("Invalid OMP chunk metadata");
    if (
      typeof data !== "string" ||
      !data ||
      data.length > 4 * Math.ceil(CHUNK_BYTES / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    )
      throw new Error("Invalid OMP chunk base64");
    const bytes = Buffer.from(data, "base64");
    if (
      bytes.toString("base64") !== data ||
      bytes.length !==
        (index === Number(count) - 1
          ? Number(byteLength) - Number(index) * CHUNK_BYTES
          : CHUNK_BYTES)
    )
      throw new Error("Invalid OMP chunk length");
    if (!this.pending) {
      if (index !== 0) throw new Error("OMP chunk sequence must start at zero");
      this.pending = {
        id: chunkId,
        count: Number(count),
        length: Number(byteLength),
        next: 0,
        bytes: 0,
        parts: [],
      };
    }
    const p = this.pending;
    if (p.id !== chunkId || p.count !== count || p.length !== byteLength || p.next !== index)
      throw new Error("OMP chunk sequence mismatch");
    p.parts.push(bytes);
    p.bytes += bytes.length;
    p.next++;
    if (p.bytes > p.length) throw new Error("OMP chunk sequence overflow");
    if (p.next < p.count) return;
    if (p.bytes !== p.length) throw new Error("OMP chunk length mismatch");
    this.pending = undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(p.parts, p.bytes));
    const frame = decodeOmpRecord(JSON.parse(text));
    if (frame.type === "rpc_chunk" || frame.type === "ready")
      throw new Error("OMP nested transport frame");
    return frame;
  }
}

// Native stdin accepts JSON lines, while rpc_chunk is an output-only envelope.
export function* encodeOmpInput(json: string): Generator<Uint8Array> {
  const bytes = new TextEncoder().encode(json + "\n");
  if (bytes.length - 1 > MAX_OMP_REASSEMBLED_BYTES)
    throw new Error("OMP outbound logical frame limit exceeded");
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES)
    yield bytes.subarray(offset, offset + CHUNK_BYTES);
}
