import type { ProjectWorkTaskRead } from "@t3tools/contracts";
import { UserRoundIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import type { useWorkTeamRoster } from "./useWorkTeamRoster";
import { WorkMemberAvatar } from "./WorkMemberAvatar";

export type WorkRosterMember = ReturnType<typeof useWorkTeamRoster>["roster"][number];

/** Who is on the task: the team member working it, else whoever it is assigned to. */
export function WorkTaskAssignee(props: {
  readonly task: Pick<ProjectWorkTaskRead, "assignee">;
  readonly worker: WorkRosterMember | undefined;
}) {
  const name = props.worker?.name ?? props.task.assignee?.displayName ?? null;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {props.worker ? (
        <WorkMemberAvatar member={props.worker} size="icon" />
      ) : name ? (
        <span
          aria-hidden="true"
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-semibold text-muted-foreground"
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/50"
        >
          <UserRoundIcon className="size-3 text-muted-foreground/70" />
        </span>
      )}
      <span className={cn("truncate", name === null && "text-muted-foreground/70")}>
        {name ?? "Unassigned"}
      </span>
    </span>
  );
}
