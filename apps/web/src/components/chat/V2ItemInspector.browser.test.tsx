import {
  EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { V2ItemInspector } from "./V2ItemInspector";

const detail = vi.hoisted(() => ({ data: null as unknown }));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: detail.data,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: detail.data !== null,
    refresh: () => {},
  })) as never,
}));

const at = DateTime.makeUnsafe("2026-10-01T00:00:00Z");
const threadId = ThreadId.make("thread");
const edit = {
  id: TurnItemId.make("edit"),
  threadId,
  runId: RunId.make("run"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  type: "file_change" as const,
  fileName: "/repo/src/policy.ts",
  additions: 1,
  deletions: 1,
};
const projected: OrchestrationV2ProjectedTurnItem = {
  position: 0,
  visibility: "local",
  sourceThreadId: threadId,
  sourceItemId: edit.id,
  item: edit,
};

describe("V2ItemInspector", () => {
  it("shows an opened edit's diff inline once its detail arrives", async () => {
    detail.data = {
      item: {
        ...edit,
        diffStr: "@@ -1 +1 @@\n-const delay = attempt * base;\n+const delay = base * 2 ** attempt;",
      },
    };
    await using screen = await render(
      <V2ItemInspector
        projectedItem={projected}
        environmentId={EnvironmentId.make("environment")}
        onOpenThread={() => {}}
      />,
    );
    await expect.element(screen.getByText("Output")).toBeVisible();
    await expect.element(screen.getByText("const delay = base * 2 ** attempt;")).toBeVisible();
  });
});
