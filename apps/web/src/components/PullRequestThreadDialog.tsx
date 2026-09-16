import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  readCachedPullRequestResolution,
  usePreparePullRequestThreadAction,
  usePullRequestResolution,
} from "~/lib/sourceControlActions";
import { cn } from "~/lib/utils";
import { parsePullRequestReference } from "~/pullRequestReference";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { reviewedGitSnapshotAvailability } from "./source-control/sourceControlActions.logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";

interface PullRequestThreadDialogProps {
  open: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | null;
  initialReference: string | null;
  onOpenChange: (open: boolean) => void;
  onPrepared: (input: { branch: string; worktreePath: string | null }) => Promise<void> | void;
}

export function PullRequestThreadDialog({
  open,
  environmentId,
  threadId,
  cwd,
  initialReference,
  onOpenChange,
  onPrepared,
}: PullRequestThreadDialogProps) {
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState(initialReference ?? "");
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [preparingMode, setPreparingMode] = useState<"local" | "worktree" | null>(null);
  const [checkoutApproval, setCheckoutApproval] = useState<{
    readonly mode: "local" | "worktree";
    readonly reference: string;
    readonly source: {
      readonly refName: string | null;
      readonly headCommit: string | null;
      readonly indexTree: string;
    };
    readonly scopeKey: string;
  } | null>(null);
  // React can retain a button callback for an event turn after its dialog has gone away.
  // State controls what is visible; this lease controls whether that exact callback is still
  // authorized to prepare a checkout.
  const checkoutApprovalRef = useRef<typeof checkoutApproval>(null);
  const dialogOpenRef = useRef(open);
  const mountedRef = useRef(true);
  const [debouncedReference, referenceDebouncer] = useDebouncedValue(
    reference,
    { wait: 450 },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const gitStatusQuery = useEnvironmentQuery(
    cwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd },
        }),
  );
  const gitStatus = gitStatusQuery.data;
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(gitStatus?.sourceControlProvider),
    [gitStatus?.sourceControlProvider],
  );
  const terminology = sourceControlPresentation.terminology;
  const SourceControlIcon = sourceControlPresentation.Icon;

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      referenceInputRef.current?.focus();
      referenceInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const parsedReference = parsePullRequestReference(reference);
  const parsedDebouncedReference = parsePullRequestReference(debouncedReference);
  const sourceControlScope = useMemo(
    () => ({
      environmentId,
      cwd,
    }),
    [cwd, environmentId],
  );
  const pullRequestResolution = usePullRequestResolution({
    ...sourceControlScope,
    reference: open ? parsedDebouncedReference : null,
  });
  const cachedPullRequest = useMemo(() => {
    return (
      readCachedPullRequestResolution({
        ...sourceControlScope,
        reference: parsedReference,
      })?.pullRequest ?? null
    );
  }, [parsedReference, sourceControlScope]);
  const preparePullRequestThreadAction = usePreparePullRequestThreadAction(sourceControlScope);

  const liveResolvedPullRequest =
    parsedReference !== null && parsedReference === parsedDebouncedReference
      ? (pullRequestResolution.data?.pullRequest ?? null)
      : null;
  const resolvedPullRequest = liveResolvedPullRequest ?? cachedPullRequest;
  const reviewedSnapshot = useMemo(
    () =>
      reviewedGitSnapshotAvailability({
        status: gitStatus,
        isPending: gitStatusQuery.isPending,
        hasError: gitStatusQuery.error !== null,
      }),
    [gitStatus, gitStatusQuery.error, gitStatusQuery.isPending],
  );
  const checkoutScope = useMemo(() => {
    if (!cwd || !parsedReference || !resolvedPullRequest || !reviewedSnapshot.available)
      return null;
    const source = {
      refName: gitStatus?.refName ?? null,
      headCommit: gitStatus?.headCommit ?? null,
      indexTree: gitStatus?.indexTree ?? "",
    };
    return {
      reference: parsedReference,
      source,
      scopeKey: JSON.stringify([environmentId, cwd, parsedReference, resolvedPullRequest, source]),
    };
  }, [
    cwd,
    environmentId,
    gitStatus,
    parsedReference,
    resolvedPullRequest,
    reviewedSnapshot.available,
  ]);
  const checkoutScopeKeyRef = useRef<string | null>(checkoutScope?.scopeKey ?? null);
  useLayoutEffect(() => {
    checkoutScopeKeyRef.current = checkoutScope?.scopeKey ?? null;
    const pending = checkoutApprovalRef.current;
    if (pending !== null && pending.scopeKey !== checkoutScope?.scopeKey) {
      checkoutApprovalRef.current = null;
      setCheckoutApproval(null);
    }
  }, [checkoutScope?.scopeKey]);
  useLayoutEffect(() => {
    dialogOpenRef.current = open;
    if (!open && checkoutApprovalRef.current !== null) {
      checkoutApprovalRef.current = null;
      setCheckoutApproval(null);
    }
  }, [open]);
  useLayoutEffect(
    () => () => {
      mountedRef.current = false;
      dialogOpenRef.current = false;
      checkoutApprovalRef.current = null;
    },
    [],
  );
  // A stale retained approval stays inert in state but is never displayed or reusable. This
  // avoids a reset render while a status query is settling and makes the next press a fresh review.
  const activeCheckoutApproval =
    checkoutApproval?.scopeKey === checkoutScope?.scopeKey ? checkoutApproval : null;
  const isResolving =
    open &&
    parsedReference !== null &&
    resolvedPullRequest === null &&
    (referenceDebouncer.state.isPending ||
      parsedReference !== parsedDebouncedReference ||
      pullRequestResolution.isPending ||
      pullRequestResolution.isFetching);
  const statusTone = useMemo(() => {
    switch (resolvedPullRequest?.state) {
      case "merged":
        return "text-violet-600 dark:text-violet-300/90";
      case "closed":
        return "text-zinc-500 dark:text-zinc-400/80";
      case "open":
        return "text-emerald-600 dark:text-emerald-300/90";
      default:
        return "text-muted-foreground";
    }
  }, [resolvedPullRequest?.state]);

  const requestCheckout = useCallback(
    (mode: "local" | "worktree") => {
      if (!dialogOpenRef.current || checkoutScope === null || checkoutApprovalRef.current !== null)
        return;
      const approval = { mode, ...checkoutScope };
      checkoutApprovalRef.current = approval;
      setCheckoutApproval(approval);
    },
    [checkoutScope],
  );

  const handleConfirm = useCallback(
    async (mode: "local" | "worktree") => {
      if (!parsedReference) {
        setReferenceDirty(true);
        return;
      }
      if (
        !mountedRef.current ||
        !dialogOpenRef.current ||
        !parsedReference ||
        !resolvedPullRequest ||
        !cwd ||
        activeCheckoutApproval === null ||
        activeCheckoutApproval.mode !== mode ||
        activeCheckoutApproval.reference !== parsedReference ||
        checkoutApprovalRef.current !== activeCheckoutApproval ||
        activeCheckoutApproval.scopeKey !== checkoutScopeKeyRef.current
      ) {
        return;
      }
      // Consume this exact lease before awaiting. Cancel, close, unmount, duplicate confirms,
      // and callbacks retained from a replaced dialog therefore have no authority to start RPC.
      checkoutApprovalRef.current = null;
      setCheckoutApproval(null);
      setPreparingMode(mode);
      const result = await preparePullRequestThreadAction.run({
        reference: activeCheckoutApproval.reference,
        mode,
        ...(mode === "worktree" ? { threadId } : {}),
        precondition: {
          expectedHeadCommit: activeCheckoutApproval.source.headCommit,
          expectedIndexTree: activeCheckoutApproval.source.indexTree,
          expectedRefName: activeCheckoutApproval.source.refName,
        },
      });
      setPreparingMode(null);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          preparePullRequestThreadAction.resetError();
        }
        return;
      }
      if (!mountedRef.current || !dialogOpenRef.current) return;
      await onPrepared({
        branch: result.value.branch,
        worktreePath: result.value.worktreePath,
      });
      onOpenChange(false);
    },
    [
      activeCheckoutApproval,
      cwd,
      onOpenChange,
      onPrepared,
      parsedReference,
      preparePullRequestThreadAction,
      resolvedPullRequest,
      threadId,
    ],
  );

  const validationMessage = !referenceDirty
    ? null
    : reference.trim().length === 0
      ? `Paste a ${terminology.singular} URL, checkout command, or enter 123 / #123.`
      : parsedReference === null
        ? `Use a ${terminology.singular} URL, checkout command, 123, or #123.`
        : null;
  const errorMessage =
    validationMessage ??
    (resolvedPullRequest === null && pullRequestResolution.error
      ? pullRequestResolution.error
      : preparePullRequestThreadAction.error instanceof Error
        ? preparePullRequestThreadAction.error.message
        : preparePullRequestThreadAction.error
          ? `Failed to prepare ${terminology.singular} thread.`
          : null);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!preparePullRequestThreadAction.isPending) {
          if (!nextOpen) {
            checkoutApprovalRef.current = null;
            setCheckoutApproval(null);
          }
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SourceControlIcon className="size-4" />
            Checkout {terminology.singular}
          </DialogTitle>
          <DialogDescription>
            Resolve a {sourceControlPresentation.providerName} {terminology.singular}, then create
            the draft thread in the main repo or in a dedicated worktree.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground capitalize">
              {terminology.singular}
            </span>
            <Input
              ref={referenceInputRef}
              placeholder={`${terminology.shortLabel} URL, checkout command, or #42`}
              value={reference}
              onChange={(event) => {
                setReferenceDirty(true);
                setReference(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }
                event.preventDefault();
                if (!isResolving && !preparePullRequestThreadAction.isPending) {
                  requestCheckout("local");
                }
              }}
            />
          </label>

          {resolvedPullRequest ? (
            <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-sm">{resolvedPullRequest.title}</p>
                  <p className="truncate text-muted-foreground text-xs">
                    #{resolvedPullRequest.number} · {resolvedPullRequest.headBranch} to{" "}
                    {resolvedPullRequest.baseBranch}
                  </p>
                </div>
                <span className={cn("shrink-0 text-xs capitalize", statusTone)}>
                  {resolvedPullRequest.state}
                </span>
              </div>
            </div>
          ) : null}

          {isResolving ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner className="size-3.5" />
              Resolving {terminology.singular}...
            </div>
          ) : null}

          {errorMessage ? <p className="text-destructive text-xs">{errorMessage}</p> : null}
          {activeCheckoutApproval ? (
            <p className="rounded-lg border border-border/70 bg-muted/24 p-2 text-muted-foreground text-xs">
              Review checkout: environment {environmentId}; repository {cwd}; source{" "}
              {activeCheckoutApproval.source.refName ?? "detached HEAD"} at{" "}
              {activeCheckoutApproval.source.headCommit ?? "no commit"}; index{" "}
              {activeCheckoutApproval.source.indexTree};{" "}
              {activeCheckoutApproval.mode === "local" ? "local repository" : "separate worktree"};{" "}
              {activeCheckoutApproval.reference}.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (activeCheckoutApproval === null) {
                checkoutApprovalRef.current = null;
                onOpenChange(false);
                return;
              }
              if (checkoutApprovalRef.current === activeCheckoutApproval)
                checkoutApprovalRef.current = null;
              setCheckoutApproval(null);
            }}
            disabled={preparePullRequestThreadAction.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              if (activeCheckoutApproval?.mode === "local") void handleConfirm("local");
              else requestCheckout("local");
            }}
            disabled={
              !cwd ||
              !resolvedPullRequest ||
              isResolving ||
              preparePullRequestThreadAction.isPending ||
              !reviewedSnapshot.available
            }
          >
            {preparingMode === "local"
              ? "Preparing local..."
              : activeCheckoutApproval?.mode === "local"
                ? "Confirm local"
                : "Local"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              if (activeCheckoutApproval?.mode === "worktree") void handleConfirm("worktree");
              else requestCheckout("worktree");
            }}
            disabled={
              !cwd ||
              !resolvedPullRequest ||
              isResolving ||
              preparePullRequestThreadAction.isPending ||
              !reviewedSnapshot.available
            }
          >
            {preparingMode === "worktree"
              ? "Preparing worktree..."
              : activeCheckoutApproval?.mode === "worktree"
                ? "Confirm worktree"
                : "Worktree"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
