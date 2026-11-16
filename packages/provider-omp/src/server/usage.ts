// @effect-diagnostics nodeBuiltinImport:off
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
export function readOmpUsage(entries: readonly unknown[]) {
  const main = zero(),
    auxiliary = zero();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!object(entry) || typeof entry.id !== "string" || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const source =
      entry.type === "model_usage"
        ? entry
        : entry.type === "message" && object(entry.message) && entry.message.role === "assistant"
          ? entry.message
          : undefined;
    if (!source || !object(source.usage)) continue;
    const target = entry.type === "model_usage" ? auxiliary : main;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = source.usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) target[key] += value;
    }
    const cost = source.usage.cost;
    if (
      object(cost) &&
      typeof cost.total === "number" &&
      Number.isFinite(cost.total) &&
      cost.total >= 0
    )
      target.cost += cost.total;
  }
  return { main, auxiliary };
}

import type {
  UsageRecord,
  ProviderUsageReader,
  TranscriptUsageFormat,
} from "@t3tools/provider-core/server/usage";
export interface OmpUsageRecord extends Omit<UsageRecord, "provider"> {
  readonly provider: "omp";
  readonly auxiliary: boolean;
}
interface ScanState {
  sessionId: string;
}
function transcriptRecord(value: unknown, state: ScanState): readonly OmpUsageRecord[] {
  if (!object(value)) return [];
  if (value.type === "session") {
    if (typeof value.id === "string") state.sessionId = value.id;
    return [];
  }
  const auxiliary = value.type === "model_usage";
  const source = auxiliary
    ? value
    : value.type === "message" && object(value.message) && value.message.role === "assistant"
      ? value.message
      : undefined;
  if (
    !source ||
    !object(source.usage) ||
    typeof value.id !== "string" ||
    typeof value.timestamp !== "string" ||
    typeof source.model !== "string"
  )
    return [];
  const timestampMs = Date.parse(value.timestamp);
  if (!Number.isFinite(timestampMs) || !state.sessionId) return [];
  const count = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
  const usage = source.usage;
  const cost =
    object(usage.cost) &&
    typeof usage.cost.total === "number" &&
    Number.isFinite(usage.cost.total) &&
    usage.cost.total >= 0
      ? usage.cost.total
      : null;
  return [
    {
      provider: "omp",
      auxiliary,
      timestampMs,
      sessionId: state.sessionId,
      model: source.model,
      speed: "standard",
      totals: {
        uncachedInputTokens: count(usage.input),
        cachedInputTokens: count(usage.cacheRead),
        cacheCreationTokens: count(usage.cacheWrite),
        outputTokens: count(usage.output),
        reasoningTokens: count(usage.reasoning),
      },
      reportedCostUsd: cost,
      dedupeKey: JSON.stringify([
        "omp",
        value.id,
        value.timestamp,
        source.provider ?? "",
        source.model,
        auxiliary,
      ]),
    },
  ];
}
import * as Schema from "effect/Schema";
const OmpScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
export const ompUsageFormat = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    provider: true,
    model: true,
    purpose: true,
    usage: true,
    message: { role: true, provider: true, model: true, usage: true },
  },
  usageMarkers: ['"session"', '"usage"'] as const,
  state: { initial: (): ScanState => ({ sessionId: "" }), schema: OmpScanState },
  sharedSessionsAcrossFiles: true,
  initial: (): ScanState => ({ sessionId: "" }),
  parseProjected: transcriptRecord,
  parseLine: (line: string, state: ScanState): readonly OmpUsageRecord[] => {
    try {
      return transcriptRecord(JSON.parse(line), state);
    } catch {
      return [];
    }
  },
} satisfies TranscriptUsageFormat<ScanState> & { initial: () => ScanState };

