export interface CatalogTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly readOnly?: boolean;
}
type RecordFrame = { type: string; [key: string]: unknown };
type Send = (record: RecordFrame) => Promise<unknown>;
type Progress = (result: unknown) => Promise<void>;
type Call = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  onProgress: Progress,
) => Promise<unknown>;
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const failure = (text: string) => ({ content: [{ type: "text", text }] });
export class OmpToolBridge {
  private tools = new Map<string, CatalogTool>();
  private generation = 0;
  private identity = "";
  private closed = false;
  private readonly pending = new Map<
    string,
    { controller: AbortController; generation: number; toolName: string }
  >();
  private readonly send: Send;
  private readonly call: Call;
  constructor(send: Send, call: Call) {
    this.send = send;
    this.call = call;
  }
  /** Pending calls to tools in `keep` survive the swap; their authority did not change. */
  async replace(
    tools: readonly CatalogTool[],
    identity: string,
    keep: ReadonlySet<string> = new Set(),
  ) {
    if (this.closed && tools.length) throw new Error("OMP tool bridge closed");
    const next = new Map<string, CatalogTool>();
    for (const tool of tools) {
      if (
        [
          "eval",
          "bash",
          "read",
          "edit",
          "write",
          "grep",
          "find",
          "browser",
          "computer",
          "todo_write",
          "todo",
          "ask",
          "lsp",
          "fetch",
          "web_search",
          "ssh",
          "notebook",
        ].includes(tool.name)
      )
        throw new Error("MCP catalog shadows a native tool boundary");
      if (!tool.name || next.has(tool.name) || !object(tool.inputSchema))
        throw new Error("Invalid or duplicate MCP catalog tool");
      next.set(tool.name, structuredClone(tool));
    }
    this.generation++;
    this.identity = identity;
    this.tools = next;
    await this.cancelPending(keep);
    await this.send({
      type: "set_host_tools",
      tools: [...next.values()].map((t) => ({
        name: t.name,
        label: t.name,
        // OMP rejects a blank description, which would fail the whole tool installation.
        description: t.description?.trim() || t.name,
        parameters: t.inputSchema,
        loadMode: "discoverable",
      })),
    });
  }
  async handle(frame: RecordFrame) {
    if (frame.type === "host_tool_cancel") {
      if (typeof frame.targetId === "string") {
        const call = this.pending.get(frame.targetId);
        this.pending.delete(frame.targetId);
        call?.controller.abort();
      }
      return;
    }
    if (frame.type !== "host_tool_call") return;
    if (typeof frame.id !== "string") throw new Error("Missing host tool correlation");
    const id = frame.id;
    if (this.pending.has(id)) throw new Error("Duplicate host tool correlation");
    if (
      this.closed ||
      !this.identity ||
      typeof frame.toolName !== "string" ||
      !this.tools.has(frame.toolName) ||
      !object(frame.arguments)
    ) {
      await this.send({
        type: "host_tool_result",
        id,
        isError: true,
        result: failure("Tool unavailable for this authorized catalog"),
      });
      return;
    }
    const owned = {
      controller: new AbortController(),
      generation: this.generation,
      toolName: frame.toolName,
    };
    this.pending.set(id, owned);
    let result: unknown;
    let isError = false;
    try {
      result = await this.call(
        frame.toolName,
        structuredClone(frame.arguments),
        owned.controller.signal,
        async (partialResult) => {
          if (
            this.pending.get(id) !== owned ||
            owned.generation !== this.generation ||
            owned.controller.signal.aborted
          )
            return;
          if (
            !object(partialResult) ||
            !Array.isArray(partialResult.content) ||
            new TextEncoder().encode(JSON.stringify(partialResult)).length > 16 * 1024 * 1024
          )
            throw new Error("Invalid MCP progress");
          await this.send({ type: "host_tool_update", id, partialResult });
        },
      );
      if (
        !object(result) ||
        !Array.isArray(result.content) ||
        new TextEncoder().encode(JSON.stringify(result)).byteLength > 16 * 1024 * 1024
      )
        throw new Error("Invalid MCP output");
      isError = result.isError === true;
    } catch {
      isError = true;
      result = failure("Authorized tool transport failed");
    }
    if (
      this.pending.get(id) !== owned ||
      owned.generation !== this.generation ||
      owned.controller.signal.aborted
    )
      return;
    this.pending.delete(id);
    await this.send({
      type: "host_tool_result",
      id,
      result,
      ...(isError ? { isError: true } : {}),
    });
  }
  async cancelPending(keep: ReadonlySet<string> = new Set()) {
    this.generation++;
    for (const [id, call] of this.pending) {
      if (keep.has(call.toolName)) {
        call.generation = this.generation;
        continue;
      }
      this.pending.delete(id);
      call.controller.abort();
      await this.send({
        type: "host_tool_result",
        id,
        isError: true,
        result: failure("Tool authorization or catalog changed"),
      });
    }
  }
  async close() {
    this.closed = true;
    await this.replace([], "");
  }
}
export interface OmpMcpEndpoint {
  readonly endpoint: string;
  readonly authorizationHeader: string;
}
export interface AuthorizedMcpTools {
  readonly tools: readonly CatalogTool[];
  /** Tools listed by T3's own endpoint, whose authority does not depend on the catalog. */
  readonly t3ToolNames: ReadonlySet<string>;
  /** T3 tools annotated read-only; catalog servers' annotations are not trusted. */
  readonly readOnlyT3ToolNames: ReadonlySet<string>;
  /** False when the catalog endpoint failed; T3's own tools are still available. */
  readonly catalogInstalled: boolean;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    onProgress?: Progress,
  ): Promise<unknown>;
}
/** T3's own tools live on `endpoint`, catalog servers and plugins on `catalogEndpoint`. */
export async function connectAuthorizedMcpTools(
  config: OmpMcpEndpoint & { readonly catalogEndpoint?: string | undefined },
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<AuthorizedMcpTools> {
  const list = async (endpoint: string) => {
    const client = new AuthorizedMcpClient(
      { endpoint, authorizationHeader: config.authorizationHeader },
      fetcher,
    );
    await client.connect(signal);
    return { client, tools: await client.listTools(signal) };
  };
  const t3 = await list(config.endpoint);
  const tools = [...t3.tools];
  const t3ToolNames = new Set(t3.tools.map((tool) => tool.name));
  const readOnlyT3ToolNames = new Set(
    t3.tools.filter((tool) => tool.readOnly).map((tool) => tool.name),
  );
  const routes = new Map(t3.tools.map((tool) => [tool.name, t3.client]));
  if (routes.size !== t3.tools.length) throw new Error("Invalid or duplicate MCP catalog tool");
  let catalogInstalled = true;
  if (config.catalogEndpoint && config.catalogEndpoint !== config.endpoint) {
    // Like the other providers, a failing catalog server costs only the catalog, not the session.
    try {
      const catalog = await list(config.catalogEndpoint);
      if (catalog.tools.some((tool) => routes.has(tool.name)))
        throw new Error("Invalid or duplicate MCP catalog tool");
      for (const tool of catalog.tools) routes.set(tool.name, catalog.client);
      tools.push(...catalog.tools);
    } catch (error) {
      if (signal.aborted) throw error;
      catalogInstalled = false;
    }
  }
  return {
    tools,
    t3ToolNames,
    readOnlyT3ToolNames,
    catalogInstalled,
    callTool: async (name, args, callSignal, onProgress) => {
      const client = routes.get(name);
      if (!client) throw new Error("Tool unavailable for this authorized catalog");
      return client.callTool(name, args, callSignal, onProgress);
    },
  };
}
/** Each client owns its negotiated HTTP session; credentials never enter native tool definitions. */
export class AuthorizedMcpClient {
  private next = 0;
  private session: string | undefined;
  private protocolVersion = "2025-06-18";
  private readonly config: OmpMcpEndpoint;
  private readonly fetcher: typeof fetch;
  constructor(config: OmpMcpEndpoint, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }
  private async post(
    method: string,
    params: unknown,
    signal: AbortSignal,
    notify = false,
    onProgress?: Progress,
  ): Promise<unknown> {
    const id = ++this.next;
    const response = await this.fetcher(this.config.endpoint, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: this.config.authorizationHeader,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": this.protocolVersion,
        ...(this.session ? { "mcp-session-id": this.session } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notify ? {} : { id }),
        method,
        params:
          onProgress && object(params)
            ? { ...params, _meta: { progressToken: `omp-progress-${id}` } }
            : params,
      }),
    });
    if (!response.ok) throw new Error("Authorized MCP transport rejected request");
    const session = response.headers.get("mcp-session-id");
    if (session) this.session = session;
    if (notify) {
      await response.body?.cancel();
      return;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing MCP response");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const sse = response.headers.get("content-type")?.includes("text/event-stream");
    const consume = async (body: string): Promise<Record<string, unknown> | undefined> => {
      const value: unknown = JSON.parse(body);
      if (!object(value) || value.jsonrpc !== "2.0") throw new Error("Invalid MCP envelope");
      if (value.id === id) {
        if (value.error || !object(value.result)) throw new Error("MCP response error");
        return value.result;
      }
      if (
        onProgress &&
        value.method === "notifications/progress" &&
        object(value.params) &&
        value.params.progressToken === `omp-progress-${id}` &&
        typeof value.params.message === "string"
      )
        await onProgress({ content: [{ type: "text", text: value.params.message }] });
    };
    let text = "";
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) {
          text += decoder.decode();
          break;
        }
        bytes += part.value.length;
        if (bytes > 16 * 1024 * 1024) throw new Error("MCP response budget exceeded");
        text += decoder.decode(part.value, { stream: true });
        if (sse) {
          for (;;) {
            const separator = /\r?\n\r?\n/.exec(text);
            if (!separator) break;
            const block = text.slice(0, separator.index);
            text = text.slice(separator.index + separator[0].length);
            const data = block
              .split(/\r?\n/)
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (data) {
              const result = await consume(data);
              if (result) return result;
            }
          }
        }
      }
      if (!sse) {
        const result = await consume(text);
        if (result) return result;
      }
      throw new Error("Uncorrelated MCP response");
    } finally {
      await reader.cancel();
    }
  }

  async connect(signal: AbortSignal) {
    const result = await this.post(
      "initialize",
      {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: "t3-omp", version: "1" },
      },
      signal,
    );
    if (
      !object(result) ||
      typeof result.protocolVersion !== "string" ||
      !["2025-06-18", "2025-03-26", "2024-11-05"].includes(result.protocolVersion)
    )
      throw new Error("Unsupported negotiated MCP protocol version");
    this.protocolVersion = result.protocolVersion;
    await this.post("notifications/initialized", {}, signal, true);
  }
  async listTools(signal: AbortSignal) {
    const tools: CatalogTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.post("tools/list", cursor ? { cursor } : {}, signal);
      if (!object(result) || !Array.isArray(result.tools)) throw new Error("Invalid MCP catalog");
      for (const tool of result.tools) {
        if (!object(tool) || typeof tool.name !== "string" || !object(tool.inputSchema))
          throw new Error("Invalid MCP tool");
        tools.push({
          name: tool.name,
          inputSchema: tool.inputSchema,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          ...(object(tool.annotations) && tool.annotations.readOnlyHint === true
            ? { readOnly: true }
            : {}),
        });
      }
      if (tools.length > 4096) throw new Error("MCP catalog budget exceeded");
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error("Repeated MCP cursor");
        cursors.add(cursor);
      }
    } while (cursor);
    return tools;
  }
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    onProgress?: Progress,
  ) {
    return this.post("tools/call", { name, arguments: args }, signal, false, onProgress);
  }
}
