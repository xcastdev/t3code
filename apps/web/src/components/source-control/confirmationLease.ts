import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * Applies an already-authorized replacement token to form state. This is
 * deliberately pure so React may replay a state updater without changing the
 * confirmation lease a second time.
 */
export function updateConfirmationForm<Input extends { readonly approvalToken: number }>(
  current: Input,
  approvalToken: number,
  update: (current: Input) => Input,
): Input {
  return { ...update(current), approvalToken };
}

/**
 * Owns the one-shot authorization represented by a rendered confirmation
 * control. State is deliberately not the authority: React can retain a
 * handler after its dialog has disappeared. A later approval receives a new
 * token, so an old handler can neither consume nor revoke it.
 */
export function useConfirmationLease() {
  const nextTokenRef = useRef(0);
  const activeTokenRef = useRef<number | null>(null);
  const executingTokenRef = useRef<number | null>(null);
  // The lease is intentionally a tiny synchronous state machine rather than
  // React state. A confirmation callback can outlive the element that
  // rendered it, so the authority must survive (and reject) stale closures.
  //
  // idle -> pending -> executing -> settled -> idle
  //          ^              |
  //          |--------------+ (only after settlement)
  // A new pending approval may replace another pending approval, but it may
  // never replace an executing approval. That keeps a lane exclusively owned
  // by the promise that consumed it.
  const stateRef = useRef<"idle" | "pending" | "executing" | "settled">("idle");

  const nextToken = useCallback(() => ++nextTokenRef.current, []);

  const issue = useCallback(() => {
    if (stateRef.current === "executing") return null;
    const token = nextToken();
    activeTokenRef.current = token;
    stateRef.current = "pending";
    return token;
  }, [nextToken]);

  /** Replaces this exact pending approval; executing owners are never replaced. */
  const replace = useCallback(
    (token: number) => {
      if (stateRef.current !== "pending" || activeTokenRef.current !== token) return null;
      const replacement = nextToken();
      activeTokenRef.current = replacement;
      return replacement;
    },
    [nextToken],
  );

  const isCurrent = useCallback(
    (token: number) => activeTokenRef.current === token && stateRef.current === "pending",
    [],
  );

  const revoke = useCallback((token: number) => {
    // Dismissing a stale/pending dialog must not release another callback's
    // in-flight execution ownership.
    if (stateRef.current === "pending" && activeTokenRef.current === token) {
      activeTokenRef.current = null;
      stateRef.current = "idle";
    }
  }, []);

  /** Returns false for a cancelled, replaced, duplicate, or unmounted approval. */
  const consume = useCallback((token: number) => {
    if (stateRef.current !== "pending" || activeTokenRef.current !== token) return false;
    stateRef.current = "executing";
    activeTokenRef.current = null;
    executingTokenRef.current = token;
    return true;
  }, []);

  /** Releases the exact async operation that consumed this token. */
  const settle = useCallback((token: number) => {
    if (stateRef.current !== "executing") return;
    // An executing lease has no active token by design; its consumed token is
    // the owner identity, carried by the caller until its promise settles.
    // Keep it in a ref without making a new approval current.
    if (executingTokenRef.current !== token) return;
    stateRef.current = "settled";
    executingTokenRef.current = null;
  }, []);

  useEffect(
    () => () => {
      activeTokenRef.current = null;
      executingTokenRef.current = null;
      stateRef.current = "idle";
    },
    [],
  );

  return useMemo(
    () => ({ issue, replace, isCurrent, revoke, consume, settle }),
    [consume, isCurrent, issue, replace, revoke, settle],
  );
}
