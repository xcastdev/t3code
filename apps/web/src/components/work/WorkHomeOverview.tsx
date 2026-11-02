import type { WorkHomeProject } from "@t3tools/client-runtime/state/work-home";
import type {
  EnvironmentId,
  ProjectId,
  ProjectWorkActivityTask,
  ProjectWorkAttentionItem,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import {
  ChevronRightIcon,
  CircleHelpIcon,
  FolderIcon,
  InboxIcon,
  ListTodoIcon,
  MessageSquareIcon,
  ScaleIcon,
} from "lucide-react";
import { useState } from "react";

import { deriveProjectIdentity } from "../../projectIdentity";
import { useAttentionEntries, useWorkHome } from "../../state/attention";
import { useProjects } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { ProjectMonogram } from "../ProjectMonogram";
import { RelativeTime } from "../RelativeTime";
import { SettingsGroup } from "../settings/SettingsGroup";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { WorkMeta } from "./WorkLayout";
import { WorkMemberAvatar } from "./WorkMemberAvatar";
import { workStateLabel } from "./workModel";
import { WorkStatusGlyph } from "./WorkStatus";
import { memberAvatarIdentity } from "./workTeamView";

export interface WorkHomeTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly section: "overview" | "tasks";
  readonly taskId?: ProjectWorkTaskId;
}

const FEED_SHOWN = 8;

const ITEM_ICONS = {
  task: ListTodoIcon,
  blocker: ListTodoIcon,
  decision: ScaleIcon,
  question: CircleHelpIcon,
  message: MessageSquareIcon,
} as const;

const itemTarget = (
  environmentId: EnvironmentId,
  item: ProjectWorkAttentionItem,
): WorkHomeTarget => ({
  environmentId,
  projectId: item.projectId,
  ...(item.taskId !== undefined && item.surface === "tasks"
    ? { section: "tasks", taskId: item.taskId }
    : { section: item.surface === "tasks" ? "tasks" : "overview" }),
});

