// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { fixedOmpPolicy, normalizeOmpMode } from "./policy.ts";
import { requiredGuards } from "./compatibility.ts";
export const ownedPolicyManifest = {
  version: 1,
  recipe: "omp-18.16.0-bun-1.4.4",
  guards: requiredGuards,
  autoApprove: false,
  extensionDiscovery: false,
  settings: fixedOmpPolicy,
} as const;
export interface RuntimeConfig {
  cwd: string;
  agentDir?: string;
  mode: string;
  environment: string;
  project: string;
  providerSession: string;
  credentialPath: string;
  configFiles?: string[];
  profile?: string;
  provider?: string;
  model?: string;
  instructions?: string;
  sessionDir?: string;
  sessionFile?: string;
  forkSource?: string;
  forkEntry?: string | null;
  helper?: boolean;
}
export function parseRuntimeArgs(args: readonly string[]) {
  const options: {
    agentDir?: string;
    configFiles: string[];
    profile?: string;
    provider?: string;
    model?: string;
  } = { configFiles: [] };
  const canonical: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const eq = token.indexOf("=");
    const flag = eq < 0 ? token : token.slice(0, eq);
    if (!["--config", "--agent-dir", "--profile", "--provider", "--model"].includes(flag))
      throw new Error(`Unsupported guarded OMP argument: ${flag}`);
    const value = eq < 0 ? args[++i] : token.slice(eq + 1);
    if (!value || value.startsWith("-") || /[\u0000\r\n]/.test(value))
      throw new Error(`Invalid guarded OMP argument: ${flag}`);
    if (
      flag === "--profile" &&
      (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) ||
        value.endsWith(".") ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value))
    )
      throw new Error("Invalid OMP profile");
    canonical.push(flag, value);
    switch (flag) {
      case "--config":
        options.configFiles.push(value);
        break;
      case "--agent-dir":
        options.agentDir = value;
        break;
      case "--profile":
        options.profile = value;
        break;
      case "--provider":
        options.provider = value;
        break;
      case "--model":
        options.model = value;
        break;
    }
  }
  return { options, args: canonical };
}
export function applyRuntimeLaunchArgs<
  T extends RuntimeConfig | { agentDir: string; configFiles?: string[] },
>(config: T, args: readonly string[]) {
  const { options } = parseRuntimeArgs(args);
  return {
    ...config,
    ...options,
    configFiles: [...(config.configFiles ?? []), ...options.configFiles],
  };
}
export function validateRuntimeConfig(value: unknown): RuntimeConfig {
  if (typeof value !== "object" || value === null)
    throw new Error("Missing owned OMP runtime configuration");
  const v = value as Record<string, unknown>;
  if (!NodeUtil.isDeepStrictEqual(v.policyManifest, ownedPolicyManifest))
    throw new Error("OMP owned policy manifest mismatch");
  for (const key of ["cwd", "mode", "environment", "project", "providerSession", "credentialPath"])
    if (typeof v[key] !== "string" || !v[key] || /[\u0000\r\n]/.test(v[key]))
      throw new Error(`Invalid OMP configuration: ${key}`);
  for (const key of ["cwd", "credentialPath"])
    if (!NodePath.isAbsolute(String(v[key]))) throw new Error(`OMP ${key} must be absolute`);
  normalizeOmpMode(String(v.mode));
  for (const key of ["sessionDir", "sessionFile", "forkSource"])
    if (
      v[key] !== undefined &&
      (typeof v[key] !== "string" || !NodePath.isAbsolute(v[key]) || /[\u0000\r\n]/.test(v[key]))
    )
      throw new Error(`Invalid owned OMP path: ${key}`);
  if (
    v.forkEntry !== undefined &&
    v.forkEntry !== null &&
    (typeof v.forkEntry !== "string" || !v.forkEntry || /[\u0000\r\n]/.test(v.forkEntry))
  )
    throw new Error("Invalid owned branch entry");
  if (v.sessionFile !== undefined && v.forkSource !== undefined)
    throw new Error("Ambiguous owned native session");
  if (v.helper !== undefined && typeof v.helper !== "boolean")
    throw new Error("Invalid helper policy");
  if (
    v.helper === true &&
    (v.sessionFile !== undefined || v.sessionDir !== undefined || v.forkSource !== undefined)
  )
    throw new Error("Helper sessions cannot retain history");

  for (const key of ["agentDir", "profile", "provider", "model", "instructions"])
    if (v[key] !== undefined && (typeof v[key] !== "string" || String(v[key]).includes("\0")))
      throw new Error(`Invalid OMP configuration: ${key}`);
  if (
    v.configFiles !== undefined &&
    (!Array.isArray(v.configFiles) ||
      !v.configFiles.every((x) => typeof x === "string" && x.length > 0 && !x.includes("\0")))
  )
    throw new Error("Invalid OMP config files");
  if (v.profile !== undefined) parseRuntimeArgs(["--profile", String(v.profile)]);
  return value as RuntimeConfig;
}
