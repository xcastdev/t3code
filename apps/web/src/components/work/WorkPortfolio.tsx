import type { EnvironmentId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { WorkEmpty, WorkMeta, WorkRow, WorkSection } from "./WorkLayout";
import { WorkNotice } from "./WorkNotice";
import { useWorkRead } from "./useWorkRead";
import {
  bindingPhase,
  portfolioEntries,
  portfolioPage,
  SUPERVISION_UNAVAILABLE,
  supervisionCounts,
} from "./workPresentation";

export interface WorkPortfolioTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly taskId?: ProjectWorkTaskId;
}

/**
 * Every project's Work at a glance, qualified by environment and checkout.
 * Only the current page of projects mounts a summary read; paging replaces it.
 */
export function WorkPortfolio({
  onOpen,
}: {
  readonly onOpen: (target: WorkPortfolioTarget) => void;
}) {
  const projects = useProjects();
  const [pageIndex, setPageIndex] = useState(0);
  const page = portfolioPage(portfolioEntries(projects), pageIndex);
  return (
    <WorkSection title="All projects" description="Team Work across every connected environment.">
      {page.shown.length === 0 ? <WorkEmpty title="No projects yet" /> : null}
      {page.shown.map((entry) => (
        <PortfolioRow
          key={`${entry.environmentId}:${entry.projectId}`}
          environmentId={entry.environmentId}
          projectId={entry.projectId}
          title={entry.title}
          checkoutPath={entry.checkoutPath}
          onOpen={onOpen}
        />
      ))}
      {page.pageCount > 1 ? (
        <WorkRow className="flex-row items-center justify-between py-2">
          <WorkMeta className="tabular-nums">
            {page.first + 1}–{page.first + page.shown.length} of {page.total}
          </WorkMeta>
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              disabled={page.page === 0}
              onClick={() => setPageIndex(page.page - 1)}
            >
              Previous
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={page.page >= page.pageCount - 1}
              onClick={() => setPageIndex(page.page + 1)}
            >
              Next
            </Button>
          </div>
        </WorkRow>
      ) : null}
    </WorkSection>
  );
}

function PortfolioRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly checkoutPath: string;
  readonly onOpen: (target: WorkPortfolioTarget) => void;
}) {
  const { environmentId, projectId } = props;
  const environment = useEnvironment(environmentId);
  const view = useWorkRead(environmentId, { projectId, operation: "supervision" });
  const summary = view.special?.operation === "supervision" ? view.special.value : null;
  const available = summary !== null && summary.availability === "available" ? summary : null;
  const counts = available === null ? null : supervisionCounts(available);
  const running = available?.bindings.items.filter(
    (binding) => "taskId" in binding && bindingPhase(binding.status).live,
  ).length;
  const question = available?.questions.items.find((entry) => "taskId" in entry);
  return (
    <WorkRow className="gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 truncate rounded-sm text-left text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => props.onOpen({ environmentId, projectId })}
        >
          {props.title}
        </button>
        {environment ? <Badge variant="outline">{environment.label}</Badge> : null}
      </div>
      <WorkMeta className="truncate" title={props.checkoutPath}>
        {props.checkoutPath}
      </WorkMeta>
      {counts !== null ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span>
            <span className="tabular-nums">{counts.open + counts.active + counts.review}</span>{" "}
            <span className="text-muted-foreground">open</span>
          </span>
          <span>
            <span className="tabular-nums">{running}</span>{" "}
            <span className="text-muted-foreground">running</span>
          </span>
          {counts.blocked > 0 ? (
            <span className="text-destructive-foreground">
              <span className="tabular-nums">{counts.blocked}</span> blocked or failed
            </span>
          ) : null}
          {question && "taskId" in question ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                props.onOpen({
                  environmentId,
                  projectId,
                  taskId: question.taskId as ProjectWorkTaskId,
                })
              }
            >
              {available!.questions.items.length}
              {available!.questions.hasMore ? "+" : ""} waiting for you
            </Button>
          ) : null}
        </div>
      ) : summary !== null && summary.availability !== "available" ? (
        <WorkMeta>{SUPERVISION_UNAVAILABLE[summary.availability]}</WorkMeta>
      ) : (
        <WorkNotice view={view} subject="this project's Work" />
      )}
    </WorkRow>
  );
}
