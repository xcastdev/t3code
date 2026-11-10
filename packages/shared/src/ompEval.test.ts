import { expect, it } from "@effect/vitest";
import {
  makeOmpEvalEnvelope,
  readOmpEvalEnvelope,
  mergeOmpEvalPreview,
  ompEvalHydration,
} from "./ompEval.ts";
import { compactDynamicToolOutput } from "./toolOutput.ts";
it("bounds escaped Unicode JSON bytes, reads root before large native content, rejects corrupt origins", () => {
  const envelope = makeOmpEvalEnvelope({
    revision: 4,
    title: '"\\😀'.repeat(160),
    language: "python",
    status: "running",
    stdoutTail: '😀"\\'.repeat(4000),
    phase: "step".repeat(100),
    logs: Array(8).fill('\n"'.repeat(200)),
  });
  expect(new TextEncoder().encode(JSON.stringify(envelope)).length).toBeLessThanOrEqual(4096);
  const root = { t3OmpEval: envelope, content: [{ type: "text", text: "x".repeat(300000) }] };
  expect(compactDynamicToolOutput(root)?.t3OmpEval).toEqual(envelope);
  expect(readOmpEvalEnvelope({ t3OmpEval: { ...envelope, origin: "other" } })).toBeUndefined();
  expect(readOmpEvalEnvelope({ t3OmpEval: { ...envelope, revision: -1 } })).toBeUndefined();
  expect(
    readOmpEvalEnvelope({
      t3OmpEval: { ...envelope, images: [{ index: 0, mimeType: "image/png", data: "YQ==" }] },
    }),
  ).toBeUndefined();
});
it("keeps newest revision and settles truncated final or historical fallback without refetch loops", () => {
  const running = {
    t3OmpEval: makeOmpEvalEnvelope({ revision: 2, status: "running", language: "javascript" }),
  };
  const done = {
    t3OmpEval: makeOmpEvalEnvelope({
      revision: 3,
      status: "completed",
      language: "javascript",
      outputTruncated: true,
    }),
  };
  expect(mergeOmpEvalPreview(done, running)).toEqual(done);
  expect(ompEvalHydration(done, done, true)).toBe("settled");
  expect(ompEvalHydration(done, running, true)).toBe("load");
  expect(ompEvalHydration({}, "historical truncated output", true)).toBe("fallback");
});

it("hydrates bounded final native detail after terminal wire and ignores an older running fetch without another loop", async () => {
  const { OmpEvalDetailState, decodeOmpEvalDetail } = await import("./ompEval.ts");
  const running = {
    t3OmpEval: makeOmpEvalEnvelope({ revision: 1, status: "running", language: "py" }),
  };
  const final = {
    t3OmpEval: makeOmpEvalEnvelope({
      revision: 2,
      status: "completed",
      language: "py",
      outputTruncated: true,
    }),
    content: [
      { type: "text", text: "final" },
      { type: "image", mimeType: "image/png" },
    ],
    details: {
      cells: [
        {
          language: "python",
          code: "x".repeat(300000),
          output: "y".repeat(300000),
          status: "complete",
        },
      ],
      artifacts: [{ uri: "artifact://12" }],
      outputTruncated: true,
    },
  };
  const hydration = new OmpEvalDetailState();
  hydration.updateWire(running, false);
  const old = hydration.begin();
  hydration.updateWire(final, true);
  expect(hydration.status).toBe("load");
  hydration.accept(old, { code: "old" }, running);
  expect(hydration.status).toBe("load");
  const latest = hydration.begin();
  hydration.accept(
    latest,
    { language: "py", code: "z".repeat(300000), inputTruncated: true },
    final,
  );
  expect(hydration.status).toBe("settled");
  expect(hydration.detail).toMatchObject({
    revision: 2,
    status: "completed",
    images: [{ index: 0, mimeType: "image/png" }],
    artifacts: [{ uri: "artifact://12" }],
    inputTruncated: true,
    outputTruncated: true,
  });
  hydration.accept(old, {}, running);
  expect(hydration.detail?.revision).toBe(2);
  expect(hydration.begin()).toBeUndefined();
  expect(
    decodeOmpEvalDetail(
      {
        content: [{ type: "text", text: "historical" }],
        details: { cells: [{ code: "1", output: "historical", status: "complete" }] },
      },
      { language: "py", code: "1" },
      true,
    ),
  ).toMatchObject({ status: "completed", stdout: "historical" });
  for (const [input, title] of [
    [{ language: "py", title: "Requested" }, "Requested"],
    [{ language: "py" }, "Native cell title"],
    [{ language: "js", title: " " }, "Native cell title"],
  ] as const) {
    expect(
      decodeOmpEvalDetail(
        {
          details: {
            cells: [{ title: "Native cell title", language: "python", status: "complete" }],
          },
        },
        input,
        true,
      )?.title,
    ).toBe(title);
  }
  expect(decodeOmpEvalDetail({ details: { cells: [] } }, { language: "py" }, true)?.title).toBe(
    "Python eval",
  );
  expect(decodeOmpEvalDetail({ details: { cells: [] } }, { language: "js" }, true)?.title).toBe(
    "JavaScript eval",
  );
  const view = decodeOmpEvalDetail(
    {
      details: {
        cells: [
          {
            views: [
              { type: "text", text: "tiny" },
              { type: "text", text: "x".repeat(20000) },
            ],
          },
        ],
      },
    },
    {},
    true,
  );
  expect(view).toMatchObject({
    cells: [{ views: [{ type: "text", text: "tiny" }], viewsOmitted: true }],
    viewsOmitted: true,
    outputTruncated: true,
  });
  const legacy = new OmpEvalDetailState();
  legacy.updateWire({}, true);
  legacy.accept(legacy.begin(), {}, "truncated legacy");
  expect(legacy.status).toBe("fallback");
  expect(legacy.begin()).toBeUndefined();
});
it("normalizes actual numeric native artifact references and preserves bounded descriptions without paths", async () => {
  const { decodeOmpEvalDetail } = await import("./ompEval.ts");
  const result = decodeOmpEvalDetail(
    {
      details: {
        meta: { truncation: { artifactId: "0" } },
        artifacts: [
          { uri: "artifact://12", title: "Full result", path: "/private/never-expose" },
          { id: "../secret", uri: "file:///private/secret" },
          { id: "3", uri: "artifact://4" },
          { id: "bad", uri: "artifact://5:raw:1-9" },
        ],
      },
    },
    {},
    true,
  );
  expect(result?.artifacts).toEqual([
    { id: "12", uri: "artifact://12", title: "Full result" },
    { id: "0", uri: "artifact://0" },
  ]);
});

it("keeps bounded native replies separate from program output", async () => {
  const { decodeOmpEvalDetail } = await import("./ompEval.ts");
  const output = {
    content: [{ type: "text", text: "program output" }],
    details: { replies: ["First reply", "First reply", 42, "Second reply"] },
  };
  expect(decodeOmpEvalDetail(output, {}, true)).toMatchObject({
    stdout: "program output",
    replies: ["First reply", "First reply", "Second reply"],
    repliesOmitted: false,
  });
  const bounded = decodeOmpEvalDetail(
    { details: { replies: ['😀"\\'.repeat(20_000), ...Array(20).fill("next reply")] } },
    {},
    true,
  );
  expect(bounded).toMatchObject({ repliesOmitted: true, outputTruncated: true });
  expect(new TextEncoder().encode(JSON.stringify(bounded?.replies)).length).toBeLessThanOrEqual(
    32_768,
  );
  expect(bounded?.replies.length).toBeLessThanOrEqual(16);
});
