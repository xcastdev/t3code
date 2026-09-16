/* @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  formatFileCommentRange,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import {
  isMarkdownPreviewFile,
  setMarkdownTaskChecked,
  shouldShowFileExplorer,
} from "./filePreviewMode";
import FilePreviewPanel from "./FilePreviewPanel";

vi.mock("./projectFilesQueryState", () => ({
  getOptimisticProjectFileQueryData: () => null,
  setProjectFileQueryData: () => undefined,
  useProjectFileQuery: () => ({ data: null, error: null, refresh: () => undefined }),
}));
vi.mock("./FileBreadcrumbs", () => ({
  FileBreadcrumbs: ({ onOpenFile }: { onOpenFile: (relativePath: string) => void }) =>
    createElement(
      "button",
      {
        "data-file-breadcrumbs-content": true,
        "aria-label": "Open breadcrumb file",
        onClick: () => onOpenFile("docs/from-breadcrumb.ts"),
      },
      "Breadcrumbs",
    ),
}));
vi.mock("./FileBrowserPanel", () => ({
  default: ({ onOpenFile }: { onOpenFile: (relativePath: string) => void }) =>
    createElement(
      "button",
      {
        "data-workspace-file-explorer": true,
        "aria-label": "Open workspace file",
        onClick: () => onOpenFile("docs/from-files.ts"),
      },
      "Workspace files",
    ),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: <T>(selector: (settings: { wordWrap: boolean }) => T) =>
    selector({ wordWrap: false }),
  useUpdateClientSettings: () => () => undefined,
}));
vi.mock("~/state/environments", () => ({ useEnvironmentHttpBaseUrl: () => null }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => () => undefined }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => () => undefined }));

describe("file comment annotations", () => {
  it("normalizes and formats selected line ranges", () => {
    expect(normalizeFileCommentRange({ start: 16, end: 7 })).toEqual({
      startLine: 7,
      endLine: 16,
    });
    expect(formatFileCommentRange(7, 7)).toBe("L7");
    expect(formatFileCommentRange(7, 16)).toBe("L7 to L16");
  });

  it("keeps an annotation range attached when Pierre remaps its anchor line", () => {
    expect(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: "comment-1",
                kind: "comment",
                startLine: 7,
                endLine: 16,
                text: "Keep this guarded.",
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        lineNumber: 20,
        metadata: {
          entries: [
            {
              id: "comment-1",
              kind: "comment",
              startLine: 11,
              endLine: 20,
              text: "Keep this guarded.",
            },
          ],
        },
      },
    ]);
  });
});

describe("isMarkdownPreviewFile", () => {
  it("recognizes markdown and MDX files case-insensitively", () => {
    expect(isMarkdownPreviewFile("README.md")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.MDX")).toBe(true);
  });

  it("does not treat other text files as markdown", () => {
    expect(isMarkdownPreviewFile("docs/guide.txt")).toBe(false);
    expect(isMarkdownPreviewFile("docs/markdown.ts")).toBe(false);
  });
});

describe("shouldShowFileExplorer", () => {
  it("hides the workspace tree for host files and attachments", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "/tmp/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldShowFileExplorer({
        relativePath: "report.pdf",
        explorerOpen: true,
        attachmentOpen: true,
      }),
    ).toBe(false);
  });

  it("keeps the saved explorer preference for workspace files", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(true);
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: false,
        attachmentOpen: false,
      }),
    ).toBe(false);
  });

  it("hides the explorer and its control when the secondary surface owns the tree", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
        workspaceExplorerEnabled: false,
      }),
    ).toBe(false);
  });
});

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] First\n- [x] Second\n");
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe("- [ ] First\n- [ ] Second\n");
    expect(setMarkdownTaskChecked("1. [X] Ordered\n", 3, false)).toBe("1. [ ] Ordered\n");
  });

  it("leaves the document unchanged for a stale or invalid marker offset", () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown);
  });
});

describe("FilePreviewPanel workspace explorer ownership", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const threadRef = scopeThreadRef(EnvironmentId.make("file-preview"), ThreadId.make("thread"));

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps the Files surface tree out of a secondary file tab without removing shared preview chrome", async () => {
    await act(async () =>
      root.render(
        createElement(FilePreviewPanel, {
          environmentId: threadRef.environmentId,
          cwd: "/repo",
          projectName: "Repo",
          relativePath: "docs/guide.ts",
          threadRef,
          composerDraftTarget: threadRef,
          revealLine: null,
          revealRequestId: 1,
          onOpenFile: () => undefined,
          onPendingChange: () => undefined,
          selectedFilePending: false,
          workspaceMutationId: null,
          showWorkspaceExplorer: false,
        }),
      ),
    );

    expect(host.querySelector("[data-file-breadcrumbs]")).not.toBeNull();
    expect(host.querySelector('[aria-label="Hide file explorer"]')).toBeNull();
    expect(host.querySelector("[data-workspace-file-explorer]")).toBeNull();
  });

  it("keeps the right-sidebar Files preview as the owner of its explorer and toggle", async () => {
    const openFile = vi.fn();
    await act(async () =>
      root.render(
        createElement(FilePreviewPanel, {
          environmentId: threadRef.environmentId,
          cwd: "/repo",
          projectName: "Repo",
          relativePath: "docs/guide.ts",
          threadRef,
          composerDraftTarget: threadRef,
          revealLine: null,
          revealRequestId: 1,
          onOpenFile: openFile,
          onPendingChange: () => undefined,
          selectedFilePending: false,
          workspaceMutationId: null,
        }),
      ),
    );

    expect(host.querySelector('[aria-label="Hide file explorer"]')).not.toBeNull();
    expect(host.querySelector("[data-workspace-file-explorer]")).not.toBeNull();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Open workspace file"]')!.click(),
    );
    expect(openFile).toHaveBeenCalledWith("docs/from-files.ts");
  });
});
