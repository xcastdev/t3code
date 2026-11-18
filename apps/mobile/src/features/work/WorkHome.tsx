import type { WorkHomeProject } from "@t3tools/client-runtime/state/work-home";
import type {
  EnvironmentId,
  ProjectId,
  ProjectWorkActivityTask,
  ProjectWorkAttentionItem,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import { memo, useState } from "react";
import { View } from "react-native";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useWorkAttentionEntries, useWorkHome, type WorkAttentionEntry } from "./workAttention";
import { workStateLabel } from "./workModel";
import {
  WorkHeading,
  WorkMemberAvatar,
  WorkSeparator,
  WorkStatRow,
  WorkStatTile,
  WorkStatusGlyph,
} from "./WorkStatus";

export type WorkSectionName = "overview" | "tasks" | "team" | "knowledge" | "intake";

export interface WorkHomeActions {
  readonly onOpenProject: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    section?: WorkSectionName,
  ) => void;
  readonly onOpenTask: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    taskId: ProjectWorkTaskId,
  ) => void;
}

const FEED_SHOWN = 8;

const ITEM_ICONS: Record<ProjectWorkAttentionItem["kind"], AppSymbolName> = {
  task: "checkmark.circle",
  blocker: "slash.circle",
  decision: "flowchart",
  question: "questionmark.bubble",
  message: "text.bubble",
};

/** Web's Work home: what waits on you and what is moving across projects; quiet ones fold away. */
export function WorkHome(props: WorkHomeActions) {
  const home = useWorkHome();
  const work = useWorkAttentionEntries();
  const projects = useProjects();
  const projectOf = (environmentId: EnvironmentId, projectId: ProjectId) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId);
  const titleOf = (environmentId: EnvironmentId, projectId: ProjectId) =>
    projectOf(environmentId, projectId)?.title ?? "Project";
  const nothing = work.length === 0 && home.active.length === 0;
  const openItem = (entry: WorkAttentionEntry) => {
    const { item } = entry;
    if (item.taskId !== undefined && item.surface === "tasks")
      props.onOpenTask(entry.environmentId, item.projectId, item.taskId);
    else
      props.onOpenProject(
        entry.environmentId,
        item.projectId,
        item.surface === "tasks" ? "tasks" : "overview",
      );
  };

  return (
    <>
      <View className="gap-2">
        <WorkStatRow>
          <WorkStatTile value={home.stats.needsYou} label="Need you" state="blocked" />
          <WorkStatTile
            value={home.stats.running}
            label="Running"
            state="in-progress"
            tone="info"
          />
        </WorkStatRow>
        <WorkStatRow>
          <WorkStatTile value={home.stats.inReview} label="In review" state="in-review" />
          <WorkStatTile value={home.stats.doneThisWeek} label="Done this week" state="completed" />
        </WorkStatRow>
      </View>

      {nothing ? (
        <View className="rounded-2xl border border-dashed border-border px-4 py-3">
          <Text textRole="footnote" className="text-foreground-muted">
            Nothing is waiting on you and nothing is running. Open a project's Work and add a task
            to get started.
          </Text>
        </View>
      ) : null}

      {work.length > 0 ? <NeedsYouFeed entries={work} titleOf={titleOf} onOpen={openItem} /> : null}

      {home.active.length > 0 ? (
        <View className="gap-2">
          <WorkHeading title="Active projects" />
          {home.active.map((project) => (
            <ProjectCard
              key={`${project.environmentId}:${project.projectId}`}
              project={project}
              entity={projectOf(project.environmentId, project.projectId)}
              actions={props}
            />
          ))}
        </View>
      ) : null}

      {home.quiet.length > 0 ? (
        <QuietProjects
          quiet={home.quiet}
          others={home.active.length > 0}
          titleOf={titleOf}
          onOpen={(environmentId, projectId) => props.onOpenProject(environmentId, projectId)}
        />
      ) : null}
    </>
  );
}

