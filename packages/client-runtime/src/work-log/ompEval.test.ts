import { ompEvalArtifacts } from "./ompEval.ts";
import { turnItemDetailRevision } from "./itemDetail.ts";
import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { makeOmpEvalEnvelope } from "@t3tools/shared/ompEval";
import * as DateTime from "effect/DateTime";
import { ompEvalWorkEntryLabel } from "./presentation.ts";
import { decodeOmpEval, decodeOmpEvalItem, mergeOmpEvalDetail } from "./ompEval.ts";

const output = (revision: number, status: "running" | "completed" = "running", text = "tail") => ({
  t3OmpEval: makeOmpEvalEnvelope({ revision, status, language: "py", stdoutTail: text }),
});
function item(
  revision = 1,
  status: "running" | "completed" = "running",
): Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> {
  return {
    id: TurnItemId.make("eval"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    parentItemId: null,
    nativeItemRef: { driver: ProviderDriverKind.make("omp"), nativeId: "call", strength: "strong" },
    ordinal: 0,
    status,
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    type: "dynamic_tool",
    toolName: "eval",
    input: { truncated: true, summary: "code" },
    output: output(revision, status),
    outputOmitted: true,
  };
}

describe("OMP eval presentation", () => {
  it("binds only normalized decimal native artifacts to the typed item resource", () => {
    const native = item();
    const refs = [
      { id: "42", title: "Full output" },
      { id: "../42", path: "/tmp/private", uri: "artifact://42" },
      { uri: "artifact://42?raw=1" },
      { id: "42/1" },
    ];
    const artifacts = ompEvalArtifacts(native, refs);
    expect(artifacts[0]?.resource).toEqual({
      _tag: "provider-output-artifact",
      threadId: native.threadId,
      turnItemId: native.id,
      artifactId: "42",
    });
    expect(artifacts.slice(1).every((artifact) => artifact.resource === null)).toBe(true);
    expect(
      ompEvalArtifacts({ ...native, nativeItemRef: null }, refs).every(
        (artifact) => artifact.resource === null,
      ),
    ).toBe(true);
    expect(Object.keys(artifacts[0]!.resource!)).toEqual([
      "_tag",
      "threadId",
      "turnItemId",
      "artifactId",
    ]);
    const decoded = decodeOmpEval(
      { code: "" },
      {
        ...output(1, "completed"),
        details: {
          meta: { truncation: { artifactId: "42" } },
          artifacts: [{ uri: "artifact://7" }],
        },
      },
    );
    expect(decoded?.artifacts.map((artifact) => artifact.id)).toEqual(["7", "42"]);
  });

  it("decodes guarded snapshots, language and title fallbacks without duplicating logs", () => {
    expect(decodeOmpEval({}, {})).toBeUndefined();
    expect(decodeOmpEval({}, { t3OmpEval: { origin: "omp.eval" } })).toBeUndefined();
    const view = decodeOmpEval(
      { language: "js", code: "1", title: "Supplied title" },
      {
        t3OmpEval: makeOmpEvalEnvelope({
          revision: 1,
          status: "running",
          language: "py",
          stdoutTail: "tail",
          phase: "Finishing",
          logs: ["Start", "Start"],
        }),
      },
    );
    expect(view).toMatchObject({
      title: "Supplied title",
      language: "javascript",
      phase: "Finishing",
      logs: ["Start"],
      stdout: "tail",
    });
    expect(decodeOmpEval({}, output(1))?.title).toBe("Python eval");
    expect(decodeOmpEval({ code: "" }, { ...output(1), details: { stdout: "" } })).toMatchObject({
      stdout: "",
      outputAvailable: true,
    });
    expect(decodeOmpEval({ language: "lua" }, output(1))?.language).toBe("lua");
    expect(decodeOmpEval({}, output(1, "completed", ""))).toMatchObject({
      stdout: "",
      outputAvailable: true,
    });
    expect(
      decodeOmpEval(
        {},
        { t3OmpEval: makeOmpEvalEnvelope({ revision: 1, status: "running", language: "py" }) },
      ),
    ).toMatchObject({ stdout: "", outputAvailable: false });
    expect(
      decodeOmpEval({}, { t3OmpEval: { ...output(1).t3OmpEval, status: "future" } }),
    ).toBeUndefined();
    expect(
      decodeOmpEval(
        { code: "1", language: "js" },
        { details: { stdout: "1", cells: [{ code: "1", views: [{ type: "table", rows: [1] }] }] } },
      ),
    ).toMatchObject({ language: "javascript", stdout: "1", views: [{ type: "table", rows: [1] }] });
    const titled = {
      ...item(),
      input: { truncated: true, summary: "hidden" },
      output: {
        t3OmpEval: makeOmpEvalEnvelope({
          revision: 2,
          status: "running",
          language: "py",
          title: "Supplied title",
          phase: "Finishing",
        }),
      },
    };
    expect(ompEvalWorkEntryLabel({ structuredPayload: titled })).toBe("Supplied title · Finishing");
    expect(
      ompEvalWorkEntryLabel({ structuredPayload: { ...titled, nativeItemRef: null } }),
    ).toBeUndefined();
  });

  it("hydrates changed attachments without fetching each text snapshot or losing live image markers", () => {
    const wire = item();
    const preview = (revision: number, attachmentRevision: number, imageCount: number) => ({
      t3OmpEval: makeOmpEvalEnvelope({
        revision,
        attachmentRevision,
        status: "running",
        language: "py",
        stdoutTail: "latest " + revision,
        images: Array.from({ length: imageCount }, (_, index) => ({
          index,
          mimeType: "image/png",
        })),
      }),
    });
    const first = { ...wire, output: preview(1, 0, 0) };
    const fetched = { ...first, outputOmitted: false, input: { code: "print(1)" } };
    expect(turnItemDetailRevision(first)).toBe(
      turnItemDetailRevision({ ...first, output: preview(2, 0, 0) }),
    );
    const image = { ...first, output: preview(3, 1, 1) };
    expect(turnItemDetailRevision(image)).not.toBe(turnItemDetailRevision(first));
    expect(turnItemDetailRevision(image)).toBe(
      turnItemDetailRevision({ ...image, output: preview(4, 1, 1) }),
    );
    expect(mergeOmpEvalDetail(image, undefined, fetched)?.view).toMatchObject({
      code: "print(1)",
      stdout: "latest 3",
      attachmentRevision: 1,
      images: [{ index: 0, mimeType: "image/png" }],
    });
    const replied = {
      ...fetched,
      output: { ...preview(3, 1, 0), details: { replies: ["Native reply"] } },
    };
    expect(mergeOmpEvalDetail({ ...image, output: preview(4, 1, 1) }, replied)?.view).toMatchObject(
      {
        stdout: "latest 4",
        replies: ["Native reply"],
      },
    );
    const next = { ...image, output: preview(5, 2, 2) };
    expect(turnItemDetailRevision(next)).not.toBe(turnItemDetailRevision(image));
    expect(mergeOmpEvalDetail(next, fetched)?.view.images).toHaveLength(2);
    expect(turnItemDetailRevision({ ...image, nativeItemRef: null })).toBe("live");
    const views = decodeOmpEval(
      { code: "" },
      {
        ...output(1, "completed"),
        details: {
          cells: [
            {
              views: [
                { type: "text", text: "small" },
                { type: "text", text: "x".repeat(20_000) },
              ],
            },
          ],
        },
      },
    );
    expect(views?.views).toEqual([{ type: "text", text: "small" }]);
    expect(views?.viewsOmitted).toBe(true);
  });

  it("replaces live snapshots after fetching input and refuses foreign identities", () => {
    const wire = item();
    const fetched = {
      ...wire,
      input: { code: "print(1)", language: "python" },
      outputOmitted: false,
      output: { ...output(1), details: { stdout: "old full body" } },
    };
    for (const revision of [2, 3]) {
      const next = { ...wire, output: output(revision, "running", `snapshot ${revision}`) };
      expect(turnItemDetailRevision(next)).toBe("live");
      expect(mergeOmpEvalDetail(next, fetched)?.view).toMatchObject({
        code: "print(1)",
        stdout: `snapshot ${revision}`,
        revision,
      });
    }
    expect(mergeOmpEvalDetail(wire, { ...fetched, id: TurnItemId.make("other") })?.view.code).toBe(
      "",
    );
    expect(
      mergeOmpEvalDetail(wire, {
        ...fetched,
        nativeItemRef: {
          driver: ProviderDriverKind.make("omp"),
          nativeId: "other",
          strength: "strong",
        },
      })?.view.code,
    ).toBe("");
    expect(
      decodeOmpEvalItem({
        ...wire,
        nativeItemRef: {
          driver: ProviderDriverKind.make("pi"),
          nativeId: "call",
          strength: "strong",
        },
      }),
    ).toBeUndefined();
    expect(mergeOmpEvalDetail({ ...wire, nativeItemRef: null }, fetched)).toBeUndefined();
  });

  it("keeps final tail during hydration, ignores late running bodies and settles truncated finals or historical fallback", () => {
    const wire = item(4, "completed");
    expect(turnItemDetailRevision(wire)).not.toBe("live");
    const stale = { ...item(3), input: { code: "print(1)" }, outputOmitted: false };
    expect(mergeOmpEvalDetail(wire, stale)).toMatchObject({
      hydration: "load",
      view: { status: "completed", stdout: "tail", code: "print(1)" },
    });
    const final = {
      ...wire,
      outputOmitted: false,
      output: {
        ...output(4, "completed"),
        details: {
          stdout: "final body",
          outputTruncated: true,
          artifacts: [{ id: "42", uri: "artifact://42" }],
        },
        content: [{ type: "image", mimeType: "image/png" }],
      },
      input: { code: "x".repeat(300_000), inputTruncated: true },
    };
    const merged = mergeOmpEvalDetail(wire, final);
    expect(merged?.hydration).toBe("settled");
    expect(mergeOmpEvalDetail(wire, stale, final)?.view.stdout).toBe("final body");
    expect(mergeOmpEvalDetail(wire, undefined, final)?.view.stdout).toBe("final body");
    expect(merged?.view).toMatchObject({
      stdout: "final body",
      inputTruncated: true,
      outputTruncated: true,
      images: [{ index: 0, mimeType: "image/png" }],
      artifacts: [{ id: "42", uri: "artifact://42" }],
    });
    expect(merged!.view.code.length).toBeLessThan(65536);
    expect(
      mergeOmpEvalDetail(wire, {
        ...wire,
        outputOmitted: false,
        output: "Historical truncated output",
      }),
    ).toMatchObject({
      hydration: "fallback",
      view: {
        status: "completed",
        outputTruncated: true,
        fallbackOutput: "Historical truncated output",
      },
    });
    expect(mergeOmpEvalDetail(item(), final)?.view.status).toBe("completed");
    expect(mergeOmpEvalDetail(final)?.hydration).toBe("settled");
    const cancelled = { ...wire, status: "cancelled" as const, output: output(5) };
    expect(mergeOmpEvalDetail(cancelled, stale)?.view.status).toBe("cancelled");
    const recovered = {
      ...cancelled,
      outputOmitted: false,
      input: { code: "print(1)" },
      output: { ...cancelled.output, details: { stdout: "persisted output" } },
    };
    expect(mergeOmpEvalDetail(cancelled, recovered)).toMatchObject({
      hydration: "settled",
      view: { status: "cancelled", stdout: "persisted output" },
    });
    expect(mergeOmpEvalDetail(cancelled, { ...recovered, status: "running" })).toMatchObject({
      hydration: "load",
      view: { status: "cancelled" },
    });
    expect(
      mergeOmpEvalDetail(cancelled, { ...recovered, status: "running" }, recovered)?.hydration,
    ).toBe("settled");
    expect(mergeOmpEvalDetail(cancelled, { ...recovered, output: output(4) })?.hydration).toBe(
      "load",
    );
  });
});
