import type { ProjectScript } from "@t3tools/contracts";
import { projectScriptMenuLabel } from "@t3tools/shared/projectScripts";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import {
  basename,
  getTerminalStatusLabel,
  type TerminalMenuSession,
} from "../terminal/terminalMenu";

export type ThreadToolAction =
  | { readonly type: "terminal"; readonly terminalId: string }
  | { readonly type: "new-terminal" }
  | { readonly type: "script"; readonly script: ProjectScript }
  | { readonly type: "files" }
  | { readonly type: "browser" }
  | { readonly type: "device" }
  | { readonly type: "history" }
  | { readonly type: "git"; readonly itemId: string }
  | { readonly type: "project"; readonly section: ProjectWorkSection };

export type ProjectWorkSection = "overview" | "tasks" | "team" | "knowledge" | "intake";

const PROJECT_ROWS: ReadonlyArray<{
  readonly section: ProjectWorkSection;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: AppSymbolName;
}> = [
  {
    section: "overview",
    title: "Overview",
    subtitle: "Progress, inbox and missions",
    icon: "square.grid.2x2",
  },
  {
    section: "tasks",
    title: "Tasks",
    subtitle: "Everything the team is working on",
    icon: "checkmark.circle",
  },
  { section: "team", title: "Team", subtitle: "Members and what they're doing", icon: "person.2" },
  { section: "knowledge", title: "Knowledge", subtitle: "Notes and decisions", icon: "doc.text" },
  {
    section: "intake",
    title: "Intake",
    subtitle: "Issues and requests coming in",
    icon: "tray.and.arrow.down",
  },
];

export interface ThreadToolRow {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: AppSymbolName;
  /** A sub-row of the tool above it, such as a terminal session. */
  readonly nested: boolean;
  readonly disabled: boolean;
  readonly action: ThreadToolAction;
}

export interface ThreadToolSection {
  readonly title: string;
  readonly rows: ReadonlyArray<ThreadToolRow>;
}

export interface ThreadToolsInput {
  readonly hasThread: boolean;
  readonly canOpenTerminal: boolean;
  readonly canOperateTerminal: boolean;
  readonly terminalSessions: ReadonlyArray<TerminalMenuSession>;
  readonly projectScripts: ReadonlyArray<ProjectScript>;
  readonly hasFiles: boolean;
  readonly canOpenFiles: boolean;
  /** One entry per open browser tab: its URL, or null before it loads one. */
  readonly browserTabUrls: ReadonlyArray<string | null>;
  readonly deviceNames: ReadonlyArray<string>;
  /** Whether the thread belongs to a project with Work views. */
  readonly hasProject: boolean;
  /** The header's former Git menu, listed as its own section. */
  readonly gitItems: ReadonlyArray<ThreadToolGitItem>;
}

export interface ThreadToolGitItem {
  readonly id: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly icon?: string;
  readonly disabled?: boolean;
  readonly items?: ReadonlyArray<ThreadToolGitItem>;
}

function gitRows(items: ReadonlyArray<ThreadToolGitItem>, nested = false): ThreadToolRow[] {
  return items.flatMap((item): ThreadToolRow[] =>
    item.items !== undefined
      ? gitRows(item.items, true)
      : [
          {
            id: `git-${item.id}`,
            title: item.title ?? "",
            subtitle: item.subtitle ?? "",
            icon: (item.icon ?? "arrow.triangle.branch") as AppSymbolName,
            nested,
            disabled: item.disabled === true,
            action: { type: "git", itemId: item.id },
          },
        ],
  );
}

const REQUIRES_THREAD = "Available after the first message";

function scriptIcon(icon: ProjectScript["icon"]): AppSymbolName {
  if (icon === "test") return "flask";
  if (icon === "lint") return "checkmark.circle";
  if (icon === "configure") return "wrench.and.screwdriver";
  if (icon === "build") return "hammer";
  return "play";
}

function mostRecentSession(sessions: ReadonlyArray<TerminalMenuSession>) {
  return sessions.reduce<TerminalMenuSession | null>((latest, session) => {
    if (latest === null) return session;
    return (session.updatedAt ?? "") >= (latest.updatedAt ?? "") ? session : latest;
  }, null);
}