/** What waits on the user and what is moving across projects; quiet projects stay out. */
export function WorkHomeOverview({
  onOpen,
}: {
  readonly onOpen: (target: WorkHomeTarget) => void;
}) {
  const home = useWorkHome();
  const work = useAttentionEntries().flatMap((entry) => (entry.type === "work" ? [entry] : []));
  const projects = useProjects();
  const titleOf = (environmentId: EnvironmentId, projectId: ProjectId) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? "Project";
  const nothing = work.length === 0 && home.active.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6">
      <section
        aria-label="Across projects"
        className="grid min-w-0 grid-cols-2 gap-2 @xl/work:grid-cols-4"
      >
        <Stat value={home.stats.needsYou} label="Need you" state="blocked" />
        <Stat value={home.stats.running} label="Running" state="in-progress" />
        <Stat value={home.stats.inReview} label="In review" state="in-review" />
        <Stat value={home.stats.doneThisWeek} label="Done this week" state="completed" />
      </section>

      {nothing ? (
        <p className="m-0 rounded-xl border border-dashed border-border/70 px-4 py-3 text-sm text-muted-foreground">
          Nothing is waiting on you and nothing is running. Open a project's Work and add a task to
          get started.
        </p>
      ) : null}

      {work.length > 0 ? (
        <NeedsYouFeed
          entries={work}
          titleOf={titleOf}
          onOpen={(entry) => onOpen(itemTarget(entry.environmentId, entry.item))}
        />
      ) : null}

      {home.active.length > 0 ? (
        <section aria-labelledby="work-home-active" className="flex min-w-0 flex-col gap-2">
          <h2 id="work-home-active" className="m-0 px-1 text-sm font-medium">
            Active projects
          </h2>
          <div className="grid min-w-0 items-start gap-3 @3xl/work:grid-cols-2">
            {home.active.map((project) => (
              <ProjectCard
                key={`${project.environmentId}:${project.projectId}`}
                project={project}
                title={titleOf(project.environmentId, project.projectId)}
                onOpen={onOpen}
              />
            ))}
          </div>
        </section>
      ) : null}

      {home.quiet.length > 0 ? (
        <div className="flex min-w-0 items-center gap-2 px-1">
          <WorkMeta>
            {home.quiet.length === 1
              ? `1 ${home.active.length === 0 ? "" : "other "}project is quiet.`
              : `${home.quiet.length} ${home.active.length === 0 ? "" : "other "}projects are quiet.`}
          </WorkMeta>
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="ghost" />}>
              <FolderIcon />
              Open a project
            </MenuTrigger>
            <MenuPopup align="start" className="max-h-80 min-w-56">
              {home.quiet.map((project) => (
                <MenuItem
                  key={`${project.environmentId}:${project.projectId}`}
                  onClick={() => onOpen({ ...project, section: "overview" })}
                >
                  <span className="min-w-0 truncate">
                    {titleOf(project.environmentId, project.projectId)}
                  </span>
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        </div>
      ) : null}
    </div>
  );
}

function Stat(props: { readonly value: number; readonly label: string; readonly state: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <span className="flex items-center gap-1.5">
        <WorkStatusGlyph state={props.state} />
        <span className="text-lg leading-6 font-semibold tabular-nums">{props.value}</span>
      </span>
      <span className="truncate text-xs text-muted-foreground">{props.label}</span>
    </div>
  );
}

type WorkEntry = Extract<ReturnType<typeof useAttentionEntries>[number], { type: "work" }>;

function NeedsYouFeed(props: {
  readonly entries: ReadonlyArray<WorkEntry>;
  readonly titleOf: (environmentId: EnvironmentId, projectId: ProjectId) => string;
  readonly onOpen: (entry: WorkEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? props.entries : props.entries.slice(0, FEED_SHOWN);
  return (
    <section aria-labelledby="work-home-needs-you" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline gap-2 px-1">
        <h2 id="work-home-needs-you" className="m-0 text-sm font-medium">
          Needs you
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">{props.entries.length}</span>
      </div>
      <SettingsGroup>
        {shown.map((entry) => {
          const Icon = ITEM_ICONS[entry.item.kind];
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => props.onOpen(entry)}
              className="flex w-full min-w-0 items-start gap-3 px-4 py-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5 text-xs">
                  <span className="shrink-0 font-medium text-destructive-foreground">
                    {entry.item.reason}
                  </span>
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {props.titleOf(entry.environmentId, entry.item.projectId)}
                  </span>
                </span>
                <span className="truncate text-sm font-medium">{entry.item.title}</span>
                {entry.item.detail ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {entry.item.detail}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
                <RelativeTime timestamp={entry.item.at} />
              </span>
            </button>
          );
        })}
        {props.entries.length > FEED_SHOWN ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="w-full px-4 py-2 text-left text-xs text-muted-foreground outline-none hover:bg-accent/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {expanded ? "Show fewer" : `Show all ${props.entries.length}`}
          </button>
        ) : null}
      </SettingsGroup>
    </section>
  );
}

function ProjectCard(props: {
  readonly project: WorkHomeProject;
  readonly title: string;
  readonly onOpen: (target: WorkHomeTarget) => void;
}) {
  const { project } = props;
  const environment = useEnvironment(project.environmentId);
  const identity = deriveProjectIdentity(props.title);
  const ref = { environmentId: project.environmentId, projectId: project.projectId };
  const counts = [
    project.needsYou > 0
      ? `${project.needsYou} need${project.needsYou === 1 ? "s" : ""} you`
      : null,
    project.running > 0 ? `${project.running} running` : null,
    project.inReview > 0 ? `${project.inReview} in review` : null,
    project.open > 0 ? `${project.open} open` : null,
  ].filter((part) => part !== null);
  const tasks = project.active.length > 0 ? project.active : project.recent;
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs">
      <button
        type="button"
        onClick={() => props.onOpen({ ...ref, section: "overview" })}
        className="flex min-w-0 items-center gap-3 px-4 py-3 text-left outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ProjectMonogram text={identity.monogram} color={identity.color} className="size-8" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold">{props.title}</span>
            {environment ? (
              <span className="shrink-0 truncate text-xs text-muted-foreground">
                {environment.label}
              </span>
            ) : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {counts.length > 0 ? counts.join(" · ") : "Quiet"}
          </span>
        </span>
        {project.needsYou > 0 ? (
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive" />
        ) : null}
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {tasks.length > 0 ? (
        <div className="flex min-w-0 flex-col border-t border-border/50">
          {project.active.length === 0 ? (
            <span className="px-4 pt-2 text-2xs font-medium text-muted-foreground">
              Recently changed
            </span>
          ) : null}
          {tasks.map((task) => (
            <TaskRow
              key={task.taskId}
              task={task}
              onOpen={() => props.onOpen({ ...ref, section: "tasks", taskId: task.taskId })}
            />
          ))}
        </div>
      ) : project.needsYou > 0 ? (
        <button
          type="button"
          onClick={() => props.onOpen({ ...ref, section: "overview" })}
          className="flex min-w-0 items-center gap-2 border-t border-border/50 px-4 py-2.5 text-left text-xs text-muted-foreground outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <InboxIcon aria-hidden className="size-3.5" />
          Nothing running. Open the project to answer what's waiting.
        </button>
      ) : null}
    </article>
  );
}

function TaskRow(props: { readonly task: ProjectWorkActivityTask; readonly onOpen: () => void }) {
  const { task } = props;
  const worker = task.worker;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex min-w-0 items-center gap-2.5 px-4 py-2 text-left outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <WorkStatusGlyph state={task.state} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{task.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {workStateLabel(task.state)}
          {worker || task.assignee ? ` · ${worker?.name ?? task.assignee}` : ""}
        </span>
      </span>
      {worker ? (
        <WorkMemberAvatar
          member={memberAvatarIdentity(worker.role, worker.name, worker.avatar)}
          size="icon"
        />
      ) : null}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        <RelativeTime timestamp={task.at} />
      </span>
    </button>
  );
}
