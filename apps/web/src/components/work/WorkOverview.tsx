import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { ArrowRightIcon, BookOpenIcon, ListTodoIcon } from "lucide-react";
import { useCallback } from "react";

import { asProjectWorkBriefing } from "@t3tools/client-runtime/project-work";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { projectWorkEnvironment } from "../../state/projectWork";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Button } from "../ui/button";
import { WorkCard, WorkDataNotice } from "./WorkDataNotice";
import { WorkSectionHeader } from "./WorkLayout";
import { type WorkTab, workReadStatus } from "./workPresentation";

export function WorkOverview({
  environmentId,
  projectId,
  connected,
  streamAvailable: _streamAvailable = false,
  onOpenSection,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  readonly streamAvailable?: boolean;
  readonly onOpenSection?: (tab: WorkTab) => void;
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
          <WorkCard className="p-5">
            <WorkSectionHeader
              title="What matters in this project"
              status={`Current brief · Revision ${briefing.sourceRevision}`}
            />
            <p className="mt-4 max-w-3xl whitespace-pre-wrap text-sm leading-6 text-foreground/85">
              {briefing.narrative ?? briefing.text}
            </p>
            {briefing.omittedReasons.length > 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Bounded brief: {briefing.omittedReasons.join(" · ")}
              </p>
            ) : null}
          </WorkCard>

          <div className="grid gap-3 sm:grid-cols-2">
            <SummaryCard
              icon={<ListTodoIcon />}
              label="Tasks in this brief"
              value={briefing.includedTaskIds.length}
              {...(onOpenSection ? { onOpen: () => onOpenSection("tasks") } : {})}
              action="Open tasks"
            />
            <SummaryCard
              icon={<BookOpenIcon />}
              label="Knowledge in this brief"
              value={briefing.includedKnowledgeIds.length}
              {...(onOpenSection ? { onOpen: () => onOpenSection("knowledge") } : {})}
              action="Open knowledge"
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
  action,
  onOpen,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: number;
  readonly action: string;
  readonly onOpen?: () => void;
}) {
  return (
    <WorkCard className="flex items-center gap-3 p-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <span className="block text-lg font-semibold tabular-nums">{value}</span>
      </span>
      {onOpen ? (
        <Button size="xs" variant="ghost" onClick={onOpen}>
          {action}
          <ArrowRightIcon aria-hidden />
        </Button>
      ) : null}
    </WorkCard>
  );
}
