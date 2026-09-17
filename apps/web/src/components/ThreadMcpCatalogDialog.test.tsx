import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import { defaultMcpCatalogProvider } from "./ThreadMcpCatalogDialog";

describe("ThreadMcpCatalogDialog", () => {
  it("defaults newly added definitions to the active provider", () => {
    expect(defaultMcpCatalogProvider(ProviderInstanceId.make("provider-instance"))).toEqual([
      ProviderInstanceId.make("provider-instance"),
    ]);
  });
});
