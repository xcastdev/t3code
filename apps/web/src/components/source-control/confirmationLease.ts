import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * Owns the one-shot authorization represented by a rendered confirmation
 * control. State is deliberately not the authority: React can retain a
 * handler after its dialog has disappeared. A later approval receives a new
 * token, so an old handler can neither consume nor revoke it.
 */
export function useConfirmationLease() {
  const nextTokenRef = useRef(0);
  const activeTokenRef = useRef<number | null>(null);
  const executingRef = useRef(false);

  const issue = useCallback(() => {
    const token = ++nextTokenRef.current;
    activeTokenRef.current = token;
    executingRef.current = false;
    return token;
  }, []);

  const isCurrent = useCallback(
    (token: number) => activeTokenRef.current === token && !executingRef.current,
    [],
  );

  const revoke = useCallback((token: number) => {
    if (activeTokenRef.current === token) {
      activeTokenRef.current = null;
      executingRef.current = false;
    }
  }, []);

  /** Returns false for a cancelled, replaced, duplicate, or unmounted approval. */
  const consume = useCallback((token: number) => {
    if (activeTokenRef.current !== token || executingRef.current) return false;
    executingRef.current = true;
    activeTokenRef.current = null;
    return true;
  }, []);

  useEffect(
    () => () => {
      activeTokenRef.current = null;
      executingRef.current = false;
    },
    [],
  );

  return useMemo(
    () => ({ issue, isCurrent, revoke, consume }),
    [consume, isCurrent, issue, revoke],
  );
}
