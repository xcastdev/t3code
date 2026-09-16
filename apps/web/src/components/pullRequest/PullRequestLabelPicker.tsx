/**
 * Putting a label on, and taking one off, from the row that says which it already wears.
 *
 * The repository's labels are read only once this menu opens, for the reason the reviewer menu
 * reads its people then: they are worth a request when somebody wants them and worth nothing on
 * every pull request they merely open.
 */
import type { EnvironmentId, PullRequestLabelCandidate, PullRequestRef } from "@t3tools/contracts";
import { CheckIcon, TagIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import { pullRequestLabelColor } from "./pullRequestList.logic";
import { usePullRequestMutationApproval } from "./pullRequestMutationApproval";

/** Narrows only what arrived: the host is asked once, when the menu opens. */
function matches(candidate: PullRequestLabelCandidate, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return (
    candidate.name.toLowerCase().includes(needle) ||
    (candidate.description ?? "").toLowerCase().includes(needle)
  );
}

export function PullRequestLabelPicker({
  environmentId,
  reference,
  allowed,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  /** False where the host would refuse this account's change. Disabled with the reason rather
   * than hidden, like the reviewer control beside it. */
  allowed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  // Mounted with the menu closed, so nothing is asked of the host until it opens.
  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.labelCandidates({ environmentId, input: reference }) : null,
  );
  const setLabels = useAtomCommand(pullRequestEnvironment.setLabels, { reportFailure: false });
  const approval = usePullRequestMutationApproval();

  const candidates = useMemo(
    () => (candidatesQuery.data?.candidates ?? []).filter((entry) => matches(entry, query)),
    [candidatesQuery.data, query],
  );

  const toggle = async (candidate: PullRequestLabelCandidate) => {
    if (pending !== null) return;
    if (approval === null || !approval.available) return;
    setPending(candidate.name);
    let failure = false;
    await approval.request({
      description: `${candidate.isApplied ? "Removes" : "Applies"} label “${candidate.name}” on #${reference.number}.`,
      execute: async (scope) => {
        const result = await setLabels({
          environmentId: scope.environmentId,
          input: {
            ...scope.reference,
            labels: [candidate.name],
            applied: !candidate.isApplied,
          },
        });
        failure = result._tag === "Failure";
        return !failure;
      },
    });
    setPending(null);
    if (failure) {
      toastManager.add({
        type: "error",
        title: candidate.isApplied
          ? `Could not take ${candidate.name} off`
          : `Could not put ${candidate.name} on`,
        description: "The host refused it. Check that you have triage access on this repository.",
      });
      return;
    }
  };

  return (
    <PullRequestCandidatePicker
      icon={<TagIcon className="size-3.5" />}
      label="Change labels"
      allowed={allowed}
      disabledReason="Changing labels needs triage access on this repository"
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      searchLabel="Search labels"
      isPending={candidatesQuery.isPending && candidatesQuery.data === null}
      error={candidatesQuery.data === null ? candidatesQuery.error : null}
      candidates={candidates}
      emptyLabel="This repository has no labels."
      noMatchLabel="No label matches that."
      errorLabel="The labels could not be read."
      truncated={candidatesQuery.data?.truncated === true}
      truncatedLabel="This repository has more labels than are listed here. Apply the rest on the host."
      candidateKey={(candidate) => candidate.name}
      disabled={pending !== null}
      onSelect={(candidate) => void toggle(candidate)}
    >
      {(candidate) => {
        const dot = pullRequestLabelColor(candidate.color);
        return (
          <>
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-muted-foreground"
              {...(dot ? { style: { backgroundColor: dot } } : {})}
            />
            <span className="min-w-0 flex-1 truncate">
              {candidate.name}
              {candidate.description ? (
                <span className="text-muted-foreground"> · {candidate.description}</span>
              ) : null}
            </span>
            {candidate.isApplied ? (
              <CheckIcon aria-label="Applied" className="size-3.5 shrink-0" />
            ) : null}
          </>
        );
      }}
    </PullRequestCandidatePicker>
  );
}
