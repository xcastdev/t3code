import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestStack,
  PullRequestMergeMethod,
} from "@t3tools/contracts";
import { GitMergeIcon, LayersIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { useAtomCommand } from "~/state/use-atom-command";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger, MenuItem, MenuGroup, MenuSeparator } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { PullRequestStackLayers } from "./PullRequestStackLayers";
import { PullRequestStackHeader } from "./PullRequestStackHeader";
import { usePullRequestMutationApproval } from "./pullRequestMutationApproval";

export function PullRequestStackMenu({
  stack,
  reference,
  environmentId: _environmentId,
  canMerge,
  canRebase,
  mergeMethod,
  onSelect,
  onActed,
  notice,
  onRetry,
}: {
  notice?: string | null;
  onRetry?: (() => void) | undefined;
  stack: PullRequestStack;
  reference: PullRequestRef;
  environmentId: EnvironmentId;
  canMerge: boolean;
  canRebase: boolean;
  mergeMethod: PullRequestMergeMethod;
  onSelect?: ((reference: PullRequestRef) => void) | undefined;
  onActed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const approval = usePullRequestMutationApproval();
  const top = stack.layers.at(-1);
  const unmerged = stack.layers.filter((layer) => layer.state !== "merged");
  const hasClosed = unmerged.some((layer) => layer.state !== "open");
  const position = stack.layers.findIndex((layer) => layer.number === reference.number) + 1;
  const mergeLayers = stack.layers.slice(0, position).filter((layer) => layer.state !== "merged");
  const selectedLayer = stack.layers[position - 1];
  const mergeHasClosed = mergeLayers.some((layer) => layer.state !== "open");
  const expectedStackHeads = unmerged.flatMap((layer) =>
    layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
  );
  const hasUnknownHead = expectedStackHeads.length !== unmerged.length;
  const mergeDisabled =
    pending ||
    selectedLayer?.state !== "open" ||
    mergeLayers.some((layer) => !layer.headSha) ||
    mergeHasClosed ||
    mergeLayers.length === 0 ||
    mergeLayers.some((layer) => layer.isDraft);
  const rebaseDisabled = pending || hasUnknownHead || hasClosed || unmerged.length === 0;
  const run = async (action: "merge" | "update-branch") => {
    if (
      pending ||
      approval === null ||
      !approval.available ||
      (action === "merge" ? !canMerge || mergeDisabled : !canRebase || rebaseDisabled)
    )
      return;
    const target = action === "merge" ? selectedLayer : top;
    if (!target?.headSha) return;
    const actionHeads = (action === "merge" ? mergeLayers : unmerged).flatMap((layer) =>
      layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
    );
    let failure = false;
    const completed = await approval.request({
      description:
        action === "merge"
          ? `Merges stack #${stack.number} through #${target.number} using ${mergeMethod}.`
          : `Rebases stack #${stack.number} through #${target.number}; this rewrites branch history.`,
      execute: async (scope) => {
        setPending(true);
        const result = await runAction({
          environmentId: scope.environmentId,
          input: {
            ...scope.reference,
            number: target.number,
            stackNumber: stack.number,
            expectedStackHeads: actionHeads,
            action,
            ...(action === "merge" ? { mergeMethod } : { updateMethod: "rebase" }),
          },
        });
        setPending(false);
        failure = result._tag === "Failure";
        return !failure;
      },
    });
    if (completed) onActed();
    if (failure) {
      toastManager.add({
        type: "error",
        title: "Stack operation did not complete",
        description: "The host refused the captured stack operation.",
      });
    } else if (!completed) {
      return;
    } else {
      toastManager.add({
        type: "success",
        title: action === "merge" ? "Stack merge request completed" : "Stack rebased",
        description:
          action === "merge"
            ? "GitHub merged the stack or added it to its merge queue."
            : undefined,
      });
    }
  };
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={`Stack ${stack.number}, layer ${position} of ${stack.layers.length}`}
                  />
                }
              >
                <LayersIcon aria-hidden className="size-3.5" /> {position}/{stack.layers.length}
                {onRetry ? <TriangleAlertIcon aria-hidden className="size-3 text-warning" /> : null}
              </MenuTrigger>
            }
          />
          <TooltipPopup>
            View stack #{stack.number}, layer {position} of {stack.layers.length}
            {notice ? ` · ${notice}` : null}
          </TooltipPopup>
        </Tooltip>
        <MenuPopup align="start" className="w-96 max-w-[calc(100vw-2rem)]">
          <MenuGroup>
            <PullRequestStackHeader number={stack.number} notice={notice} stale={!!onRetry} />
            {onRetry ? <MenuItem onClick={onRetry}>Retry stack refresh</MenuItem> : null}
            <PullRequestStackLayers
              stack={stack}
              reference={reference}
              pending={pending}
              onSelect={
                onSelect
                  ? (target) => {
                      setOpen(false);
                      onSelect(target);
                    }
                  : undefined
              }
            />
          </MenuGroup>
          {canMerge || canRebase ? (
            <>
              <MenuSeparator />
              {canMerge ? (
                <MenuItem disabled={mergeDisabled} onClick={() => void run("merge")}>
                  <GitMergeIcon aria-hidden />
                  Merge stack ({mergeLayers.length})
                </MenuItem>
              ) : null}
              {canRebase ? (
                <MenuItem disabled={rebaseDisabled} onClick={() => void run("update-branch")}>
                  <RefreshCwIcon aria-hidden />
                  Rebase stack
                </MenuItem>
              ) : null}
              {mergeHasClosed || mergeLayers.some((layer) => layer.isDraft) ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  Every layer being merged must be open and ready for review.
                </p>
              ) : null}
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      {canMerge && selectedLayer?.state === "open" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Button
                  variant="default"
                  size="xs"
                  disabled={mergeDisabled}
                  onClick={() => void run("merge")}
                >
                  <GitMergeIcon aria-hidden className="size-3.5" />
                  Merge stack
                </Button>
              </span>
            }
          />
          <TooltipPopup>
            Merge stack through #{reference.number} into {stack.base} ({mergeLayers.length}{" "}
            {mergeLayers.length === 1 ? "pull request" : "pull requests"})
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}
