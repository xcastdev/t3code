import { WEB_SEARCH_MODEL_DRIVERS } from "@t3tools/contracts";

import {
  type DelegatedModelToolConfig,
  DelegatedModelToolSection,
} from "./DelegatedModelToolSection";

const WEB_SEARCH_TOOL_CONFIG: DelegatedModelToolConfig = {
  sectionId: "web-search",
  title: "Web search",
  enabledKey: "webSearchToolEnabled",
  modelKey: "webSearchModelSelection",
  drivers: WEB_SEARCH_MODEL_DRIVERS,
  unsupportedDriverReason: "Only Claude and Codex models can search the web.",
  toggleSearchId: "web-search-tool",
  toggleLabel: "Web search tool",
  toggleDescription:
    "Let agents other than Claude, Codex, Cursor and Grok, which have their own web search, ask a Claude or Codex model to search the web. Each search is a request to that model. New agent sessions get it.",
  modelSearchId: "search-model",
  modelLabel: "Search model",
  modelDescription:
    "The model that runs the search. Claude and Codex models only. Agents don't get the tool until you choose one.",
  noProviderMessage: "Add a Claude or Codex provider to choose a search model.",
  noEnvironmentMessage: "Connect an environment to choose its search model.",
  patchEnabled: (enabled) => ({ webSearchToolEnabled: enabled }),
  patchModel: (selection) => ({ webSearchModelSelection: selection }),
};

export function WebSearchToolSection() {
  return <DelegatedModelToolSection config={WEB_SEARCH_TOOL_CONFIG} />;
}
