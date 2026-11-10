import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { nativeObject } from "./toolItems.ts";
import type { NativeRecord } from "./turnController.ts";
export function ompQuestions(frame: NativeRecord): readonly OrchestrationV2UserInputQuestion[] {
  if (frame.secret === true)
    throw new Error(
      "Native secret input requires a protected secret channel; plain user answers are refused",
    );
  const id = typeof frame.id === "string" ? frame.id : "";
  if (!id) throw new Error("Missing native UI identity");
  if (frame.method === "ask") {
    if (!Array.isArray(frame.questions) || !frame.questions.length || frame.questions.length > 16)
      throw new Error("Unsupported native question group");
    const seen = new Set<string>();
    return frame.questions.map((v) => {
      if (
        !nativeObject(v) ||
        typeof v.id !== "string" ||
        !v.id ||
        seen.has(v.id) ||
        typeof v.question !== "string" ||
        !Array.isArray(v.options) ||
        v.options.length > 64
      )
        throw new Error("Invalid native question");
      seen.add(v.id);
      return {
        id: v.id,
        header: typeof v.header === "string" && v.header ? v.header : "Question",
        question: v.question,
        options: v.options.map((o) => {
          if (!nativeObject(o) || typeof o.label !== "string" || !o.label)
            throw new Error("Invalid native question option");
          return {
            label: o.label,
            description:
              typeof o.description === "string" && o.description ? o.description : o.label,
            ...(typeof o.preview === "string" ? { preview: o.preview } : {}),
          };
        }),
        multiSelect: v.multi === true,
        allowCustomAnswer: true,
      };
    });
  }
  if (!["select", "confirm", "input", "editor"].includes(String(frame.method)))
    throw new Error("Unsupported native UI request");
  const title = typeof frame.title === "string" && frame.title ? frame.title : "Question";
  const labels =
    frame.method === "confirm"
      ? ["Yes", "No"]
      : frame.method === "select" && Array.isArray(frame.options)
        ? frame.options
        : [];
  if (labels.some((v) => typeof v !== "string" || !v) || labels.length > 64)
    throw new Error("Invalid native select options");
  return [
    {
      id,
      header: title,
      question: typeof frame.message === "string" ? frame.message : title,
      options: labels.map((v) => ({ label: String(v), description: String(v) })),
      allowCustomAnswer: frame.method === "input" || frame.method === "editor",
      ...(typeof frame.prefill === "string" ? { initialAnswer: frame.prefill } : {}),
    },
  ];
}
export function ompAnswer(
  frame: NativeRecord,
  answers: ProviderUserInputAnswers | undefined,
): NativeRecord {
  const base = { type: "extension_ui_response", id: frame.id };
  if (!answers) return { ...base, cancelled: true };
  const questions = ompQuestions(frame);
  const entries = questions.map((q) => {
    const value = answers[q.id];
    if (value === undefined) return { id: q.id, selectedOptions: [] };
    const raw =
      typeof value === "string"
        ? [value]
        : Array.isArray(value) && value.every((v): v is string => typeof v === "string")
          ? value
          : undefined;
    if (!raw) throw new Error("Invalid question answer type");
    const selected = q.options.filter((o) => raw.includes(o.label)).map((o) => o.label);
    const custom = raw.filter((v) => !q.options.some((o) => o.label === v));
    if (
      (!q.multiSelect && selected.length > 1) ||
      custom.length > 1 ||
      (custom.length && !q.allowCustomAnswer)
    )
      throw new Error("Invalid native question answer");
    return {
      id: q.id,
      selectedOptions: selected,
      ...(custom.length ? { customInput: custom[0] } : {}),
    };
  });
  if (frame.method === "ask") return { ...base, answers: entries };
  const first = entries[0]!;
  if (frame.method === "confirm") return { ...base, confirmed: first.selectedOptions[0] === "Yes" };
  const value = first.selectedOptions[0] ?? first.customInput;
  if (value === undefined) return { ...base, cancelled: true };
  return { ...base, value };
}
