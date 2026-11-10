import { page } from "vite-plus/test/browser";
import { Atom, AsyncResult } from "effect/reactivity";
import type { OrchestrationV2GetTurnItemResult } from "@t3tools/contracts";
import type { TurnItemSource } from "./timelineRowContext";
import { makeOmpEvalEnvelope } from "@t3tools/shared/ompEval";
import {
  EnvironmentId,
  ProviderDriverKind,
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

vi.mock(import("../files/ReadOnlySourcePreview"), () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

const detail = vi.hoisted(() => ({ data: null as unknown }));
const artifactAsset = vi.hoisted(() => ({
  resource: null as unknown,
  requests: [] as unknown[],
  images: [] as unknown[],
  refresh: () => {
    artifactAsset.requests.push(artifactAsset.resource);
    return Promise.resolve("https://environment.example.test/api/assets/signed-output");
  },
}));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: (environmentId: unknown, resource: unknown, revision: unknown) => {
    artifactAsset.images.push({ environmentId, resource, revision });
    return {
      _tag: "Success" as const,
      expiresAt: 0,
      imageDimensions: { width: 1, height: 1 },
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGfQAAAAASUVORK5CYII=",
    };
  },
  useAssetUrlRefresh: (_environmentId: unknown, resource: unknown) => {
    artifactAsset.resource = resource;
    return artifactAsset.refresh;
  },
}));
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
  it("shows live images arriving after the first fetch without requesting detail for text deltas", async () => {
    artifactAsset.images = [];
    const keys = new Set<string>();
    const details = Atom.family((revision: string) => {
      keys.add(revision);
      return Atom.make(AsyncResult.initial<OrchestrationV2GetTurnItemResult, unknown>());
    });
    const source: TurnItemSource = {
      detail: ({ revision }) => details(revision),
      commandOutput: () => Atom.make(AsyncResult.initial<never, unknown>()),
    };
    const output = (revision: number, attachmentRevision: number, count: number) => ({
      t3OmpEval: makeOmpEvalEnvelope({
        revision,
        attachmentRevision,
        language: "text",
        status: "running",
        stdoutTail: "snapshot " + revision,
        images: Array.from({ length: count }, (_, index) => ({ index, mimeType: "image/png" })),
      }),
    });
    const evalItem = {
      ...edit,
      type: "dynamic_tool" as const,
      toolName: "eval",
      status: "running" as const,
      nativeItemRef: {
        driver: ProviderDriverKind.make("omp"),
        nativeId: "images-call",
        strength: "strong" as const,
      },
      input: { language: "text", code: "" },
      outputOmitted: true,
      output: output(1, 0, 0),
    };
    detail.data = { item: { ...evalItem, outputOmitted: false } };
    const inspector = (revision: number, attachments: number, count: number) => (
      <V2ItemInspector
        projectedItem={{
          ...projected,
          item: { ...evalItem, output: output(revision, attachments, count) },
        }}
        environmentId={EnvironmentId.make("environment")}
        source={source}
      />
    );
    await using screen = await render(inspector(1, 0, 0));
    await screen.rerender(inspector(2, 0, 0));
    expect([...keys]).toEqual(["live"]);
    detail.data = null;
    await screen.rerender(inspector(3, 1, 1));
    await expect.element(screen.getByAltText("Eval output image")).toBeVisible();
    expect([...keys]).toEqual(["live", "live:attachments:1"]);
    await screen.rerender(inspector(4, 1, 1));
    expect([...keys]).toEqual(["live", "live:attachments:1"]);
    await screen.rerender(inspector(5, 2, 2));
    await vi.waitFor(() =>
      expect(screen.getByAltText("Eval output image").elements()).toHaveLength(2),
    );
    expect([...keys]).toEqual(["live", "live:attachments:1", "live:attachments:2"]);
    expect(artifactAsset.images).toContainEqual({
      environmentId: EnvironmentId.make("environment"),
      resource: { _tag: "tool-output-image", threadId, itemId: edit.id, index: 0 },
      revision: "2",
    });
  });

  it("opens native full output through the authenticated typed artifact resource", async () => {
    artifactAsset.requests = [];
    artifactAsset.resource = null;
    const evalItem = {
      ...edit,
      type: "dynamic_tool" as const,
      toolName: "eval",
      nativeItemRef: {
        driver: ProviderDriverKind.make("omp"),
        nativeId: "artifact-call",
        strength: "strong" as const,
      },
      input: { language: "text", code: "" },
      outputOmitted: true,
      output: {
        t3OmpEval: makeOmpEvalEnvelope({
          revision: 1,
          status: "completed",
          language: "text",
          stdoutTail: "preview",
        }),
        details: {
          meta: { truncation: { artifactId: "42" } },
          artifacts: [{ id: "../42", title: "Unsupported output" }],
        },
      },
    };
    detail.data = { item: { ...evalItem, outputOmitted: false } };
    await using screen = await render(
      <V2ItemInspector
        projectedItem={{ ...projected, item: evalItem }}
        environmentId={EnvironmentId.make("environment")}
      />,
    );
    using fetchOutput = vi
      .spyOn(window, "fetch")
      .mockResolvedValue(new Response("Complete native spilled output", { status: 200 }));
    await screen.getByRole("button", { name: "Open Full output" }).click();
    await expect.element(page.getByText("Complete native spilled output")).toBeVisible();
    expect(artifactAsset.requests).toContainEqual({
      _tag: "provider-output-artifact",
      threadId,
      turnItemId: edit.id,
      artifactId: "42",
    });
    expect(fetchOutput).toHaveBeenCalledWith(
      "https://environment.example.test/api/assets/signed-output",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("replaces eval snapshots through detail races while preserving manual output scroll", async () => {
    const evalItem = {
      ...edit,
      type: "dynamic_tool" as const,
      nativeItemRef: {
        driver: ProviderDriverKind.make("omp"),
        nativeId: "eval-call",
        strength: "strong" as const,
      },
      toolName: "eval",
      status: "running" as const,
      input: { code: "", language: "text", title: "Compute result" },
      outputOmitted: true,
      output: {
        t3OmpEval: makeOmpEvalEnvelope({
          revision: 1,
          status: "running",
          language: "text",
          stdoutTail: "first snapshot",
        }),
      },
    };
    const project = (
      item: typeof evalItem | (Omit<typeof evalItem, "status"> & { status: "completed" }),
    ): OrchestrationV2ProjectedTurnItem => ({ ...projected, item });
    detail.data = {
      item: {
        ...evalItem,
        outputOmitted: false,
        output: {
          ...evalItem.output,
          details: { stdout: "first fetched body" },
        },
      },
    };
    await using screen = await render(
      <V2ItemInspector
        projectedItem={project(evalItem)}
        environmentId={EnvironmentId.make("environment")}
      />,
    );
    await expect.element(screen.getByText("first fetched body")).toBeVisible();
    const snapshot = (revision: number, status: "running" | "completed") => ({
      t3OmpEval: makeOmpEvalEnvelope({
        revision,
        status,
        language: "text",
        stdoutTail: ("line " + revision + "\n").repeat(100),
      }),
    });
    await screen.rerender(
      <V2ItemInspector
        projectedItem={project({ ...evalItem, output: snapshot(2, "running") })}
        environmentId={EnvironmentId.make("environment")}
      />,
    );
    await expect.element(screen.getByText("first fetched body")).not.toBeInTheDocument();
    const viewport = screen.getByRole("region", { name: "Program output" }).element();
    await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    await screen.rerender(
      <V2ItemInspector
        projectedItem={project({ ...evalItem, output: snapshot(3, "running") })}
        environmentId={EnvironmentId.make("environment")}
      />,
    );
    expect(viewport.scrollTop).toBe(0);
    await expect
      .element(screen.getByRole("region", { name: "Program output" }))
      .toHaveTextContent("line 3\n".repeat(100), { normalizeWhitespace: false });
    // The pending live request finishes after the wire becomes terminal.
    const final = { ...evalItem, status: "completed" as const, output: snapshot(4, "completed") };
    await screen.rerender(
      <V2ItemInspector
        projectedItem={project(final)}
        environmentId={EnvironmentId.make("environment")}
      />,
    );
    await expect
      .element(screen.getByRole("region", { name: "Program output" }))
      .toHaveTextContent("line 4\n".repeat(100), { normalizeWhitespace: false });
    detail.data = {
      item: {
        ...final,
        outputOmitted: false,
        output: { ...final.output, details: { stdout: "complete recovered output" } },
      },
    };
    await screen.rerender(
      <V2ItemInspector
        projectedItem={project(final)}
        environmentId={EnvironmentId.make("environment")}
      />,
    );
    await expect.element(screen.getByText("complete recovered output")).toBeVisible();
  });

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
      />,
    );
    await expect.element(screen.getByText("Output")).toBeVisible();
    await expect.element(screen.getByText("const delay = base * 2 ** attempt;")).toBeVisible();
  });
});
