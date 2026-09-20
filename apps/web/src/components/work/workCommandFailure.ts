export interface ProjectWorkCommandFailure {
  readonly raw: unknown;
  readonly message: string;
  readonly staleRevision: boolean;
  readonly currentRevision: number | null;
  readonly changedFields: ReadonlyArray<string>;
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

/** Only the server's explicit policy code is safe to treat as a revision conflict. */
export function projectWorkCommandFailure(raw: unknown): ProjectWorkCommandFailure {
  const record = recordOf(raw);
  const details = recordOf(record?.details);
  const changedFields = Array.isArray(details?.changedFields)
    ? details.changedFields.filter((field): field is string => typeof field === "string")
    : [];
  const currentRevision =
    typeof details?.currentRevision === "number" ? details.currentRevision : null;
  const message =
    raw instanceof Error
      ? raw.message
      : typeof record?.message === "string"
        ? record.message
        : typeof raw === "string"
          ? raw
          : "The write may not have completed. Retry the exact command or discard it.";
  return {
    raw,
    message,
    staleRevision: record?.code === "stale-revision",
    currentRevision,
    changedFields,
  };
}
