import {
  ProjectTeamIntegrationSourcePage,
  canonicalProjectWorkPayload,
  type EnvironmentId,
  type ProjectId,
  type ProjectWorkTaskId,
  type ProjectTeamIntegrationSourceRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useLayoutEffect, useRef, useState } from "react";
import { projectWorkEnvironment } from "../../state/projectWork";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Button } from "../ui/button";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly taskId: ProjectWorkTaskId;
  readonly revision: number;
  readonly taskRevision: number;
  readonly disabled: boolean;
  readonly selected: readonly ProjectTeamIntegrationSourceRef[];
  readonly onChange: (selected: readonly ProjectTeamIntegrationSourceRef[]) => void;
}
const decodePage = Schema.decodeUnknownSync(ProjectTeamIntegrationSourcePage);
const equal = (a: unknown, b: unknown) =>
  canonicalProjectWorkPayload(a) === canonicalProjectWorkPayload(b);

/** A retained selection contains expected identities; the host qualifies it again on proposal. */
export function IntegrationSources(props: Props) {
  const owner = canonicalProjectWorkPayload({
    environmentId: props.environmentId,
    projectId: props.projectId,
    taskId: props.taskId,
    revision: props.revision,
    taskRevision: props.taskRevision,
  });
  return <IntegrationSourcePicker key={owner} {...props} />;
}
function IntegrationSourcePicker(props: Props) {
  const read = useAtomQueryRunner(projectWorkEnvironment.integrationSources, {
    refresh: true,
    reportFailure: false,
  });
  const [page, setPage] = useState<typeof ProjectTeamIntegrationSourcePage.Type | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const live = useRef(props);
  const version = useRef(0);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    live.current = props;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      version.current++;
    };
  }, []);
  async function load(offset: number) {
    if (live.current.disabled || loading) return;
    const before = live.current;
    const request = ++version.current;
    setLoading(true);
    setNotice(null);
    try {
      const result = await read({
        environmentId: before.environmentId,
        projectId: before.projectId,
        taskId: before.taskId,
        offset,
      });
      if (!mounted.current || request !== version.current) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const next = decodePage(result.value);
      const current = live.current;
      if (
        current.disabled ||
        next.environmentId !== current.environmentId ||
        next.projectId !== current.projectId ||
        next.taskId !== current.taskId ||
        next.revision !== current.revision ||
        next.taskRevision !== current.taskRevision
      )
        throw new Error("Work changed. Refresh the task and load reviewed sources again.");
      setPage(next);
    } catch (error) {
      if (mounted.current && request === version.current) {
        setPage(null);
        setNotice(
          error instanceof Error
            ? error.message
            : "Reviewed sources are unavailable. Refresh and try again.",
        );
      }
    } finally {
      if (mounted.current && request === version.current) setLoading(false);
    }
  }
  return (
    <fieldset className="space-y-3" disabled={props.disabled}>
      <legend className="text-sm font-medium">Integration sources</legend>
      <p className="text-xs text-muted-foreground">
        For integration work, select reviewed task commits in the order to combine them. Propose the
        plan, then approve its frozen list. A changed source requires a new selection and approval.
      </p>
      {props.selected.length > 0 && (
        <ol className="space-y-2">
          {props.selected.map((ref, index) => (
            <li key={ref.taskId} className="rounded border border-border p-2 text-xs">
              <p>
                {index + 1}. Task {ref.taskId}
              </p>
              <p className="break-all font-mono">{ref.expectedBranchRef}</p>
              <p className="break-all font-mono">Commit {ref.expectedHeadSha}</p>
              <p className="break-all font-mono text-muted-foreground">
                Base {ref.expectedBaseSha}
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={index === 0}
                  onClick={() => {
                    if (live.current.disabled) return;
                    const next = [...props.selected];
                    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                    props.onChange(next);
                  }}
                >
                  Move earlier
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (!live.current.disabled)
                      props.onChange(
                        props.selected.filter((source) => source.taskId !== ref.taskId),
                      );
                  }}
                >
                  Remove source
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <Button size="sm" variant="outline" disabled={loading} onClick={() => void load(0)}>
        {loading ? "Loading sources…" : "Load reviewed sources"}
      </Button>
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {page && (
        <div className="space-y-2">
          {page.candidates.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No eligible reviewed sources on this page.
            </p>
          )}
          {page.candidates.map((candidate) => {
            const existing = props.selected.find((ref) => ref.taskId === candidate.ref.taskId);
            return (
              <div key={candidate.ref.taskId} className="rounded border border-border p-2 text-xs">
                <p className="font-medium">{candidate.taskTitle}</p>
                <p className="break-all font-mono">{candidate.source.branchRef}</p>
                <p className="break-all font-mono">{candidate.source.headSha}</p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    Boolean(existing && equal(existing, candidate.ref)) ||
                    (!existing && props.selected.length >= 64)
                  }
                  onClick={() => {
                    if (!live.current.disabled)
                      props.onChange(
                        existing
                          ? props.selected.map((ref) =>
                              ref.taskId === candidate.ref.taskId ? candidate.ref : ref,
                            )
                          : [...props.selected, candidate.ref],
                      );
                  }}
                >
                  {existing
                    ? equal(existing, candidate.ref)
                      ? "Selected"
                      : "Replace changed source"
                    : "Select source"}
                </Button>
              </div>
            );
          })}
          {page.hasMore && (
            <Button
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void load(page.nextOffset)}
            >
              Next sources
            </Button>
          )}
        </div>
      )}
    </fieldset>
  );
}
