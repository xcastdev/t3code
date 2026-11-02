import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AttentionEntry } from "@t3tools/client-runtime/state/attention";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { BellIcon, ListTodoIcon, MessageSquareIcon } from "lucide-react";

import { useAttentionArrivals, useAttentionPulseContinuous } from "../hooks/useAttentionArrivals";
import { cn } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { useAttentionEntries } from "../state/attention";
import { useProjects, useQuietThreadShell } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { RelativeTime } from "./RelativeTime";
import { AttentionDot } from "./ui/attention-dot";
import { Button } from "./ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const SHOWN = 30;

/** Everything waiting on the user across chats and Work; picking one opens it. */
export function AttentionBell(props: { readonly className?: string }) {
  const entries = useAttentionEntries();
  const pulse = useAttentionArrivals(entries.map((entry) => entry.key));
  const continuous = useAttentionPulseContinuous();
  const projects = useProjects();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as {
    readonly environmentId?: string;
    readonly threadId?: string;
  };
  const currentRef =
    params.environmentId && params.threadId
      ? scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId)
      : null;
  const currentThread = useQuietThreadShell(currentRef);
  const projectTitle = (environmentId: EnvironmentId, projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? "Project";

  const open = (entry: AttentionEntry) => {
    if (entry.type === "chat") {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(entry.environmentId, entry.threadId)),
      });
      return;
    }
    const { item } = entry;
    // In a thread of the same project, Work opens beside it; elsewhere on the Work page.
    if (
      currentRef !== null &&
      currentThread?.environmentId === entry.environmentId &&
      currentThread.projectId === item.projectId
    ) {
      const panels = useRightPanelStore.getState();
      if (item.taskId !== undefined && item.surface === "tasks") {
        panels.openWorkTask(currentRef, item.taskId, item.title);
      } else {
        panels.openWork(currentRef, item.surface === "tasks" ? "tasks" : "overview");
      }
      return;
    }
    void navigate({
      to: "/work/$environmentId/$projectId",
      params: { environmentId: entry.environmentId, projectId: item.projectId },
      search:
        item.taskId !== undefined && item.surface === "tasks"
          ? { section: "tasks", taskId: item.taskId }
          : { section: item.surface === "tasks" ? "tasks" : "overview" },
    });
  };

  const label =
    entries.length === 0 ? "Notifications" : `Notifications, ${entries.length} waiting on you`;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={label}
                  className={cn("relative [-webkit-app-region:no-drag]", props.className)}
                />
              }
            />
          }
        >
          <BellIcon className="size-5" />
          {entries.length > 0 ? <AttentionDot pulse={pulse} continuous={continuous} /> : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" className="w-80 max-w-[calc(100vw-1rem)]">
        <MenuGroup>
          <MenuGroupLabel>
            {entries.length === 0 ? "Nothing needs you" : `${entries.length} waiting on you`}
          </MenuGroupLabel>
          <div className="max-h-[min(28rem,70vh)] overflow-y-auto">
            {entries.slice(0, SHOWN).map((entry) => (
              <MenuItem key={entry.key} onClick={() => open(entry)}>
                <span className="flex w-full min-w-0 items-start gap-2.5">
                  {entry.type === "chat" ? (
                    <MessageSquareIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                  ) : (
                    <ListTodoIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-1.5 text-xs">
                      <span className="shrink-0 font-medium text-destructive-foreground">
                        {entry.type === "chat" ? entry.reason : entry.item.reason}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {projectTitle(
                          entry.environmentId,
                          entry.type === "chat" ? entry.projectId : entry.item.projectId,
                        )}
                      </span>
                      <span className="ms-auto shrink-0 text-muted-foreground tabular-nums">
                        <RelativeTime
                          timestamp={entry.type === "chat" ? entry.at : entry.item.at}
                        />
                      </span>
                    </span>
                    <span className="truncate text-sm">
                      {entry.type === "chat" ? entry.title : entry.item.title}
                    </span>
                    {entry.type === "work" && entry.item.detail ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {entry.item.detail}
                      </span>
                    ) : null}
                  </span>
                </span>
              </MenuItem>
            ))}
            {entries.length > SHOWN ? (
              <p className="m-0 px-2 py-1.5 text-xs text-muted-foreground">
                {entries.length - SHOWN} more not shown.
              </p>
            ) : null}
          </div>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
