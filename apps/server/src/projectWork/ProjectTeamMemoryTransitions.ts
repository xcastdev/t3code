import {
  canonicalProjectWorkPayload,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamRecord,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProjectWorkEvent, ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { validateProjectTeamRecord } from "./ProjectTeamFoundationRecords.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";

type Command = Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }>;
type Draft<T = ProjectWorkEvent> = T extends ProjectWorkEvent
  ? Omit<T, "eventId" | "projectId" | "revision">
  : never;
const decode = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand, {
  onExcessProperty: "error",
});
const decodeRecords = Schema.decodeUnknownSync(Schema.Array(ProjectTeamRecord), {
  onExcessProperty: "error",
});
const reject = (message: string): never => {
  throw new ProjectWorkPolicyError("authority-required", message);
};
const increment = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER)
    reject("Memory reflection revision exceeds safe integer budget");
  return value + 1;
};

/** Reflects verified original work; the SQL consumer proves the durable journal
 * and whole manifest before submitting this private, system-only transition.
 */
export const decideProjectTeamMemoryReflection = (
  initial: ProjectWorkReducerState,
  raw: Command,
  event: (draft: Draft, index: number) => ProjectWorkEvent,
  apply: (
    state: ProjectWorkReducerState,
    events: ReadonlyArray<ProjectWorkEvent>,
  ) => ProjectWorkReducerState,
): ReadonlyArray<ProjectWorkEvent> => {
  const command = decode(raw);
  const transition = command.transition;
  if (
    transition?.kind !== "memory.reflect" ||
    command.guided !== undefined ||
    command.claim !== undefined ||
    command.records.length !== 0 ||
    command.projectId !== initial.projectId ||
    command.expectedRevision !== initial.revision ||
    command.attribution.actor.kind !== "system" ||
    command.attribution.actor.id !== "project-memory-indexer" ||
    command.attribution.source.kind !== "system" ||
    command.attribution.source.id !== "project-memory-indexer"
  )
    return reject("Memory reflection requires its unmixed private system transition");
  const records = decodeRecords(initial.foundationRecords ?? []);
  const matches = records.filter((entry) => entry.recordId === transition.effectId);
  const effect = matches[0];
  if (
    matches.length !== 1 ||
    effect?.kind !== "effect" ||
    effect.effectId !== transition.effectId ||
    effect.projectId !== initial.projectId ||
    effect.revision !== transition.expectedEffectRevision ||
    effect.targetId !== transition.sourceId ||
    effect.payload.recordIds[0] !== transition.sourceId ||
    effect.payload.expectedRevision !== transition.sourceRevision ||
    effect.generation !== transition.sourceGeneration ||
    effect.status === "succeeded" ||
    effect.status === "failed" ||
    effect.status === "canceled" ||
    transition.claimGeneration === 0 ||
    (effect.sourceId !== undefined && effect.sourceId !== transition.sourceId) ||
    (effect.sourceGeneration !== undefined &&
      effect.sourceGeneration !== transition.sourceGeneration)
  )
    return reject("Memory reflection does not match its original effect");
  const outcome = {
    effectId: transition.effectId,
    claimGeneration: transition.claimGeneration,
    kind: transition.outcomeKind,
    sourceId: transition.sourceId,
    sourceRevision: transition.sourceRevision,
    sourceGeneration: transition.sourceGeneration,
    observationIds: transition.observationIds,
  };
  const sourceMatches = records.filter((entry) => entry.recordId === transition.sourceId);
  const source = sourceMatches[0];
  if (sourceMatches.length !== 1 || source?.kind !== "memory-source")
    return reject("Memory reflection requires its retained source");
  const changed: Array<ProjectTeamRecord> = [];
  if (transition.outcomeKind === "delete-source-complete") {
    if (
      effect.effectKind !== "memory-delete" ||
      effect.payload.recordIds.length !== 1 ||
      transition.observationIds.length !== 0 ||
      transition.expectedExtractionRevision !== undefined ||
      source.status === "current" ||
      source.projectId !== initial.projectId ||
      source.sourceRevision !== transition.sourceRevision ||
      source.generation < transition.sourceGeneration ||
      (effect.status !== "pending" && effect.claimGeneration !== transition.claimGeneration) ||
      (effect.status === "pending" && effect.claimGeneration !== 0)
    )
      return reject("Cleanup reflection cannot grant authority or revive a source");
  } else {
    const extractionMatches = records.filter(
      (entry) => entry.recordId === effect.payload.recordIds[1],
    );
    const extraction = extractionMatches[0];
    if (
      effect.effectKind !== "memory-index" ||
      effect.payload.recordIds.length !== 2 ||
      (effect.status !== "claimed" && effect.status !== "uncertain") ||
      effect.claimGeneration !== transition.claimGeneration ||
      source.projectId !== initial.projectId ||
      source.status !== "current" ||
      source.sourceRevision !== transition.sourceRevision ||
      source.generation !== transition.sourceGeneration ||
      extractionMatches.length !== 1 ||
      extraction?.kind !== "memory-extraction" ||
      extraction.projectId !== initial.projectId ||
      extraction.revision !== transition.expectedExtractionRevision ||
      extraction.sourceId !== source.recordId ||
      extraction.sourceRevision !== source.sourceRevision ||
      extraction.sourceGeneration !== source.generation ||
      extraction.generation !== source.generation ||
      extraction.extractionHash === undefined ||
      extraction.completedObservationIds.length !== 0 ||
      extraction.expectedObservationIds.length !== transition.observationIds.length ||
      extraction.expectedObservationIds.some((id) => !transition.observationIds.includes(id)) ||
      (transition.outcomeKind === "no-facts"
        ? extraction.status !== "no-facts" || transition.observationIds.length !== 0
        : extraction.status !== "extracted" || transition.observationIds.length === 0)
    )
      return reject("Memory reflection requires the exact current extraction and claim");
    const observations = records.filter(
      (entry) => entry.kind === "memory-observation" && entry.extractionId === extraction.recordId,
    );
    if (
      observations.length !== transition.observationIds.length ||
      new Set(observations.map((entry) => entry.recordId)).size !== observations.length ||
      observations.some(
        (entry) =>
          entry.kind !== "memory-observation" ||
          !transition.observationIds.includes(entry.recordId) ||
          entry.projectId !== initial.projectId ||
          entry.status !== "current" ||
          entry.sourceId !== source.recordId ||
          entry.sourceRevision !== source.sourceRevision ||
          entry.sourceGeneration !== source.generation ||
          entry.generation !== source.generation ||
          canonicalProjectWorkPayload(entry.provenance) !==
            canonicalProjectWorkPayload(source.attribution),
      )
    )
      return reject("Memory reflection observation provenance is incomplete");
    if (transition.outcomeKind === "index-complete")
      changed.push({
        ...extraction,
        status: "indexed",
        completedObservationIds: extraction.expectedObservationIds,
        revision: increment(extraction.revision),
        updatedAt: command.committedAt,
      });
  }
  changed.push({
    ...effect,
    status: "succeeded",
    outcome: canonicalProjectWorkPayload(outcome),
    revision: increment(effect.revision),
    updatedAt: command.committedAt,
  });
  if (
    !Number.isSafeInteger(initial.revision) ||
    initial.revision < 0 ||
    initial.revision > Number.MAX_SAFE_INTEGER - changed.length
  )
    return reject("Memory reflection batch exceeds safe integer budget");
  let state = initial;
  const events: Array<ProjectWorkEvent> = [];
  for (const input of changed) {
    const next = event(
      {
        type: "project-work.foundation.recorded",
        record: validateProjectTeamRecord(
          state,
          input,
          command.attribution,
          undefined,
          undefined,
          transition,
        ),
        occurredAt: command.committedAt,
      },
      events.length,
    );
    events.push(next);
    state = apply(state, [next]);
  }
  return events;
};
