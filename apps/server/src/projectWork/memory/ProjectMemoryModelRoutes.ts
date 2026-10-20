/** Fixed memory transports; endpoint selection never enables fallback or discovery. */
export const COMMAND_CODE_EXTRACTION = {
  endpoint: "https://api.commandcode.ai/provider/v1/chat/completions",
  provider: "command-code",
  model: "inclusionai/ling-3.1-flash:free",
} as const;
export const LIQUID_EXTRACTION = {
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  provider: "openrouter",
  model: "liquid/lfm-2.5-2.6b:free",
} as const;
export const MEMORY_EMBEDDING = {
  endpoint: "https://openrouter.ai/api/v1/embeddings",
  provider: "openrouter",
  model: "nvidia/nemotron-3-embed-1b:free",
} as const;
export type ProjectMemoryExtractionEndpoint =
  | typeof COMMAND_CODE_EXTRACTION.endpoint
  | typeof LIQUID_EXTRACTION.endpoint;
export type ProjectMemoryExtractionModel =
  | typeof COMMAND_CODE_EXTRACTION.model
  | typeof LIQUID_EXTRACTION.model;
export const projectMemoryExtractionRoute = (endpoint: string) =>
  endpoint === COMMAND_CODE_EXTRACTION.endpoint
    ? COMMAND_CODE_EXTRACTION
    : endpoint === LIQUID_EXTRACTION.endpoint
      ? LIQUID_EXTRACTION
      : undefined;
export const isProjectMemoryReservedRoute = (phase: string, provider: string, model: string) =>
  phase === "extract"
    ? (provider === COMMAND_CODE_EXTRACTION.provider && model === COMMAND_CODE_EXTRACTION.model) ||
      (provider === LIQUID_EXTRACTION.provider && model === LIQUID_EXTRACTION.model)
    : (phase === "embed" || phase === "query-embed") &&
      provider === MEMORY_EMBEDDING.provider &&
      model === MEMORY_EMBEDDING.model;
/** Fixed response aliases, including the verified OpenRouter NVIDIA catalog canonical slug. */
export const sameProjectMemoryReportedModel = (reported: string | undefined, requested: string) =>
  (requested === LIQUID_EXTRACTION.model && reported === requested) ||
  (requested === COMMAND_CODE_EXTRACTION.model &&
    (reported === requested || reported === "inclusionai/ling-3.1-flash")) ||
  (requested === MEMORY_EMBEDDING.model &&
    (reported === requested ||
      reported === "nvidia/nemotron-3-embed-1b" ||
      reported === "nvidia/nemotron-3-embed-1b-20260716"));

export const withinProjectMemoryExtractionLimits = (
  endpoint: string,
  input: number,
  output: number,
) => endpoint !== LIQUID_EXTRACTION.endpoint || (output <= 8192 && input + output <= 65536);
