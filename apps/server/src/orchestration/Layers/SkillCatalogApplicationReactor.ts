import { CommandId, SkillCatalogRevision } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import { SkillCatalogService } from "../../skills/SkillCatalogService.ts";
import type { SkillCatalogChanged } from "@t3tools/contracts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  SkillCatalogApplicationReactor,
  type SkillCatalogApplicationReactorShape,
} from "../Services/SkillCatalogApplicationReactor.ts";

const make = Effect.gen(function* () {
  const catalog = yield* SkillCatalogService;
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;

  const worker = yield* makeDrainableWorker((change: SkillCatalogChanged) =>
    Effect.gen(function* () {
      const model = yield* projections.getCommandReadModel();
      const projects = new Map(model.projects.map((project) => [project.id, project]));
      const affected = model.threads.filter((thread) => {
        if (thread.deletedAt !== null || thread.session?.providerInstanceId === undefined) {
          return false;
        }
        if (change.scope === "global") return true;
        if (change.scope === "project") return thread.projectId === change.scopeId;
        if (change.scope === "provider")
          return thread.session.providerInstanceId === change.scopeId;
        return thread.id === change.scopeId;
      });

      yield* Effect.forEach(
        affected,
        (thread) =>
          Effect.gen(function* () {
            const providerInstanceId = thread.session!.providerInstanceId!;
            const current = (model.skillApplications ?? []).find(
              (application) =>
                application.threadId === thread.id &&
                application.providerInstanceId === providerInstanceId,
            );
            const desiredRevision = SkillCatalogRevision.make((current?.desiredRevision ?? 0) + 1);
            const project = projects.get(thread.projectId);
            if (project === undefined) return;
            const cwd = thread.worktreePath ?? project.workspaceRoot;
            const application = yield* catalog.describeSession({
              threadId: thread.id,
              providerInstanceId,
              projectRoot: cwd,
              projectId: project.id,
              cwd,
              desiredRevision,
              appliedRevision: current?.appliedRevision ?? SkillCatalogRevision.make(0),
            });
            const updatedAt = DateTime.formatIso(yield* DateTime.now);
            yield* engine.dispatch({
              type: "thread.skill-application.desire",
              commandId: CommandId.make(
                `server:skill-catalog-change:${thread.id}:${providerInstanceId}:${desiredRevision}`,
              ),
              threadId: thread.id,
              application,
              updatedAt,
            });
          }),
        { concurrency: 1, discard: true },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("skill catalog application reactor failed to process change", {
              scope: change.scope,
              scopeId: change.scopeId,
              revision: change.catalogRevision,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const start: SkillCatalogApplicationReactorShape["start"] = () =>
    Effect.gen(function* () {
      yield* forkParked(Stream.runForEach(catalog.changes, worker.enqueue));
      // Restored threads need watches even when no client opens Settings.
      yield* worker.enqueue({
        scope: "global",
        scopeId: "global",
        catalogRevision: yield* catalog.currentRevision,
        changedKeys: [],
      });
    });
  return { start, drain: worker.drain } satisfies SkillCatalogApplicationReactorShape;
});

export const SkillCatalogApplicationReactorLive = Layer.effect(
  SkillCatalogApplicationReactor,
  make,
);
