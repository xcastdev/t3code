const encoder = new TextEncoder();
const statuses = ["running", "completed", "failed", "cancelled"] as const;
export interface OmpEvalEnvelope {
  readonly origin: "omp.eval";
  readonly version: 1;
  readonly revision: number;
  readonly language: string;
  readonly status: (typeof statuses)[number];
  readonly title?: string;
  readonly stdoutTail?: string;
  readonly phase?: string;
  readonly logs?: readonly string[];
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly inputTruncated?: boolean;
  readonly outputTruncated?: boolean;
  readonly images?: readonly { readonly index: number; readonly mimeType: string }[];
  readonly attachmentRevision?: number;
}
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const chars = (v: string, n: number) => {
  let result = "";
  let count = 0;
  for (const point of v) {
    if (count++ >= n) break;
    result += point;
  }
  return result;
};
export function boundOmpText(value: string, maxBytes: number, tail = false) {
  let range = tail ? value.slice(-maxBytes) : value.slice(0, maxBytes);
  if (tail && range.length < value.length && /[\uDC00-\uDFFF]/.test(range[0] ?? ""))
    range = range.slice(1);
  if (!tail && range.length < value.length && /[\uD800-\uDBFF]/.test(range.at(-1) ?? ""))
    range = range.slice(0, -1);
  const points = Array.from(range);
  let low = 0,
    high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = (tail ? points.slice(-mid) : points.slice(0, mid)).join("");
    if (encoder.encode(JSON.stringify(candidate)).length <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return (tail ? points.slice(points.length - low) : points.slice(0, low)).join("");
}
const imageMimeTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
function ompImage(block: unknown) {
  if (!object(block) || block.type !== "image") return;
  const source = object(block.source) ? block.source : undefined;
  if (source && source.type !== "base64") return;
  const mime = source ? source.media_type : block.mimeType;
  const data = source ? source.data : block.data;
  if (typeof mime !== "string" || !imageMimeTypes.includes(mime.toLowerCase())) return;
  return { mimeType: mime.toLowerCase(), ...(typeof data === "string" ? { data } : {}) };
}
export function normalizeOmpEvalImages(output: unknown): unknown {
  if (!object(output) || !object(output.details) || !Array.isArray(output.details.images))
    return output;
  const content = Array.isArray(output.content) ? [...output.content] : [];
  const existing = content.flatMap((block) => {
    const image = ompImage(block);
    return image ? [image] : [];
  });
  const unmatched = [...existing];
  let count = existing.length;
  for (const block of output.details.images) {
    const image = ompImage(block);
    if (!image) continue;
    const duplicate = unmatched.findIndex(
      (prior) => prior.mimeType === image.mimeType && prior.data === image.data,
    );
    if (duplicate >= 0) {
      unmatched.splice(duplicate, 1);
      continue;
    }
    if (count++ < 8) content.push(block);
  }
  const { images: _images, ...details } = output.details;
  return { ...output, content, details };
}
export function ompEvalTitle(argsTitle: unknown, cellTitle: unknown, language: unknown) {
  for (const title of [argsTitle, cellTitle])
    if (typeof title === "string" && title.trim()) return chars(title.trim(), 160);
  const name = typeof language === "string" ? language.trim().toLowerCase() : "";
  return name === "py" || name === "python"
    ? "Python eval"
    : name === "js" || name === "javascript"
      ? "JavaScript eval"
      : name
        ? `${chars(name, 32)} eval`
        : "Eval";
}
export function makeOmpEvalEnvelope(
  input: Omit<OmpEvalEnvelope, "origin" | "version">,
): OmpEvalEnvelope {
  if (
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !statuses.includes(input.status)
  )
    throw new Error("Invalid OMP eval lifecycle");
  const output = {
    origin: "omp.eval",
    version: 1,
    revision: input.revision,
    language: chars(input.language, 32),
    status: input.status,
    ...(input.images
      ? {
          images: input.images
            .slice(0, 8)
            .map((image, index) => ({ index, mimeType: image.mimeType.toLowerCase() })),
        }
      : {}),
    ...(input.attachmentRevision !== undefined
      ? { attachmentRevision: input.attachmentRevision }
      : {}),
    ...(input.title === undefined ? {} : { title: chars(input.title, 160) }),
    ...(input.phase === undefined ? {} : { phase: chars(input.phase, 160) }),
    ...(input.stdoutTail === undefined
      ? {}
      : { stdoutTail: boundOmpText(input.stdoutTail, 2048, true) }),
    ...(input.logs ? { logs: input.logs.slice(-4).map((v) => chars(v, 128)) } : {}),
    ...(input.durationMs !== undefined && Number.isFinite(input.durationMs) && input.durationMs >= 0
      ? { durationMs: input.durationMs }
      : {}),
    ...(input.exitCode !== undefined && Number.isSafeInteger(input.exitCode)
      ? { exitCode: input.exitCode }
      : {}),
    ...(input.inputTruncated ? { inputTruncated: true } : {}),
    ...(input.outputTruncated ||
    (input.stdoutTail !== undefined &&
      boundOmpText(input.stdoutTail, 2048, true) !== input.stdoutTail)
      ? { outputTruncated: true }
      : {}),
  } satisfies OmpEvalEnvelope;
  const size = () => encoder.encode(JSON.stringify(output)).length;
  while (size() > 4096) {
    if (output.stdoutTail) {
      output.stdoutTail = boundOmpText(
        output.stdoutTail,
        Math.max(2, encoder.encode(JSON.stringify(output.stdoutTail)).length - 128),
        true,
      );
      output.outputTruncated = true;
    } else if (output.logs?.length) output.logs.pop();
    else if (output.phase)
      output.phase = chars(output.phase, Math.floor(Array.from(output.phase).length / 2));
    else if (output.title)
      output.title = chars(output.title, Math.floor(Array.from(output.title).length / 2));
    else throw new Error("OMP envelope budget exceeded");
  }
  return output;
}
export function readOmpEvalEnvelope(root: unknown): OmpEvalEnvelope | undefined {
  if (!object(root) || !object(root.t3OmpEval)) return;
  const v = root.t3OmpEval;
  if (
    v.origin !== "omp.eval" ||
    v.version !== 1 ||
    typeof v.language !== "string" ||
    typeof v.revision !== "number" ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    !statuses.some((s) => s === v.status)
  )
    return;
  if (
    Object.keys(v).some(
      (k) =>
        ![
          "origin",
          "version",
          "revision",
          "language",
          "status",
          "title",
          "stdoutTail",
          "phase",
          "logs",
          "durationMs",
          "exitCode",
          "inputTruncated",
          "outputTruncated",
          "images",
          "attachmentRevision",
        ].includes(k),
    )
  )
    return;
  for (const key of ["title", "stdoutTail", "phase"])
    if (v[key] !== undefined && typeof v[key] !== "string") return;
  if (v.logs !== undefined && (!Array.isArray(v.logs) || v.logs.some((l) => typeof l !== "string")))
    return;
  for (const key of ["durationMs", "exitCode"])
    if (v[key] !== undefined && (typeof v[key] !== "number" || !Number.isFinite(v[key]))) return;
  for (const key of ["inputTruncated", "outputTruncated"])
    if (v[key] !== undefined && typeof v[key] !== "boolean") return;
  if (
    v.attachmentRevision !== undefined &&
    (!Number.isSafeInteger(v.attachmentRevision) || Number(v.attachmentRevision) < 0)
  )
    return;
  if (
    v.images !== undefined &&
    (!Array.isArray(v.images) ||
      v.images.length > 8 ||
      v.images.some(
        (image, index) =>
          !object(image) ||
          image.index !== index ||
          typeof image.mimeType !== "string" ||
          !imageMimeTypes.includes(image.mimeType) ||
          Object.keys(image).some((key) => !["index", "mimeType"].includes(key)),
      ))
  )
    return;
  try {
    const normalized = makeOmpEvalEnvelope(v as unknown as OmpEvalEnvelope);
    return Object.keys(v).every(
      (key) => JSON.stringify(v[key]) === JSON.stringify(Reflect.get(normalized, key)),
    )
      ? normalized
      : undefined;
  } catch {
    return;
  }
}
export function mergeOmpEvalPreview(current: unknown, next: unknown): unknown {
  const a = readOmpEvalEnvelope(current),
    b = readOmpEvalEnvelope(next);
  return a &&
    (!b ||
      (a.status !== "running" && b.status === "running") ||
      a.revision > b.revision ||
      (a.revision === b.revision && a.status !== "running"))
    ? current
    : next;
}
export function ompEvalHydration(
  wire: unknown,
  detail: unknown,
  terminal: boolean,
  detailTerminal = false,
): "settled" | "load" | "fallback" {
  const a = readOmpEvalEnvelope(wire),
    b = readOmpEvalEnvelope(detail);
  if (
    b &&
    (!a || b.revision >= a.revision) &&
    (b.status !== "running" || (terminal && detailTerminal))
  )
    return "settled";
  if (terminal && !b && detail !== undefined) return "fallback";
  return "load";
}
/** Called after provider provenance validation, never inferred from arbitrary output text. */
export function boundedOmpEvalInput(input: unknown) {
  if (!object(input)) return input;
  const language = typeof input.language === "string" ? chars(input.language, 32) : "";
  const title = typeof input.title === "string" ? chars(input.title, 160) : "";
  const code = typeof input.code === "string" ? input.code : "";
  const bounded = boundOmpText(code, 65536);
  return { language, title, code: bounded, ...(bounded !== code ? { inputTruncated: true } : {}) };
}

export const isOmpArtifactId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9]{1,32}$/.test(value);
export function ompArtifactReferences(
  output: unknown,
): ReadonlyArray<Readonly<Record<string, string>>> {
  const native = object(output) && object(output.details) ? output.details : {};
  const refs: Record<string, string>[] = [];
  const ids = new Set<string>();
  let bytes = 2;
  const add = (id: unknown, description: Record<string, unknown> = {}) => {
    if (!isOmpArtifactId(id) || ids.has(id)) return;
    const ref: Record<string, string> = { id, uri: `artifact://${id}` };
    for (const key of ["title", "name", "mimeType"])
      if (typeof description[key] === "string") ref[key] = boundOmpText(description[key], 1024);
    const size = encoder.encode(JSON.stringify(ref)).length + 1;
    if (bytes + size > 8192) return;
    ids.add(id);
    refs.push(ref);
    bytes += size;
  };
  if (Array.isArray(native.artifacts))
    for (const value of native.artifacts.slice(0, 64)) {
      if (!object(value)) continue;
      const uri =
        typeof value.uri === "string"
          ? /^artifact:\/\/([0-9]{1,32})$/.exec(value.uri)?.[1]
          : undefined;
      const id = isOmpArtifactId(value.id) ? value.id : uri;
      if (uri && isOmpArtifactId(value.id) && uri !== value.id) continue;
      add(id, value);
    }
  const meta = object(native.meta) ? native.meta : {};
  const truncation = object(meta.truncation) ? meta.truncation : {};
  add(truncation.artifactId);
  return refs;
}
export function boundOmpEvalViews(cells: readonly unknown[]) {
  let bytes = 2,
    count = 0,
    omitted = false;
  const bounded = cells.slice(0, 8).map((cell) => {
    const raw = object(cell) && Array.isArray(cell.views) ? cell.views : [];
    const views: unknown[] = [];
    let viewsOmitted = raw.length > 8 || (object(cell) && cell.viewsOmitted === true);
    for (const view of raw.slice(0, 8)) {
      try {
        const encoded = JSON.stringify(view);
        if (encoded === undefined) {
          viewsOmitted = true;
          continue;
        }
        const size = encoder.encode(encoded).length;
        if (size > 8192 || bytes + size + (count ? 1 : 0) > 32768) {
          viewsOmitted = true;
          continue;
        }
        views.push(JSON.parse(encoded));
        bytes += size + (count++ ? 1 : 0);
      } catch {
        viewsOmitted = true;
      }
    }
    omitted ||= viewsOmitted;
    return { views, viewsOmitted };
  });
  return { cells: bounded, viewsOmitted: omitted || cells.length > 8 };
}
export function boundOmpEvalReplies(value: unknown) {
  const raw = Array.isArray(value) ? value : [];
  const replies: string[] = [];
  let bytes = 2;
  let repliesOmitted = raw.length > 16;
  for (const value of raw.slice(0, 16)) {
    if (typeof value !== "string") continue;
    const separator = replies.length ? 1 : 0;
    const remaining = 32_768 - bytes - separator;
    if (remaining < 2) {
      repliesOmitted = true;
      break;
    }
    const reply = boundOmpText(value, remaining);
    replies.push(reply);
    bytes += encoder.encode(JSON.stringify(reply)).length + separator;
    repliesOmitted ||= reply !== value;
  }
  return { replies, repliesOmitted };
}
export interface OmpEvalDetail {
  readonly origin: "omp.eval";
  readonly revision?: number;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "unknown";
  readonly language: string;
  readonly title: string;
  readonly code: string;
  readonly stdout: string;
  readonly replies: readonly string[];
  readonly repliesOmitted: boolean;
  readonly cells: readonly {
    code: string;
    output: string;
    language: string;
    status: string;
    views?: readonly unknown[];
    viewsOmitted?: boolean;
  }[];
  readonly viewsOmitted?: boolean;
  readonly images: readonly { index: number; mimeType: string }[];
  readonly artifacts: readonly Readonly<Record<string, string>>[];
  readonly inputTruncated: boolean;
  readonly outputTruncated: boolean;
}
export function decodeOmpEvalDetail(
  output: unknown,
  input: unknown,
  verifiedNative = false,
): OmpEvalDetail | undefined {
  const envelope = readOmpEvalEnvelope(output);
  if (!envelope && !verifiedNative) return;
  if (object(output) && output.t3OmpEval !== undefined && !envelope) return;
  const normalized = normalizeOmpEvalImages(output);
  const root = object(normalized) ? normalized : {};
  const args = object(input) ? input : {};
  const native = object(root.details) ? root.details : {};
  const replies = boundOmpEvalReplies(native.replies);
  const repliesOmitted = replies.repliesOmitted || native.repliesOmitted === true;
  const rawCells = Array.isArray(native.cells) ? native.cells.filter(object) : [];
  const viewProjection = boundOmpEvalViews(rawCells);
  const cells = rawCells.slice(0, 8).map((cell, index) => ({
    ...viewProjection.cells[index],
    code: boundOmpText(typeof cell.code === "string" ? cell.code : "", 4096),
    output: boundOmpText(typeof cell.output === "string" ? cell.output : "", 4096),
    language: typeof cell.language === "string" ? chars(cell.language, 32) : "",
    status: typeof cell.status === "string" ? chars(cell.status, 32) : "",
  }));
  const content = Array.isArray(root.content) ? root.content : [];
  let stdout = typeof native.stdout === "string" ? boundOmpText(native.stdout, 65536) : "";
  if (!stdout)
    for (const block of content) {
      if (object(block) && block.type === "text" && typeof block.text === "string")
        stdout = boundOmpText(
          stdout + (stdout ? "\n" : "") + boundOmpText(block.text, 65536),
          65536,
        );
    }
  if (!stdout) stdout = boundOmpText(cells.map((cell) => cell.output).join("\n"), 65536);
  const code =
    typeof args.code === "string"
      ? boundOmpText(args.code, 65536)
      : boundOmpText(cells.map((cell) => cell.code).join("\n"), 65536);
  const images = content
    .flatMap((block) => {
      const image = ompImage(block);
      return image ? [{ index: 0, mimeType: image.mimeType }] : [];
    })
    .slice(0, 8)
    .map((image, index) => ({ ...image, index }));
  if (!images.length && envelope?.images) images.push(...envelope.images);
  const artifacts = ompArtifactReferences(root);
  const status =
    envelope?.status ??
    (cells.some((c) => c.status === "error")
      ? "failed"
      : cells.some((c) => c.status === "running" || c.status === "pending")
        ? "running"
        : cells.length && cells.every((c) => c.status === "complete" || c.status === "completed")
          ? "completed"
          : "unknown");
  const inputTruncated =
    args.inputTruncated === true ||
    envelope?.inputTruncated === true ||
    (typeof args.code === "string" && code !== args.code) ||
    rawCells.some(
      (cell, index) => typeof cell.code === "string" && cell.code !== cells[index]?.code,
    );
  const outputTruncated =
    repliesOmitted ||
    native.outputTruncated === true ||
    native.viewsOmitted === true ||
    viewProjection.viewsOmitted ||
    envelope?.outputTruncated === true ||
    rawCells.length > cells.length ||
    rawCells.some(
      (cell, index) => typeof cell.output === "string" && cell.output !== cells[index]?.output,
    ) ||
    content.some(
      (block) =>
        object(block) &&
        typeof block.text === "string" &&
        boundOmpText(block.text, 65536) !== block.text,
    );
  const cellTitle = rawCells.at(-1)?.title;
  return {
    origin: "omp.eval",
    ...(envelope ? { revision: envelope.revision } : {}),
    status,
    language:
      envelope?.language ??
      (typeof args.language === "string" ? chars(args.language, 32) : (cells[0]?.language ?? "")),
    title: ompEvalTitle(
      args.title,
      typeof cellTitle === "string" && cellTitle.trim() ? cellTitle : envelope?.title,
      envelope?.language ?? args.language ?? rawCells.at(-1)?.language,
    ),
    code,
    stdout,
    replies: replies.replies,
    repliesOmitted,
    cells,
    viewsOmitted: native.viewsOmitted === true || viewProjection.viewsOmitted,
    images,
    artifacts,
    inputTruncated,
    outputTruncated,
  };
}
interface OmpDetailFetch {
  readonly id: number;
  readonly revision: number | null;
}
export class OmpEvalDetailState {
  private preview: unknown;
  private terminal = false;
  private pending: OmpDetailFetch | undefined;
  private next = 0;
  private failedRevision: number | null | undefined;
  detail: OmpEvalDetail | undefined;
  updateWire(output: unknown, terminal: boolean) {
    this.preview = mergeOmpEvalPreview(this.preview, output);
    this.terminal ||=
      terminal ||
      (readOmpEvalEnvelope(this.preview)?.status !== undefined &&
        readOmpEvalEnvelope(this.preview)?.status !== "running");
  }
  get status(): "idle" | "load" | "loading" | "settled" | "fallback" {
    const envelope = readOmpEvalEnvelope(this.preview);
    const revision = envelope?.revision ?? null;
    if (
      this.detail &&
      this.detail.status !== "running" &&
      this.detail.status !== "unknown" &&
      this.detail.revision !== undefined &&
      (!envelope || this.detail.revision >= envelope.revision)
    )
      return "settled";
    if (this.failedRevision === revision && this.terminal) return "fallback";
    if (this.pending?.revision === revision) return "loading";
    if (!this.terminal && !envelope) return "idle";
    return "load";
  }
  begin(): OmpDetailFetch | undefined {
    if (this.status !== "load") return;
    const token = {
      id: ++this.next,
      revision: readOmpEvalEnvelope(this.preview)?.revision ?? null,
    };
    this.pending = token;
    return token;
  }
  accept(token: OmpDetailFetch | undefined, input: unknown, output: unknown) {
    if (!token || token.id !== this.pending?.id) return;
    this.pending = undefined;
    const envelope = readOmpEvalEnvelope(this.preview);
    if (token.revision !== (envelope?.revision ?? null)) return;
    const decoded = decodeOmpEvalDetail(output, input, true);
    if (
      decoded?.revision !== undefined &&
      (!envelope || decoded.revision >= envelope.revision) &&
      decoded.status !== "running" &&
      decoded.status !== "unknown"
    ) {
      this.detail = decoded;
      return;
    }
    if (this.terminal) {
      this.detail = decoded;
      this.failedRevision = token.revision;
    }
  }
}
