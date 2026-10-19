// Synthetic protocol probes, not captured traffic. See README.md for provenance and scope.
import { event, model } from "../../PiSubscriptionTestKit.ts";

export const usage = {
  input_tokens: 50,
  output_tokens: 10,
  total_tokens: 60,
  input_tokens_details: { cached_tokens: 5 },
  output_tokens_details: { reasoning_tokens: 7 },
};
export const created = event({
  type: "response.created",
  response: { id: "response-1", model, status: "in_progress" },
});
export const completed = (output: readonly object[] = [], reportedUsage: object = usage) =>
  event({
    type: "response.completed",
    response: { id: "response-1", model, status: "completed", output, usage: reportedUsage },
  });
export const message = (text: string, refusal = false) => ({
  id: "message-1",
  type: "message",
  role: "assistant",
  status: "completed",
  content: refusal
    ? [{ type: "refusal", refusal: text }]
    : [{ type: "output_text", text, annotations: [] }],
});
export const textEvents = (text = "bounded result 🛰", refusal = false) => {
  const item = message(text, refusal);
  return [
    created,
    event({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }),
    event({
      type: refusal ? "response.refusal.delta" : "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    }),
    ...(refusal
      ? [event({ type: "response.refusal.done", item_id: item.id, output_index: 0, refusal: text })]
      : []),
    event({ type: "response.output_item.done", output_index: 0, item }),
    completed([item]),
  ];
};
export const textStream = textEvents().join("");
export const done = "data: [DONE]\n\n";
export const privateErrorMessage = "synthetic upstream private diagnostic";
export const upstreamError = (kind: "error" | "response.failed") =>
  created +
  event(
    kind === "error"
      ? { type: kind, code: "synthetic_failure", message: privateErrorMessage }
      : {
          type: kind,
          response: {
            id: "response-1",
            model,
            status: "failed",
            error: { code: "synthetic_failure", message: privateErrorMessage },
          },
        },
  );

export const parameters = {
  type: "object",
  properties: { key: { type: "string" } },
  required: ["key"],
  additionalProperties: false,
};
export const declaredTool = {
  type: "function" as const,
  function: { name: "lookup", description: "Look up a value", parameters },
};
export const toolMutations = [
  "valid",
  "punctuation",
  "namespace",
  "done-only-arguments",
  "no-arguments-done",
  "missing-terminal-call",
  "extra-terminal-call",
  "duplicate-terminal-call",
  "swapped-terminal-calls",
  "unfinished",
  "wrong-delta-index",
  "wrong-delta-item",
  "changed-done-arguments",
  "changed-final-item",
  "changed-final-call",
  "changed-final-name",
  "changed-final-arguments",
  "changed-terminal-arguments",
  "duplicate-added",
  "undeclared-tool",
] as const;
export type ToolMutation = (typeof toolMutations)[number];
export const toolStream = (mutation: ToolMutation) => {
  const call = {
    id: "fc_1",
    type: "function_call",
    call_id: mutation === "punctuation" ? "call.a:b/c+1=2-3_4" : "call-1",
    name: mutation === "undeclared-tool" ? "delete_project" : "lookup",
    arguments: '{"key":"A"}',
    ...(mutation === "namespace" ? { namespace: "fixture" } : {}),
  };
  const second = { ...call, id: "fc_2", call_id: "call-2", arguments: '{"key":"B"}' };
  const calls = mutation === "swapped-terminal-calls" ? [call, second] : [call];
  const frames = [created];
  for (const [index, item] of calls.entries()) {
    const added = event({
      type: "response.output_item.added",
      output_index: index,
      item: { ...item, arguments: "" },
    });
    frames.push(added);
    if (mutation === "duplicate-added") frames.push(added);
    if (mutation !== "done-only-arguments") {
      // Two argument deltas exercise incremental assembly rather than a single copied value.
      for (const delta of [item.arguments.slice(0, 7), item.arguments.slice(7)])
        frames.push(
          event({
            type: "response.function_call_arguments.delta",
            item_id: mutation === "wrong-delta-item" ? "foreign-item" : item.id,
            output_index: mutation === "wrong-delta-index" ? 3 : index,
            delta,
          }),
        );
    }
    if (mutation !== "no-arguments-done")
      frames.push(
        event({
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: index,
          arguments: mutation === "changed-done-arguments" ? '{"key":"other"}' : item.arguments,
        }),
      );
    if (mutation !== "unfinished")
      frames.push(
        event({
          type: "response.output_item.done",
          output_index: index,
          item: {
            ...item,
            ...(mutation === "changed-final-item" ? { id: "foreign-item" } : {}),
            ...(mutation === "changed-final-call" ? { call_id: "foreign-call" } : {}),
            ...(mutation === "changed-final-name" ? { name: "delete_project" } : {}),
            ...(mutation === "changed-final-arguments" ? { arguments: '{"key":"other"}' } : {}),
          },
        }),
      );
  }
  const output =
    mutation === "missing-terminal-call"
      ? []
      : mutation === "extra-terminal-call"
        ? [call, second]
        : mutation === "duplicate-terminal-call"
          ? [call, call]
          : mutation === "swapped-terminal-calls"
            ? [second, call]
            : mutation === "changed-terminal-arguments"
              ? [{ ...call, arguments: '{"key":"other"}' }]
              : [call];
  return frames.join("") + completed(output);
};
