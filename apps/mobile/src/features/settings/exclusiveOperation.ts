/**
 * Runs one operation at a time. The claim is taken synchronously, before React re-renders, so a
 * second press (or a Save while a Test is in flight) is refused rather than racing the first one
 * and releasing its lock when it finishes.
 */
export function createExclusiveOperation(onChange: (active: string | null) => void) {
  let active: string | null = null;
  return {
    active: () => active,
    run: async <A>(
      kind: string,
      operation: () => Promise<A>,
    ): Promise<{ readonly started: false } | { readonly started: true; readonly value: A }> => {
      if (active !== null) return { started: false };
      active = kind;
      onChange(kind);
      try {
        return { started: true, value: await operation() };
      } finally {
        active = null;
        onChange(null);
      }
    },
  };
}