function urlLabel(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function browserSubtitle(urls: ReadonlyArray<string | null>) {
  const [only] = urls;
  if (urls.length === 1 && only) return urlLabel(only);
  return urls.length === 1 ? "1 tab" : `${urls.length} tabs`;
}

function terminalRows(input: ThreadToolsInput): ReadonlyArray<ThreadToolRow> {
  if (!input.canOpenTerminal) return [];
  const sessions = input.terminalSessions;
  const recent = mostRecentSession(sessions);
  const main: ThreadToolRow = {
    id: "terminal",
    title: "Terminal",
    subtitle: recent === null ? "Start a shell for this thread" : `${sessions.length} open`,
    icon: "terminal",
    nested: false,
    disabled: recent === null && !input.canOperateTerminal,
    action:
      recent === null
        ? { type: "new-terminal" }
        : { type: "terminal", terminalId: recent.terminalId },
  };
  const scripts = input.projectScripts.map((script): ThreadToolRow => ({
    id: `script-${script.id}`,
    title: projectScriptMenuLabel(script),
    subtitle: script.command,
    icon: scriptIcon(script.icon),
    nested: true,
    disabled: !input.canOperateTerminal,
    action: { type: "script", script },
  }));
  // With no session the main row already starts one.
  if (recent === null) return [main, ...scripts];
  return [
    main,
    ...scripts,
    ...sessions.map((session): ThreadToolRow => ({
      id: `terminal-${session.terminalId}`,
      title: session.displayLabel,
      subtitle: [
        getTerminalStatusLabel({
          status: session.status,
          hasRunningSubprocess: session.hasRunningSubprocess,
        }),
        basename(session.cwd),
      ]
        .filter(Boolean)
        .join(" · "),
      icon: "terminal",
      nested: true,
      disabled: false,
      action: { type: "terminal", terminalId: session.terminalId },
    })),
    {
      id: "terminal-new",
      title: "New terminal",
      subtitle: "Start another shell for this thread",
      icon: "plus",
      nested: true,
      disabled: !input.canOperateTerminal,
      action: { type: "new-terminal" },
    },
  ];
}

/** The tools panel's rows: only tools this thread can open now. */
export function threadToolSections(input: ThreadToolsInput): ReadonlyArray<ThreadToolSection> {
  const workspace: ThreadToolRow[] = [...terminalRows(input)];
  if (input.hasFiles) {
    workspace.push({
      id: "files",
      title: "Files",
      subtitle: "Browse and search the project",
      icon: "folder",
      nested: false,
      disabled: !input.canOpenFiles,
      action: { type: "files" },
    });
  }
  if (input.hasThread && input.browserTabUrls.length > 0) {
    workspace.push({
      id: "browser",
      title: "Browser",
      subtitle: browserSubtitle(input.browserTabUrls),
      icon: "globe",
      nested: false,
      disabled: false,
      action: { type: "browser" },
    });
  }
  // The device page closes itself when the thread has no device, so it only lists open ones.
  if (input.hasThread && input.deviceNames.length > 0) {
    workspace.push({
      id: "device",
      title: "Device",
      subtitle:
        input.deviceNames.length === 1
          ? (input.deviceNames[0] ?? "")
          : `${input.deviceNames.length} devices`,
      icon: "iphone",
      nested: false,
      disabled: false,
      action: { type: "device" },
    });
  }
  const thread: ThreadToolRow[] = [
    {
      id: "history",
      title: "Thread history",
      subtitle: input.hasThread ? "Snapshots and restores" : REQUIRES_THREAD,
      icon: "clock",
      nested: false,
      disabled: !input.hasThread,
      action: { type: "history" },
    },
  ];
  const git = gitRows(input.gitItems);
  const project = input.hasProject
    ? PROJECT_ROWS.map((row): ThreadToolRow => ({
        id: `project-${row.section}`,
        title: row.title,
        subtitle: row.subtitle,
        icon: row.icon,
        nested: false,
        disabled: false,
        action: { type: "project", section: row.section },
      }))
    : [];
  return [
    ...(workspace.length > 0 ? [{ title: "Workspace", rows: workspace }] : []),
    ...(project.length > 0 ? [{ title: "Project", rows: project }] : []),
    ...(git.length > 0 ? [{ title: "Source control", rows: git }] : []),
    { title: "Thread", rows: thread },
  ];
}
