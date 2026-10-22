import * as Layer from "effect/Layer";
import * as Activity from "../assistants/AssistantActivity.ts";
import * as Roster from "../assistants/AssistantRosterStream.ts";
import * as Gateway from "../assistants/AssistantRoutineGateway.ts";
import * as Routines from "../assistants/AssistantRoutines.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { ControlledRoutineIsolation } from "./controlledRoutineIsolation.ts";
import * as Effect from "effect/Effect";

export const layerControlledRoutines = Layer.unwrap(
  Effect.gen(function* () {
    yield* ControlledRoutineIsolation;
    const scheduled = Layer.fresh(ScheduledTasks.layer).pipe(Layer.provideMerge(Scheduler.layer));
    const routines = Routines.layer.pipe(Layer.provideMerge(scheduled));
    const reads = Layer.mergeAll(Activity.layer, Gateway.layer).pipe(Layer.provideMerge(routines));
    return Roster.layer.pipe(Layer.provideMerge(reads));
  }),
);
