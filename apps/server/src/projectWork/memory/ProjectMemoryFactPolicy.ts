import type { MemoryExtractionFact } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { MemorySourceTuple, ProjectMemoryError } from "./ProjectMemoryRepository.ts";
export const normalizedMemoryFactKey = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 8000);
export class ProjectMemoryFactPolicy extends Context.Service<
  ProjectMemoryFactPolicy,
  {
    readonly allowRecall?: (tuple: MemorySourceTuple) => Effect.Effect<boolean, ProjectMemoryError>;
    readonly forget?: (tuple: MemorySourceTuple) => Effect.Effect<void, ProjectMemoryError>;
    readonly filter: (
      tuple: MemorySourceTuple,
      facts: ReadonlyArray<MemoryExtractionFact>,
    ) => Effect.Effect<ReadonlyArray<MemoryExtractionFact>, ProjectMemoryError>;
  }
>()("t3/projectWork/memory/ProjectMemoryFactPolicy") {}