function NeedsYouFeed(props: {
  readonly entries: ReadonlyArray<WorkAttentionEntry>;
  readonly titleOf: (environmentId: EnvironmentId, projectId: ProjectId) => string;
  readonly onOpen: (entry: WorkAttentionEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? props.entries : props.entries.slice(0, FEED_SHOWN);
  return (
    <View className="gap-2">
      <WorkHeading title="Needs you" count={props.entries.length} />
      <ListSection>
        {shown.map((entry, index) => (
          <View key={entry.key}>
            {index > 0 ? <WorkSeparator /> : null}
            <NeedsYouRow
              entry={entry}
              projectTitle={props.titleOf(entry.environmentId, entry.item.projectId)}
              onOpen={props.onOpen}
            />
          </View>
        ))}
        {props.entries.length > FEED_SHOWN ? (
          <>
            <WorkSeparator />
            <ListRow
              label={expanded ? "Show fewer" : `Show all ${props.entries.length}`}
              onPress={() => setExpanded(!expanded)}
            />
          </>
        ) : null}
      </ListSection>
    </View>
  );
}

const NeedsYouRow = memo(function NeedsYouRow(props: {
  readonly entry: WorkAttentionEntry;
  readonly projectTitle: string;
  readonly onOpen: (entry: WorkAttentionEntry) => void;
}) {
  const { item } = props.entry;
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={`${item.reason}, ${item.title}, ${props.projectTitle}`}
      onPress={() => props.onOpen(props.entry)}
      className="bg-grouped-card"
    >
      <View className="flex-row items-start gap-3 px-4 py-3">
        <View className="pt-0.5">
          <SymbolView
            name={ITEM_ICONS[item.kind]}
            size={18}
            tintColorClassName="accent-icon-muted"
          />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text textRole="label" numberOfLines={1} className="text-foreground-muted">
            <Text textRole="label" className="font-t3-medium text-danger-foreground">
              {item.reason}
            </Text>
            {`  ·  ${props.projectTitle}`}
          </Text>
          <Text textRole="body" numberOfLines={2} className="font-t3-medium text-foreground">
            {item.title}
          </Text>
          {item.detail ? (
            <Text textRole="footnote" numberOfLines={2} className="text-foreground-muted">
              {item.detail}
            </Text>
          ) : null}
        </View>
        <Text textRole="label" className="pt-0.5 text-foreground-tertiary">
          <RelativeTime timestamp={item.at} />
        </Text>
      </View>
    </RowPressable>
  );
});

function ProjectCard(props: {
  readonly project: WorkHomeProject;
  readonly entity: EnvironmentProject | undefined;
  readonly actions: WorkHomeActions;
}) {
  const { project, entity } = props;
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === project.environmentId);
  const title = entity?.title ?? "Project";
  const counts = [
    project.needsYou > 0
      ? `${project.needsYou} need${project.needsYou === 1 ? "s" : ""} you`
      : null,
    project.running > 0 ? `${project.running} running` : null,
    project.inReview > 0 ? `${project.inReview} in review` : null,
    project.open > 0 ? `${project.open} open` : null,
  ].filter((part) => part !== null);
  const tasks = project.active.length > 0 ? project.active : project.recent;
  const open = () => props.actions.onOpenProject(project.environmentId, project.projectId);
  return (
    <ListSection>
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${counts.join(", ") || "Quiet"}`}
        onPress={open}
        className="bg-grouped-card"
      >
        <View className="flex-row items-center gap-3 px-4 py-3">
          <ProjectFavicon
            environmentId={project.environmentId}
            faviconPath={entity?.faviconPath}
            projectIcon={entity?.projectIcon}
            projectTitle={title}
            size={32}
            workspaceRoot={entity?.workspaceRoot}
          />
          <View className="min-w-0 flex-1 gap-0.5">
            <View className="flex-row items-baseline gap-2">
              <Text
                textRole="body"
                numberOfLines={1}
                className="shrink font-t3-bold text-foreground"
              >
                {title}
              </Text>
              {environment ? (
                <Text
                  textRole="label"
                  numberOfLines={1}
                  className="shrink text-foreground-tertiary"
                >
                  {environment.label}
                </Text>
              ) : null}
            </View>
            <Text textRole="footnote" numberOfLines={1} className="text-foreground-muted">
              {counts.length > 0 ? counts.join(" · ") : "Quiet"}
            </Text>
          </View>
          {project.needsYou > 0 ? (
            <View className="size-2 rounded-full bg-danger-foreground" />
          ) : null}
          <SymbolView name="chevron.right" size={14} tintColorClassName="accent-chevron" />
        </View>
      </RowPressable>
      {tasks.length > 0 ? (
        <>
          <WorkSeparator />
          {project.active.length === 0 ? (
            <Text textRole="label" className="px-4 pt-2 font-t3-medium text-foreground-tertiary">
              Recently changed
            </Text>
          ) : null}
          {tasks.map((task) => (
            <ActivityTaskRow
              key={task.taskId}
              task={task}
              onOpen={() =>
                props.actions.onOpenTask(project.environmentId, project.projectId, task.taskId)
              }
            />
          ))}
        </>
      ) : project.needsYou > 0 ? (
        <>
          <WorkSeparator />
          <RowPressable accessibilityRole="button" onPress={open} className="bg-grouped-card">
            <View className="flex-row items-center gap-2 px-4 py-2.5">
              <SymbolView
                name="tray.and.arrow.down"
                size={14}
                tintColorClassName="accent-icon-muted"
              />
              <Text textRole="footnote" className="text-foreground-muted">
                Nothing running. Open the project to answer what's waiting.
              </Text>
            </View>
          </RowPressable>
        </>
      ) : null}
    </ListSection>
  );
}

const ActivityTaskRow = memo(function ActivityTaskRow(props: {
  readonly task: ProjectWorkActivityTask;
  readonly onOpen: () => void;
}) {
  const { task } = props;
  const worker = task.worker;
  const who = worker?.name ?? task.assignee;
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={`${task.title}, ${workStateLabel(task.state)}`}
      onPress={props.onOpen}
      className="bg-grouped-card"
    >
      <View className="flex-row items-center gap-2.5 px-4 py-2.5">
        <WorkStatusGlyph state={task.state} />
        <View className="min-w-0 flex-1">
          <Text textRole="footnote" numberOfLines={1} className="text-foreground">
            {task.title}
          </Text>
          <Text textRole="label" numberOfLines={1} className="text-foreground-muted">
            {workStateLabel(task.state)}
            {who ? ` · ${who}` : ""}
          </Text>
        </View>
        {worker ? (
          <WorkMemberAvatar
            role={worker.role}
            name={worker.name}
            avatar={worker.avatar}
            size={20}
          />
        ) : null}
        <Text textRole="label" className="text-foreground-tertiary">
          <RelativeTime timestamp={task.at} />
        </Text>
      </View>
    </RowPressable>
  );
});

function QuietProjects(props: {
  readonly quiet: ReadonlyArray<{ environmentId: EnvironmentId; projectId: ProjectId }>;
  readonly others: boolean;
  readonly titleOf: (environmentId: EnvironmentId, projectId: ProjectId) => string;
  readonly onOpen: (environmentId: EnvironmentId, projectId: ProjectId) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = props.quiet.length;
  const label = `${count} ${props.others ? "other " : ""}${count === 1 ? "project is" : "projects are"} quiet`;
  // Sorted once per render of this small list; titles come from the project snapshot.
  const sorted = [...props.quiet].sort((a, b) =>
    props
      .titleOf(a.environmentId, a.projectId)
      .localeCompare(props.titleOf(b.environmentId, b.projectId)),
  );
  return (
    <ListSection>
      <RowPressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="bg-grouped-card"
      >
        <View className="flex-row items-center gap-3 px-4 py-3">
          <SymbolView name="folder" size={18} tintColorClassName="accent-icon-muted" />
          <Text textRole="footnote" className="min-w-0 flex-1 text-foreground-muted">
            {label}
          </Text>
          <Text textRole="footnote" className="text-primary-text">
            {open ? "Hide" : "Open a project"}
          </Text>
        </View>
      </RowPressable>
      {open
        ? sorted.map((project) => (
            <View key={`${project.environmentId}:${project.projectId}`}>
              <WorkSeparator />
              <ListRow
                label={props.titleOf(project.environmentId, project.projectId)}
                onPress={() => props.onOpen(project.environmentId, project.projectId)}
              />
            </View>
          ))
        : null}
    </ListSection>
  );
}