import * as NodePath from "node:path";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { parseRuntimeArgs } from "./runtimeOptions.ts";
export function resolveOmpUsageDirectory(input: {
  home: string;
  environment: NodeJS.ProcessEnv;
  launchArgs: string;
  sessionDir?: string;
  exists: (path: string) => boolean;
  platform: string;
}) {
  if (input.sessionDir) return NodePath.resolve(input.sessionDir);
  const { options } = parseRuntimeArgs(tokenizeCliArgs(input.launchArgs));
  const env = input.environment;
  const rawProfile = options.profile ?? env.OMP_PROFILE ?? env.PI_PROFILE;
  const profile = rawProfile?.trim() === "default" ? undefined : rawProfile?.trim() || undefined;
  if (profile) parseRuntimeArgs(["--profile", profile]);
  const root = NodePath.join(
    input.home,
    env.PI_CONFIG_DIR || ".omp",
    ...(profile ? ["profiles", profile] : []),
  );
  const override = options.agentDir ?? (!profile ? env.PI_CODING_AGENT_DIR : undefined);
  const expand = (path: string) =>
    path === "~"
      ? input.home
      : path.startsWith("~/")
        ? NodePath.join(input.home, path.slice(2))
        : NodePath.resolve(path);
  const agent = override ? expand(override) : NodePath.join(root, "agent");
  const xdg = env.XDG_DATA_HOME
    ? NodePath.join(env.XDG_DATA_HOME, "omp", ...(profile ? ["profiles", profile] : []))
    : undefined;
  const xdgAllowed = input.platform === "linux" || input.platform === "darwin";
  return NodePath.join(
    xdgAllowed && agent === NodePath.join(root, "agent") && xdg && input.exists(xdg) ? xdg : agent,
    "sessions",
  );
}
export function ownedOmpSessionDirectory(stateDir: string, instanceId: string) {
  return NodePath.join(stateDir, "provider-omp", encodeURIComponent(instanceId));
}

import type { OrchestrationV2ProviderTurnTokenUsage } from "@t3tools/contracts";
export function ompTokenUsage(
  state: unknown,
  stats: unknown,
  updatedAt: string,
): OrchestrationV2ProviderTurnTokenUsage | undefined {
  const context = object(state) && object(state.contextUsage) ? state.contextUsage : {};
  const count = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const usedTokens = count(context.tokens),
    maxTokens = count(context.contextWindow);
  if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0) return;
  const tokens = object(stats) && object(stats.tokens) ? stats.tokens : {};
  const inputTokens = count(tokens.input),
    cachedInputTokens = count(tokens.cacheRead),
    outputTokens = count(tokens.output);
  return {
    usedTokens,
    maxTokens,
    updatedAt,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import type { OmpSettings } from "../settings.ts";
class OmpUsageDirectoryError extends Schema.TaggedError<OmpUsageDirectoryError>()(
  "OmpUsageDirectoryError",
  { cause: Schema.Defect() },
) {}

export type OmpUsageReaderEnv = FileSystem.FileSystem | ProviderHost;
export const ompUsageReader: ProviderUsageReader<OmpSettings, OmpUsageReaderEnv> = {
  kind: "transcripts",
  provider: "omp",
  format: ompUsageFormat,
  directories: Effect.fn("ompUsageReader.directories")(function* (instance) {
    const host = yield* ProviderHost;
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const environment = instance.environment;
    const home =
      (platform === "win32" ? environment.USERPROFILE : environment.HOME) ||
      (yield* HostProcess.HomeDirectory);
    const owned = ownedOmpSessionDirectory(host.paths.stateDir, instance.instanceId);
    const native = yield* Effect.gen(function* () {
      let candidate: string | undefined;
      const options = {
        home,
        environment,
        platform,
        launchArgs: instance.config?.launchArgs ?? "",
      };
      yield* Effect.try({
        try: () =>
          resolveOmpUsageDirectory({
            ...options,
            exists: (path) => {
              candidate = path;
              return false;
            },
          }),
        catch: (cause) => new OmpUsageDirectoryError({ cause }),
      });
      const migrated = candidate
        ? yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))
        : false;
      return yield* Effect.try({
        try: () =>
          resolveOmpUsageDirectory({
            ...options,
            exists: (path) => path === candidate && migrated,
          }),
        catch: (cause) => new OmpUsageDirectoryError({ cause }),
      });
    }).pipe(Effect.orElseSucceed(() => undefined));
    return [{ dir: owned }, ...(native && native !== owned ? [{ dir: native }] : [])];
  }),
};
