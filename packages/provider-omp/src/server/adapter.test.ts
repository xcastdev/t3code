import { expect, it } from "@effect/vitest";
import { OmpTurnController } from "./turnController.ts";
it("correlates acknowledgement and result, ignores agent_end, flushes deltas before one settlement", async () => {
  const sent: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  let settled = true;
  let compacting = false;
  const requests: string[] = [];
  const owner = new OmpTurnController(
    async (r) => {
      sent.push(r);
    },
    (e) => {
      events.push(e);
    },
    async (record) => {
      requests.push(record.type);
      return { isSettled: settled, isCompacting: compacting };
    },
  );
  await owner.start("a", "hello", []);
  await owner.handle({ type: "response", id: "a", command: "prompt", success: true });
  expect(owner.activeId).toBe("a");
  await owner.handle({
    type: "response",
    id: "stale",
    command: "prompt",
    success: true,
    data: { agentInvoked: false },
  });
  expect(requests).toEqual([]);
  await owner.handle({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hi" },
  });
  await owner.handle({ type: "agent_end" });
  expect(owner.activeId).toBe("a");
  await owner.handle({
    type: "prompt_result",
    id: "old",
    status: "completed",
    sessionSettled: true,
  });
  expect(owner.activeId).toBe("a");
  await owner.handle({
    type: "prompt_result",
    id: "a",
    status: "completed",
    sessionSettled: false,
  });
  expect(owner.activeId).toBe("a");
  await owner.handle({ type: "session_settled" });
  await owner.handle({ type: "session_settled" });
  expect(events.filter((e) => e.type === "terminal")).toEqual([
    { type: "terminal", id: "a", status: "completed" },
  ]);
  expect(events.findIndex((e) => e.type === "message_update")).toBeLessThan(
    events.findIndex((e) => e.type === "terminal"),
  );
  await owner.start("b", "/dump", [{ name: "dump", source: "builtin" }]);
  await owner.handle({
    type: "response",
    id: "a",
    command: "prompt",
    success: true,
    data: { agentInvoked: false },
  });
  expect(owner.activeId).toBe("b");
  await owner.handle({
    type: "response",
    id: "b",
    command: "prompt",
    success: true,
    data: { agentInvoked: false },
  });
  expect(owner.activeId).toBeUndefined();
  expect(requests).toEqual(["get_state"]);
  settled = false;
  await owner.start("c", "/compact", [{ name: "compact", source: "builtin" }]);
  await owner.handle({
    type: "response",
    id: "b",
    command: "prompt",
    success: true,
    data: { agentInvoked: false },
  });
  expect(owner.activeId).toBe("c");
  await owner.handle({
    type: "response",
    id: "c",
    command: "prompt",
    success: true,
    data: { agentInvoked: false },
  });
  await owner.handle({ type: "agent_end" });
  expect(owner.activeId).toBe("c");
  await owner.handle({ type: "session_settled" });
  await owner.handle({ type: "session_settled" });
  expect(owner.activeId).toBeUndefined();
  expect(events.filter((e) => e.type === "terminal").map((e) => e.id)).toEqual(["a", "b", "c"]);
  settled = true;
  compacting = true;
  await owner.start("d", "/compact", [{ name: "compact", source: "builtin" }]);
  await owner.handle({ type: "manual_compaction_start" });
  await owner.handle({
    type: "response",
    id: "d",
    command: "prompt",
    success: true,
    data: { agentInvoked: false },
  });
  await owner.handle({ type: "session_settled" });
  expect(owner.activeId).toBe("d");
  compacting = false;
  await owner.handle({ type: "manual_compaction_end", aborted: false });
  expect(owner.activeId).toBeUndefined();
  expect(events.at(-2)?.type).toBe("manual_compaction_end");
  expect(events.at(-1)).toMatchObject({ type: "terminal", id: "d", status: "completed" });
});
it("stop withdraws queue, ignores stale prompt completion and late admission errors fail only owner", async () => {
  const sent: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const owner = new OmpTurnController(
    async (r) => {
      sent.push(r);
    },
    (e) => {
      events.push(e);
    },
  );
  await owner.start("a", "hello", []);
  await owner.stop();
  expect(sent.at(-1)?.type).toBe("abort_and_restore_queue");
  await owner.handle({
    type: "response",
    id: "a",
    command: "prompt",
    success: false,
    error: "late error",
  });
  expect(owner.activeId).toBeUndefined();
  await owner.start("b", "again", []);
  await owner.handle({ type: "prompt_result", id: "a", status: "aborted", sessionSettled: true });
  expect(owner.activeId).toBe("b");
  await owner.handle({
    type: "response",
    id: "b",
    command: "prompt",
    success: false,
    error: "not admitted",
  });
  expect(events.at(-1)).toMatchObject({ type: "terminal", id: "b", status: "error" });
});
