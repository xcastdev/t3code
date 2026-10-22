import type { AssistantGetInput, ScheduledTaskId } from "@t3tools/contracts";
import * as Context from "effect/Context";

// Kept separate from the public service so scheduler ownership checks have no layer cycle.
export class AssistantRoutineMutation extends Context.Service<
  AssistantRoutineMutation,
  { readonly scope: AssistantGetInput; readonly taskId: ScheduledTaskId }
>()("t3/assistants/AssistantRoutineMutation") {}
