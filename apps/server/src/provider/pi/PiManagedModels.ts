import * as Schema from "effect/Schema";

export const piManagedModels = [
  "inclusionai/ling-3.1-flash:free",
  "inclusionai/ling-3.0-flash-sante:free",
] as const;
export const PiManagedModel = Schema.Literals(piManagedModels);

// Catalogue refresh selects one explicit route; existing frozen entries remain readable.
export const piManagedCatalogueModel = "inclusionai/ling-3.0-flash-sante:free";

export const piManagedModelRoute = (model: typeof PiManagedModel.Type) =>
  model === "inclusionai/ling-3.1-flash:free"
    ? {
        routeId: "command-code-ling-free",
        name: "Ling 3.1 Flash (free)",
        acceptedReportedModels: [model, "inclusionai/ling-3.1-flash"],
      }
    : {
        routeId: "command-code-ling-sante-free",
        name: "Ling 3.0 Flash Sante (free)",
        acceptedReportedModels: [model, "inclusionai/ling-3.0-flash-sante"],
      };
