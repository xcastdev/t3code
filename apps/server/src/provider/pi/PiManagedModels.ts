import * as Schema from "effect/Schema";

export const piManagedModels = [
  "inclusionai/ling-3.1-flash:free",
  "inclusionai/ling-3.0-flash-sante:free",
] as const;
export const PiManagedModel = Schema.Literals(piManagedModels);
export const isPiManagedModel = Schema.is(PiManagedModel);

// Catalogue refresh selects one explicit route; existing frozen entries remain readable.
export const piManagedCatalogueModel = "inclusionai/ling-3.0-flash-sante:free";

export const PiCommandCodeManagedModel = PiManagedModel;
export const PiSubscriptionManagedModel = Schema.Literal("gpt-6-luna");
export const PiBrokerManagedModel = Schema.Union([PiManagedModel, PiSubscriptionManagedModel]);
export const isPiBrokerManagedModel = Schema.is(PiBrokerManagedModel);

export const piManagedModelRoute = (model: typeof PiManagedModel.Type) =>
  model === "inclusionai/ling-3.1-flash:free"
    ? {
        routeId: "command-code-ling-free",
        name: "Ling 3.1 Flash (free)",
        provider: "command-code" as const,
        api: "chat-completions" as const,
        endpoint: "https://api.commandcode.ai/provider/v1/chat/completions",
        reasoningEfforts: ["low", "medium", "high"] as const,
        acceptedReportedModels: [model, "inclusionai/ling-3.1-flash"],
      }
    : {
        routeId: "command-code-ling-sante-free",
        name: "Ling 3.0 Flash Sante (free)",
        provider: "command-code" as const,
        api: "chat-completions" as const,
        endpoint: "https://api.commandcode.ai/provider/v1/chat/completions",
        reasoningEfforts: ["low", "medium", "high"] as const,
        acceptedReportedModels: [model, "inclusionai/ling-3.0-flash-sante"],
      };

export const piSubscriptionModelRoute = (model: typeof PiSubscriptionManagedModel.Type) => ({
  routeId: "openai-subscription-luna",
  name: "GPT-6 Luna (OpenAI subscription)",
  provider: "openai-codex" as const,
  api: "openai-codex-responses" as const,
  endpoint: "https://chatgpt.com/backend-api/codex/responses",
  acceptedReportedModels: [model],
  reasoningEfforts: ["high"] as const,
});

export const piBrokerModelRoute = (model: typeof PiBrokerManagedModel.Type) =>
  model === "gpt-6-luna" ? piSubscriptionModelRoute(model) : piManagedModelRoute(model);
