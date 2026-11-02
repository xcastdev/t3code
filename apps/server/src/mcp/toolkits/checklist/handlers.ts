import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { dispatchFailure, newCommandId, readThread } from "../../threadAccess.ts";
import {
  checklistPlanId,
  createChecklistSteps,
  formatChecklist,
  updateChecklistStep,
} from "./checklist.ts";
import { ChecklistToolkit } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const layer = McpToolAccess.toLayer(ChecklistToolkit, {
  t3_checklist: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (!scope.capabilities.has("checklist")) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This agent keeps its own checklist. Use that instead.",
        });
      }
      const { threads, projection } = yield* readThread(undefined, ["plans"]);
      const threadId = projection.thread.id;
      const planId = checklistPlanId(threadId);
      const current = projection.plans.find((plan) => plan.id === planId);
      const steps = current?.kind === "todo_list" ? current.steps : [];
      const commandId = yield* newCommandId();

      if (input.action === "clear") {
        if (steps.length > 0) {
          yield* threads
            .dispatch({ type: "thread.todo-list.clear", commandId, threadId, planId })
            .pipe(Effect.mapError(dispatchFailure));
        }
        return { checklist: formatChecklist([]) };
      }

      let next: ReturnType<typeof createChecklistSteps>;
      if (input.action === "create") {
        if (input.steps === undefined) return yield* invalid("create needs `steps`.");
        next = createChecklistSteps(input.steps);
      } else {
        if (input.step === undefined || input.status === undefined)
          return yield* invalid("update needs `step` and `status`.");
        if (steps.length === 0)
          return yield* invalid("There is no checklist. Call with action `create` first.");
        const updated = updateChecklistStep(steps, input.step, input.status);
        if (typeof updated === "string") return yield* invalid(updated);
        next = updated;
      }
      yield* threads
        .dispatch({ type: "thread.todo-list.set", commandId, threadId, planId, steps: next })
        .pipe(Effect.mapError(dispatchFailure));
      return { checklist: formatChecklist(next) };
    }),
  ),
});
