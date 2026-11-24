// Eval-only API transport selection and Codex proxy configuration.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";

// Read credentials into memory only. Python's TOML parser avoids another runner dependency.
const decodeProxyConfig = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ error: Schema.String }),
    Schema.Struct({ url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
  ]),
);
/**
 * Reads the CLIProxyAPI provider from `$CODEX_HOME/config.toml` (default `~/.codex`): the one
 * `T3CODE_EVAL_MODEL_PROVIDER` names, else `model_provider` when it is custom, else `vibeproxy`.
 */
export const proxyConfig = () => {
  const config = decodeProxyConfig(
    JSON.parse(
      NodeChildProcess.execFileSync(
        "python3",
        [
          "-c",
          `
import json, os, pathlib, sys, tomllib
home = pathlib.Path(os.environ.get('CODEX_HOME') or pathlib.Path.home() / '.codex')
def fail(message):
  print(json.dumps({'error': message + ' The GPT evals call models through a CLIProxyAPI server set up as a custom model provider in Codex: set model_provider = "<name>" and add [model_providers.<name>] with base_url and its key.'}))
  sys.exit()
path = home / 'config.toml'
if not path.is_file(): fail(f'No Codex config at {path}.')
config = tomllib.loads(path.read_text())
providers = config.get('model_providers', {})
override = os.environ.get('T3CODE_EVAL_MODEL_PROVIDER')
name = override or (config.get('model_provider') if config.get('model_provider') in providers else 'vibeproxy')
if override and name not in providers: fail(f'T3CODE_EVAL_MODEL_PROVIDER names {name!r}, but {path} has no [model_providers.{name}].')
if name not in providers: fail(f'{path} has no custom model provider to use (model_provider is {config.get("model_provider", "unset")!r}).')
p = providers[name]
if not p.get('base_url'): fail(f'[model_providers.{name}] in {path} has no base_url.')
h = p.get('http_headers', {}).copy()
h.update({k: os.environ[v] for k,v in p.get('env_http_headers', {}).items()})
key = os.environ.get(p['env_key']) if p.get('env_key') else p.get('experimental_bearer_token')
if p.get('env_key') and not key: fail(f'[model_providers.{name}] in {path} reads its key from {p["env_key"]}, which is not set.')
if not key and p.get('requires_openai_auth') and (home / 'auth.json').is_file(): key = json.loads((home / 'auth.json').read_text()).get('OPENAI_API_KEY')
if not key and p.get('requires_openai_auth'): fail(f'[model_providers.{name}] in {path} sets requires_openai_auth, but {home / "auth.json"} has no OPENAI_API_KEY.')
if key: h['Authorization'] = 'Bearer ' + key
print(json.dumps({'url': p['base_url'].rstrip('/'), 'headers': h}))
`,
        ],
        { encoding: "utf8" },
      ),
    ),
  );
  if ("error" in config) throw new Error(config.error);
  return config;
};

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";
// OpenRouter catalog ids for the eval's model ids. Only ids checked against its catalog.
const OPENROUTER_MODELS: Readonly<Record<string, string>> = {
  "gpt-6.1-sol": "openai/gpt-6.1-sol",
  "claude-haiku-5-5": "anthropic/claude-haiku-5.5",
};

export type ModelTransport = {
  readonly backend: "openrouter" | "codex-proxy";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
};

/** OpenRouter when `OPENROUTER_API_KEY` is set, else the configured Codex proxy provider. */
export const modelTransport = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  readProxy: () => Omit<ModelTransport, "backend"> = proxyConfig,
): ModelTransport =>
  env.OPENROUTER_API_KEY
    ? {
        backend: "openrouter",
        url: OPENROUTER_URL,
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
      }
    : { backend: "codex-proxy", ...readProxy() };

export const openRouterModel = (model: string) => {
  const id = OPENROUTER_MODELS[model];
  if (!id) throw new Error(`No OpenRouter model id for ${model}.`);
  return id;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The OMP simulation's eval tool is Anthropic-shaped; a namespace member needs a function type.
const namespaceMember = (tool: unknown) =>
  isRecord(tool) && tool.type === undefined && "input_schema" in tool
    ? {
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      }
    : tool;

/**
 * The wire body for a transport. OpenRouter takes its own model ids, and Codex's
 * `additional_tools` input items become top-level tools, in order, without changing their text.
 */
export const transportBody = <B extends Record<string, unknown>>(
  transport: Pick<ModelTransport, "backend">,
  body: B,
): B => {
  if (transport.backend !== "openrouter") return body;
  const model = openRouterModel(String(body.model));
  if (!Array.isArray(body.input)) return { ...body, model };
  const isExtra = (item: unknown) => isRecord(item) && item.type === "additional_tools";
  const extra = body.input
    .filter(isExtra)
    .flatMap((item: Record<string, unknown>) => (Array.isArray(item.tools) ? item.tools : []))
    .map((tool: unknown) =>
      isRecord(tool) && Array.isArray(tool.tools)
        ? { ...tool, type: tool.type ?? "namespace", tools: tool.tools.map(namespaceMember) }
        : tool,
    );
  return {
    ...body,
    model,
    input: body.input.filter((item: unknown) => !isExtra(item)),
    tools: [...(Array.isArray(body.tools) ? body.tools : []), ...extra],
  };
};
