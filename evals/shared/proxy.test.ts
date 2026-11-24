// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { modelTransport, OPENROUTER_URL, proxyConfig, transportBody } from "./proxy.ts";

const proxy = { url: "http://127.0.0.1:8317/v1", headers: { Authorization: "Bearer proxy" } };

it("uses OpenRouter when OPENROUTER_API_KEY is set, else the Codex proxy", () => {
  const unread = () => {
    throw new Error("proxy config must not be read");
  };
  expect(modelTransport({ OPENROUTER_API_KEY: "or-key" }, unread)).toEqual({
    backend: "openrouter",
    url: OPENROUTER_URL,
    headers: { Authorization: "Bearer or-key" },
  });
  expect(modelTransport({}, () => proxy)).toEqual({ backend: "codex-proxy", ...proxy });
});

it("leaves proxy bodies unchanged", () => {
  const body = { model: "gpt-6.1-sol", input: [{ type: "additional_tools", tools: [] }] };
  expect(transportBody({ backend: "codex-proxy", ...proxy }, body)).toBe(body);
});

it("maps OpenRouter model ids and moves additional_tools to top-level tools", () => {
  const transport = modelTransport({ OPENROUTER_API_KEY: "or-key" });
  const exec = { type: "custom", name: "exec", description: "run", format: { type: "grammar" } };
  const functions = { type: "namespace", name: "functions", description: "", tools: [exec] };
  const evalTool = { name: "eval", description: "mock", input_schema: { type: "object" } };
  const message = { type: "message", role: "developer", content: [] };
  const body = {
    model: "gpt-6.1-sol",
    input: [
      message,
      { type: "additional_tools", role: "developer", tools: [functions] },
      {
        type: "additional_tools",
        tools: [{ name: "omp", description: "", tools: [evalTool] }],
      },
    ],
  };
  expect(transportBody(transport, body)).toEqual({
    model: "openai/gpt-6.1-sol",
    input: [message],
    tools: [
      functions,
      {
        ...functions,
        name: "omp",
        tools: [
          { type: "function", name: "eval", description: "mock", parameters: { type: "object" } },
        ],
      },
    ],
  });
  expect(transportBody(transport, { model: "claude-haiku-5-5", messages: [] })).toEqual({
    model: "anthropic/claude-haiku-5.5",
    messages: [],
  });
  expect(() => transportBody(transport, { model: "gpt-6-astra" })).toThrow(/gpt-6-astra/);
});

const config = `model_provider = "cliproxy"

[model_providers.cliproxy]
base_url = "https://proxy.example/v1"
requires_openai_auth = true
`;

describe("proxyConfig", () => {
  it.each([
    ["no auth.json", undefined],
    ["a ChatGPT-login auth.json", { OPENAI_API_KEY: null, tokens: { access_token: "t" } }],
  ])("fails when the provider requires OpenAI auth and %s has no key", (_, auth) => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-evals-proxy-"));
    using _home = {
      [Symbol.dispose]: () => {
        vi.unstubAllEnvs();
        NodeFS.rmSync(home, { recursive: true });
      },
    };
    NodeFS.writeFileSync(NodePath.join(home, "config.toml"), config);
    if (auth) NodeFS.writeFileSync(NodePath.join(home, "auth.json"), JSON.stringify(auth));
    vi.stubEnv("CODEX_HOME", home);
    expect(() => proxyConfig()).toThrow(/requires_openai_auth/);
  });
});
