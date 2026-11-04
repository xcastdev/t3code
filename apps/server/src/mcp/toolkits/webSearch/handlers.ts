import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../McpToolAccess.ts";
import * as WebSearchMcpService from "../../WebSearchMcpService.ts";
import { WebSearchToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(WebSearchToolkit, {
  t3_web_search: McpToolAccess.readsAsCaller((input) =>
    WebSearchMcpService.WebSearchMcpService.pipe(
      Effect.flatMap((service) =>
        service.search({ query: input.query, instructions: input.instructions }),
      ),
    ),
  ),
});
