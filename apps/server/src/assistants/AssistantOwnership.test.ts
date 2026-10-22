import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Repository from "./AssistantRepository.ts";
import * as Ownership from "./AssistantOwnership.ts";
import { input, environmentId, repository } from "./AssistantTestHelpers.ts";

it.effect(
  "failed provisioning retains both reserved owner IDs and refuses foreign memory epochs",
  () =>
    Effect.gen(function* () {
      const repo = yield* Repository.AssistantRepository;
      const ownership = yield* Ownership.AssistantOwnership;
      const record = yield* repo.create(input);
      const summary = record.detail.summary;
      yield* repo.setProvisioning(summary, {
        state: "failed",
        binding: summary.binding,
        reason: "Git is unavailable.",
        retryable: true,
      });
      assert.equal(
        (yield* ownership.byProject(summary.binding.backingProjectId))?.detail.summary
          .provisioningState,
        "failed",
      );
      assert.equal(
        (yield* ownership.byThread(summary.binding.canonicalThreadId))?.detail.summary
          .provisioningState,
        "failed",
      );
      assert.isNull(yield* ownership.byProject(ProjectId.make("foreign")));
      assert.isNull(yield* ownership.byThread(ThreadId.make("foreign")));
      assert.equal(
        (yield* ownership
          .assertCurrent({
            environmentId,
            owner: { kind: "assistant", assistantId: summary.assistantId },
            ownerRevision: 1,
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* repo.setProvisioning(summary, {
        state: "provisioning",
        stage: "thread",
        binding: summary.binding,
      });
      yield* repo.setProvisioning(summary, {
        state: "failed",
        binding: summary.binding,
        reason: "Interrupted after launch.",
        retryable: true,
      });
      yield* repo.setProvisioning(summary, {
        state: "provisioning",
        stage: "folder",
        binding: summary.binding,
      });
      assert.equal((yield* repo.get(summary)).provisioningStage, "thread");
      yield* repo.setProvisioning(summary, { state: "ready", binding: summary.binding });
      assert.equal(
        (yield* repo.setProvisioning(summary, {
          state: "provisioning",
          stage: "folder",
          binding: summary.binding,
        })).detail.summary.provisioningState,
        "ready",
      );
      yield* repo.setProvisioning(summary, {
        state: "needs-repair",
        binding: summary.binding,
        reason: "Retained home changed.",
      });
      assert.equal(
        (yield* repo
          .setProvisioning(summary, { state: "ready", binding: summary.binding })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal((yield* repo.get(summary)).detail.summary.provisioningState, "needs-repair");
      const sql = yield* SqlClient.SqlClient;
      const collision =
        yield* sql`INSERT INTO t3_workflow_v2_assistants SELECT environment_id,'another',project_id,'another-thread',owner_revision,configuration_revision,lifecycle,provisioning_state,workspace_root,'another-command',payload_json FROM t3_workflow_v2_assistants`.pipe(
          Effect.result,
        );
      assert.equal(collision._tag, "Failure");
    }).pipe(Effect.provide(Ownership.layer.pipe(Layer.provideMerge(repository)))),
);
