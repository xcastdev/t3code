export interface OmpEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly [key: string]: unknown;
}
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export class OmpHistory {
  private entries = new Map<string, OmpEntry>();
  private leaf: string | null = null;
  private cursor: string | undefined;
  apply(value: unknown, reset = false) {
    if (
      !object(value) ||
      !Array.isArray(value.entries) ||
      (value.leafId !== null && typeof value.leafId !== "string")
    )
      throw new Error("Invalid native history page");
    const next = reset ? new Map<string, OmpEntry>() : new Map(this.entries);
    for (const entry of value.entries) {
      if (
        !object(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.type !== "string" ||
        (entry.parentId !== null && typeof entry.parentId !== "string")
      )
        throw new Error("Invalid native entry");
      const owned = structuredClone({
        ...entry,
        id: entry.id,
        parentId: entry.parentId,
        type: entry.type,
      });
      const old = next.get(entry.id);
      if (old && JSON.stringify(old) !== JSON.stringify(owned))
        throw new Error("Native append identity was replaced");
      next.set(entry.id, owned);
    }
    this.path(next, value.leafId);
    this.entries = next;
    this.leaf = value.leafId;
    const last = value.entries.at(-1);
    if (object(last) && typeof last.id === "string") this.cursor = last.id;
    else if (reset) this.cursor = undefined;
  }
  private path(entries: Map<string, OmpEntry>, leaf: string | null) {
    const branch: OmpEntry[] = [];
    const seen = new Set<string>();
    while (leaf !== null) {
      if (seen.has(leaf)) throw new Error("Native history cycle");
      seen.add(leaf);
      const entry = entries.get(leaf);
      if (!entry) throw new Error("Native history missing parent");
      branch.push(entry);
      leaf = entry.parentId;
    }
    return branch.reverse();
  }
  branch() {
    return this.path(this.entries, this.leaf);
  }
  get leafId() {
    return this.leaf;
  }
  async refresh(request: (r: { type: string; since?: string }) => Promise<unknown>) {
    if (this.cursor) {
      try {
        this.apply(await request({ type: "get_entries", since: this.cursor }));
        return;
      } catch {
        /* Branch resets and unknown_since require an authoritative full page. */
      }
    }
    this.apply(await request({ type: "get_entries" }), true);
  }
}
export async function readOmpMessages(
  request: (r: { type: string; cursor?: string; limit: number }) => Promise<unknown>,
) {
  const messages: unknown[] = [];
  let resynced = false;
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    let result: unknown;
    try {
      result = await request({
        type: "get_messages_page",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      if (resynced || !cursor) throw error;
      resynced = true;
      messages.length = 0;
      cursors.clear();
      cursor = undefined;
      continue;
    }
    if (!object(result) || !Array.isArray(result.messages))
      throw new Error("Invalid native messages page");
    messages.push(...result.messages);
    if (messages.length > 100000) throw new Error("Native message budget exceeded");
    cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error("Native message cursor repeated");
      cursors.add(cursor);
    }
    if (!cursor) break;
  }
  return messages;
}

export function nativeMessageBaseKey(value: unknown): string | undefined {
  if (
    !object(value) ||
    !["user", "assistant", "developer"].includes(String(value.role)) ||
    !(
      (typeof value.timestamp === "number" && Number.isFinite(value.timestamp)) ||
      (typeof value.timestamp === "string" && value.timestamp)
    )
  )
    return;
  return JSON.stringify([value.role, value.timestamp, value.provider ?? "", value.model ?? ""]);
}
export function historyMessages(entries: readonly OmpEntry[]) {
  const counts = new Map<string, number>();
  return entries.flatMap((entry) => {
    const message = entry.message;
    if (
      entry.type !== "message" ||
      !object(message) ||
      !["user", "assistant", "developer"].includes(String(message.role))
    )
      return [];
    const base = nativeMessageBaseKey(message) ?? entry.id;
    const index = counts.get(base) ?? 0;
    counts.set(base, index + 1);
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .flatMap((block) =>
                object(block) && block.type === "text" && typeof block.text === "string"
                  ? [block.text]
                  : [],
              )
              .join("\n")
          : "";
    const timestamp =
      typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? message.timestamp
        : typeof entry.timestamp === "string"
          ? Date.parse(entry.timestamp)
          : 0;
    return [
      {
        key: `${base}:${index}`,
        baseKey: base,
        entryId: entry.id,
        role:
          message.role === "assistant"
            ? ("assistant" as const)
            : message.role === "user"
              ? ("user" as const)
              : ("system" as const),
        text,
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        message,
      },
    ];
  });
}
