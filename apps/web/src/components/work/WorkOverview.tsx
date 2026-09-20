import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { AlertTriangleIcon, BookOpenIcon, ListTodoIcon } from "lucide-react";
import { useCallback } from "react";

import { asProjectWorkBriefing } from "@t3tools/client-runtime/project-work";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { projectWorkEnvironment } from "../../state/projectWork";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { WorkCard, WorkDataNotice } from "./WorkDataNotice";
import { workReadStatus } from "./workPresentation";

export function WorkOverview({
  environmentId,
  projectId,
  connected,
  streamAvailable: _streamAvailable = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  readonly streamAvailable?: boolean;
}) {
  const briefingAtom = projectWorkEnvironment.briefing({
    environmentId,
    projectId,
    ...(_streamAvailable ? { poll: false } : {}),
  });
  const result = useAtomValue(briefingAtom);
  const briefing = asProjectWorkBriefing(Option.getOrNull(AsyncResult.value(result)));
  const runBriefing = useAtomQueryRunner(projectWorkEnvironment.briefing, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const status = workReadStatus({ connected, hasValue: briefing !== null });
  const error = result._tag === "Failure" ? String(squashAtomCommandFailure(result)) : null;
  const retryBriefing = useCallback(
    () =>
      void runBriefing({ environmentId, projectId, ...(_streamAvailable ? { poll: false } : {}) }),
    [environmentId, projectId, runBriefing, _streamAvailable],
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <WorkDataNotice
        stale={status === "stale"}
        waiting={status === "waiting"}
        offline={!connected}
        error={error}
        onRetry={retryBriefing}
      />
      {briefing ? (
        <>
          <WorkCard>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Current brief
                </p>
                <h2 className="mt-1 text-lg font-semibold">What matters in this project</h2>
              </div>
              <span className="text-xs text-muted-foreground">
                Revision {briefing.sourceRevision}
              </span>
            </div>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-foreground/85">
              {briefing.narrative ?? briefing.text}
            </p>
            {briefing.omittedReasons.length > 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Bounded brief: {briefing.omittedReasons.join(" · ")}
              </p>
            ) : null}
          </WorkCard>

          <div className="grid gap-4 sm:grid-cols-3">
            <SummaryCard
              icon={<ListTodoIcon />}
              label="Tasks"
              value={briefing.includedTaskIds.length}
            />
            <SummaryCard
              icon={<BookOpenIcon />}
              label="Knowledge"
              value={briefing.includedKnowledgeIds.length}
            />
            <SummaryCard
              icon={<AlertTriangleIcon />}
              label="Source revision"
              value={briefing.sourceRevision}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: number;
}) {
  return (
    <WorkCard className="flex items-center gap-3 p-3">
      <span className="flex size-8 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span>
        <span className="block text-xs text-muted-foreground">{label}</span>
        <span className="block text-lg font-semibold tabular-nums">{value}</span>
      </span>
    </WorkCard>
  );
}
