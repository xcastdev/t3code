import { expect, it } from "@effect/vitest";
import { ompQuestions, ompAnswer } from "./questions.ts";
it("preserves grouped labels and order and refuses unsupported secret and invalid answers", () => {
  const request = {
    type: "extension_ui_request",
    id: "ask",
    method: "ask",
    questions: [
      { id: "q", question: "Targets?", multi: true, options: [{ label: "B" }, { label: "A" }] },
    ],
  };
  expect(ompQuestions(request)).toMatchObject([
    { id: "q", multiSelect: true, options: [{ label: "B" }, { label: "A" }] },
  ]);
  expect(ompAnswer(request, { q: ["A", "B", "free"] })).toEqual({
    type: "extension_ui_response",
    id: "ask",
    answers: [{ id: "q", selectedOptions: ["B", "A"], customInput: "free" }],
  });
  expect(() =>
    ompQuestions({
      type: "extension_ui_request",
      id: "s",
      method: "input",
      secret: true,
      title: "Password",
    }),
  ).toThrow("secret");
  expect(
    ompAnswer({ type: "extension_ui_request", id: "s", method: "confirm" }, undefined),
  ).toEqual({ type: "extension_ui_response", id: "s", cancelled: true });
});
