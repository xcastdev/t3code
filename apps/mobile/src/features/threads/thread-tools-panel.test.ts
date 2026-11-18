import type { ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TerminalMenuSession } from "../terminal/terminalMenu";
import { threadToolSections, type ThreadToolsInput } from "./thread-tools-panel";

const script: ProjectScript = {
  id: "test",
  name: "Test",
  command: "vp test",
  icon: "test",
  runOnWorktreeCreate: false,
};

function session(terminalId: string, updatedAt: string | null): TerminalMenuSession {
  return {
    terminalId,
    cwd: "/repo",
    status: "running",
    hasRunningSubprocess: false,
    displayLabel: `Terminal ${terminalId}`,
    updatedAt,
  };
}

const base: ThreadToolsInput = {
  hasThread: true,
  canOpenTerminal: true,
  canOperateTerminal: true,
  terminalSessions: [],
  projectScripts: [],
  hasFiles: true,
  canOpenFiles: true,
  browserTabUrls: [],
  deviceNames: [],
  gitItems: [],
  hasProject: false,
};

const rowsOf = (input: Partial<ThreadToolsInput>) =>
  threadToolSections({ ...base, ...input }).flatMap((section) => section.rows);

describe("threadToolSections", () => {
  it("starts a terminal when none is open, and only with operate access", () => {
    expect(rowsOf({ projectScripts: [script] }).slice(0, 2)).toMatchObject([
      {
        id: "terminal",
        subtitle: "Start a shell for this thread",
        disabled: false,
        action: { type: "new-terminal" },
      },
      { id: "script-test", nested: true, icon: "flask", action: { type: "script", script } },
    ]);
    expect(rowsOf({ canOperateTerminal: false })[0]).toMatchObject({
      id: "terminal",
      disabled: true,
    });
  });

  it("opens the most recent session and keeps every terminal menu entry as a sub-row", () => {
    const rows = rowsOf({
      projectScripts: [script],
      terminalSessions: [session("1", "2026-01-02"), session("2", "2026-01-03")],
    });
    expect(rows.map((row) => row.id)).toEqual([
      "terminal",
      "script-test",
      "terminal-1",
      "terminal-2",
      "terminal-new",
      "files",
      "history",
    ]);
    expect(rows[0]).toMatchObject({
      subtitle: "2 open",
      action: { type: "terminal", terminalId: "2" },
    });
  });

  it("lists the browser and device only while they have something open", () => {
    expect(rowsOf({}).map((row) => row.id)).not.toContain("browser");
    expect(rowsOf({}).map((row) => row.id)).not.toContain("device");
    const rows = rowsOf({
      browserTabUrls: ["http://localhost:8765/app"],
      deviceNames: ["iPhone 17", "Pixel 9"],
    });
    expect(rows.find((row) => row.id === "browser")?.subtitle).toBe("localhost:8765");
    expect(rows.find((row) => row.id === "device")?.subtitle).toBe("2 devices");
    expect(
      rowsOf({ browserTabUrls: [null, null] }).find((row) => row.id === "browser"),
    ).toMatchObject({ subtitle: "2 tabs" });
  });

  it("keeps a draft to files and a disabled history", () => {
    expect(
      threadToolSections({
        ...base,
        hasThread: false,
        canOpenTerminal: false,
        browserTabUrls: ["http://localhost:3000"],
        deviceNames: ["iPhone 17"],
      }),
    ).toMatchObject([
      { title: "Workspace", rows: [{ id: "files" }] },
      { title: "Thread", rows: [{ id: "history", disabled: true }] },
    ]);
    expect(
      threadToolSections({ ...base, hasThread: false, canOpenTerminal: false, hasFiles: false }),
    ).toMatchObject([{ title: "Thread" }]);
  });

  it("lists the git menu as its own section, flattening submenus", () => {
    const sections = threadToolSections({
      ...base,
      gitItems: [
        { id: "git-status", title: "main", subtitle: "Clean", disabled: true },
        {
          id: "more",
          items: [{ id: "git-review", title: "Review changes", icon: "doc.text.magnifyingglass" }],
        },
      ],
    });
    expect(sections.find((section) => section.title === "Source control")?.rows).toMatchObject([
      {
        id: "git-git-status",
        disabled: true,
        nested: false,
        action: { type: "git", itemId: "git-status" },
      },
      { id: "git-git-review", nested: true, action: { type: "git", itemId: "git-review" } },
    ]);
  });

  it("links the thread's project Work sections when it has a project", () => {
    expect(rowsOf({ hasProject: false }).some((row) => row.id.startsWith("project-"))).toBe(false);
    expect(
      threadToolSections({ ...base, hasProject: true })
        .find((section) => section.title === "Project")
        ?.rows.map((row) => row.action),
    ).toEqual(
      ["overview", "tasks", "team", "knowledge", "intake"].map((section) => ({
        type: "project",
        section,
      })),
    );
  });
});
