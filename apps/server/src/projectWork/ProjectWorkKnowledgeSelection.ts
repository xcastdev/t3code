import type { ProjectWorkKnowledge } from "@t3tools/contracts";

export const PROJECT_WORK_KNOWLEDGE_CLOSURE_LIMIT = 256;

/** Validate the complete same-project closure before any display ordering or truncation. */
export const selectCurrentProjectWorkKnowledge = (input: {
  readonly projectId: string;
  readonly records: readonly ProjectWorkKnowledge[];
  readonly complete: boolean;
}) => {
  const empty: readonly ProjectWorkKnowledge[] = [];
  const degraded = (reason: string) => ({
    status: "degraded" as const,
    records: empty,
    reason,
  });
  const { projectId, records, complete } = input;
  if (!complete || records.length > PROJECT_WORK_KNOWLEDGE_CLOSURE_LIMIT)
    return degraded("knowledge-closure-bound");
  const byId = new Map(records.map((record) => [record.knowledgeId, record]));
  if (byId.size !== records.length || records.some((record) => record.projectId !== projectId))
    return degraded("knowledge-closure-invalid");
  const replacements = new Map<string, string>();
  for (const record of records) {
    const previous = record.supersedesKnowledgeId;
    if (previous === undefined) continue;
    if (previous === record.knowledgeId || !byId.has(previous) || replacements.has(previous))
      return degraded("knowledge-closure-invalid");
    replacements.set(previous, record.knowledgeId);
  }
  for (const record of records) {
    const seen = new Set<string>();
    let id: string | undefined = record.knowledgeId;
    while (id !== undefined) {
      if (seen.has(id)) return degraded("knowledge-closure-invalid");
      seen.add(id);
      id = replacements.get(id);
    }
  }
  return {
    status: "available" as const,
    records: records
      .filter((record) => !replacements.has(record.knowledgeId))
      .toSorted((a, b) => a.knowledgeId.localeCompare(b.knowledgeId)),
  };
};
