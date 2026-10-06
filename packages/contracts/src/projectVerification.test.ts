import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ProjectVerificationCommandSelection,
  ProjectVerificationJobManifest,
} from "./projectVerification.ts";

const decode = Schema.decodeUnknownSync(ProjectVerificationCommandSelection);
const selection = {
  executable: "/opt/project tools/test runner",
  argv: ["", "  preserved  ", "--filter", "$(literal); *", "line\nbreak"],
  limits: { maxDurationMs: 120_000, maxOutputBytes: 65_536 },
  environment: "clean",
};

describe("verification command selection", () => {
  it("preserves exact process arguments without shell parsing or trimming", () => {
    expect(decode(selection)).toEqual(selection);
    expect(decode({ ...selection, executable: "C:\\Program Files\\Tests\\runner.exe" })).toEqual({
      ...selection,
      executable: "C:\\Program Files\\Tests\\runner.exe",
    });
    expect(decode({ ...selection, argv: [] }).argv).toEqual([]);
  });

  it.each(["runner", " ./runner", "", "/runner\0", "/runner\n"])(
    "rejects executable paths that cannot identify an explicit host executable: %j",
    (executable) => expect(() => decode({ ...selection, executable })).toThrow(),
  );

  it("rejects NUL arguments and bounds count, individual size and encoded size", () => {
    for (const argv of [
      ["bad\0argument"],
      Array(65).fill("x"),
      ["x".repeat(4_097)],
      Array(8).fill("界".repeat(1_024)),
    ]) {
      expect(() => decode({ ...selection, argv })).toThrow();
    }
    expect(decode({ ...selection, argv: ["x".repeat(4_096)] }).argv[0]).toHaveLength(4_096);
  });

  it.each([
    { maxDurationMs: 0, maxOutputBytes: 1 },
    { maxDurationMs: 3_600_001, maxOutputBytes: 1 },
    { maxDurationMs: 1.5, maxOutputBytes: 1 },
    { maxDurationMs: 1, maxOutputBytes: 0 },
    { maxDurationMs: 1, maxOutputBytes: 1_048_577 },
  ])("rejects invalid execution limits: %j", (limits) => {
    expect(() => decode({ ...selection, limits })).toThrow();
  });

  it("requires a clean environment rather than inheriting host credentials", () => {
    for (const environment of [undefined, "inherit", { TOKEN: "secret" }]) {
      expect(() => decode({ ...selection, environment })).toThrow();
    }
  });
});

const manifest = {
  version: 1,
  jobId: "verification-1",
  environmentId: "environment",
  projectId: "project",
  taskId: "task",
  specRevision: 4,
  specificationHash: "a".repeat(64),
  planRevision: 2,
  planHash: "b".repeat(64),
  criteria: [{ criterionId: "criterion-1", revision: 3 }],
  dispatchId: "original-implementation",
  bindingId: "implementation-binding",
  generation: 7,
  workspaceReceiptHash: "c".repeat(64),
  command: selection,
  target: {
    repository: "/project",
    worktree: "/project-worktree",
    branchRef: "refs/heads/team/implementation",
    baseSha: "d".repeat(40),
    headSha: "e".repeat(40),
    testedCommit: "e".repeat(40),
    testedTree: "f".repeat(40),
    workspaceState: "clean-committed",
  },
  executable: {
    target: selection.executable,
    sha256: "1".repeat(64),
    runtimeClosureSha256: "2".repeat(64),
  },
};

describe("frozen verification preview", () => {
  const decodeManifest = Schema.decodeUnknownSync(ProjectVerificationJobManifest, {
    onExcessProperty: "error",
  });

  it("retains the exact command, code target and criterion revisions for approval", () => {
    expect(decodeManifest(manifest)).toEqual(manifest);
  });

  it("rejects a dirty target or a tested commit different from the displayed head", () => {
    for (const target of [
      { ...manifest.target, workspaceState: "dirty" },
      { ...manifest.target, testedCommit: "9".repeat(40) },
      { ...manifest.target, testedTree: "not-a-tree" },
    ]) {
      expect(() => decodeManifest({ ...manifest, target })).toThrow();
    }
  });

  it("requires distinct criterion references and an executable matching the preview", () => {
    expect(() => decodeManifest({ ...manifest, criteria: [] })).toThrow();
    expect(() =>
      decodeManifest({ ...manifest, criteria: [...manifest.criteria, ...manifest.criteria] }),
    ).toThrow();
    expect(() =>
      decodeManifest({ ...manifest, executable: { ...manifest.executable, target: "/other" } }),
    ).toThrow();
  });

  it("rejects missing ownership hashes, future formats and caller environment additions", () => {
    for (const change of [
      { workspaceReceiptHash: undefined },
      { version: 2 },
      { command: { ...selection, env: { TOKEN: "secret" } } },
      { executable: { ...manifest.executable, runtimeClosureSha256: "2".repeat(63) } },
    ]) {
      expect(() => decodeManifest({ ...manifest, ...change })).toThrow();
    }
  });

  it("bounds ownership identifiers", () => {
    expect(() =>
      decodeManifest({ ...manifest, criteria: [{ criterionId: "x".repeat(257), revision: 0 }] }),
    ).toThrow();
  });

  it("bounds the complete encoded approval preview", () => {
    const path = "/" + "界".repeat(4_095);
    expect(() =>
      decodeManifest({
        ...manifest,
        target: { ...manifest.target, repository: path, worktree: path },
        command: { ...selection, executable: path, argv: Array(4).fill("x".repeat(4_096)) },
        executable: { ...manifest.executable, target: path },
      }),
    ).toThrow();
  });
});
