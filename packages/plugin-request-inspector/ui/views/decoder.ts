// @effect-diagnostics globalTimers:off - Runs inside a sandboxed plugin frame, outside any Effect runtime.
import type { DecodeOp, DecodeResult, DecodeStep, KeyEncoding } from "../../backend/decode.ts";
import type { ViewDefinition } from "../app/nav.ts";
import { type App, type DecoderInput, explainCallFailure, jsonBytes } from "../app/state.ts";
import { bytesLabel, fill, h, isRecord, messageOf } from "../dom.ts";

const DEBOUNCE_MS = 250;
const MAX_PERSISTED_INPUT_CHARS = 16 * 1024;
const MAX_STEPS = 16;

const OP_GROUPS: ReadonlyArray<{
  label: string;
  ops: ReadonlyArray<{ op: DecodeOp; label: string; encodes: boolean }>;
}> = [
  {
    label: "Encoding",
    ops: [
      { op: "base64", label: "Base64", encodes: true },
      { op: "base64url", label: "Base64url", encodes: true },
      { op: "url", label: "URL", encodes: true },
      { op: "hex", label: "Hex", encodes: true },
      { op: "html", label: "HTML entities", encodes: true },
      { op: "unicode", label: "Unicode escapes", encodes: true },
    ],
  },
  {
    label: "Compression",
    ops: [
      { op: "gzip", label: "Gzip", encodes: true },
      { op: "deflate", label: "Deflate", encodes: true },
      { op: "brotli", label: "Brotli", encodes: true },
    ],
  },
  {
    label: "Structure",
    ops: [
      { op: "jwt", label: "JWT", encodes: false },
      { op: "json", label: "JSON pretty-print", encodes: false },
    ],
  },
  {
    label: "Crypto",
    ops: [
      { op: "hash", label: "Hash", encodes: false },
      { op: "aes", label: "AES decrypt", encodes: false },
      { op: "xor", label: "XOR", encodes: false },
    ],
  },
];
const OP_INFO = new Map(OP_GROUPS.flatMap((group) => group.ops.map((info) => [info.op, info])));
const HASH_ALGORITHMS = ["md5", "sha1", "sha256", "sha512"] as const;
const AES_MODES = ["cbc", "gcm", "ctr"] as const;
const KEY_ENCODINGS: ReadonlyArray<KeyEncoding> = ["hex", "base64", "utf8"];

type HashAlgorithm = (typeof HASH_ALGORITHMS)[number];
type AesMode = (typeof AES_MODES)[number];

/** Key material lives only here, never in persisted state. */
interface Step {
  readonly id: number;
  readonly op: DecodeOp;
  direction: "decode" | "encode";
  algorithm: HashAlgorithm;
  aes: { mode: AesMode; key: string; iv: string; tag: string; encoding: KeyEncoding };
  xor: { key: string; encoding: KeyEncoding };
}

type Source =
  | { readonly kind: "paste" }
  | {
      readonly kind: "request";
      readonly requestId: string;
      readonly side: "request" | "response";
      readonly header?: string;
    };

export const styles = `
.decoder {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  overflow-y: auto;
}
.decoder-source textarea {
  min-height: 96px;
}
.decoder-source .what {
  font-family: var(--mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.decoder-steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.decoder-steps.stale .decoder-output {
  opacity: 0.6;
}
.decoder-step {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.decoder-step .index {
  min-width: 18px;
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 12px;
}
.decoder-step .name {
  font-weight: 600;
}
.decoder-step label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
  font-size: 12px;
}
.decoder-step input[type="text"] {
  width: 160px;
  font-family: var(--mono);
  font-size: 12px;
}
.decoder-output pre {
  max-height: 240px;
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px);
  background: var(--bg);
  font: 12px/1.5 var(--mono);
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.decoder-output .meta {
  color: var(--text-muted);
  font-size: 12px;
}
.decoder-output .step-error {
  color: var(--danger);
  font-size: 12px;
  overflow-wrap: anywhere;
}
`;

const isOneOf = <T extends string>(values: ReadonlyArray<T>, value: unknown): value is T =>
  typeof value === "string" && (values as ReadonlyArray<string>).includes(value);

const DECODE_OP_LIST = [...OP_INFO.keys()];

let lastStepId = 0;
const newStep = (op: DecodeOp): Step => ({
  id: ++lastStepId,
  op,
  direction: "decode",
  algorithm: "sha256",
  aes: { mode: "cbc", key: "", iv: "", tag: "", encoding: "hex" },
  xor: { key: "", encoding: "utf8" },
});

const restoreStep = (raw: unknown): Step | undefined => {
  if (!isRecord(raw) || !isOneOf(DECODE_OP_LIST, raw.op)) return undefined;
  const step = newStep(raw.op);
  if (raw.direction === "encode" && OP_INFO.get(raw.op)?.encodes) step.direction = "encode";
  if (isOneOf(HASH_ALGORITHMS, raw.algorithm)) step.algorithm = raw.algorithm;
  if (isRecord(raw.aes)) {
    if (isOneOf(AES_MODES, raw.aes.mode)) step.aes.mode = raw.aes.mode;
    if (isOneOf(KEY_ENCODINGS, raw.aes.encoding)) step.aes.encoding = raw.aes.encoding;
  }
  if (isRecord(raw.xor) && isOneOf(KEY_ENCODINGS, raw.xor.encoding)) {
    step.xor.encoding = raw.xor.encoding;
  }
  return step;
};

const persistStep = (step: Step) => ({
  op: step.op,
  ...(step.direction === "encode" ? { direction: "encode" } : {}),
  ...(step.op === "hash" ? { algorithm: step.algorithm } : {}),
  ...(step.op === "aes" ? { aes: { mode: step.aes.mode, encoding: step.aes.encoding } } : {}),
  ...(step.op === "xor" ? { xor: { encoding: step.xor.encoding } } : {}),
});

/** The wire step, or why it cannot run yet. */
const wireStep = (step: Step): DecodeStep | string => {
  switch (step.op) {
    case "hash":
      return { op: "hash", algorithm: step.algorithm };
    case "aes": {
      const { mode, key, iv, tag, encoding } = step.aes;
      if (key === "") return "Enter a key.";
      if (iv === "") return "Enter an IV.";
      if (mode === "gcm" && tag === "") return "Enter the GCM tag.";
      return { op: "aes", aes: { mode, key, iv, encoding, ...(mode === "gcm" ? { tag } : {}) } };
    }
    case "xor":
      if (step.xor.key === "") return "Enter a key.";
      return { op: "xor", xor: { key: step.xor.key, encoding: step.xor.encoding } };
    default:
      return step.direction === "encode" ? { op: step.op, direction: "encode" } : { op: step.op };
  }
};

const isDecodeResult = (value: unknown): value is DecodeResult =>
  isRecord(value) && Array.isArray(value.steps);

const sourceLabel = (source: Extract<Source, { kind: "request" }>) =>
  source.header === undefined
    ? `${source.side} body of request ${source.requestId}`
    : `${source.side} header ${source.header} of request ${source.requestId}`;

const select = <T extends string>(
  values: ReadonlyArray<T>,
  current: T,
  onChange: (value: T) => void,
  label: string,
) => {
  const element = h(
    "select",
    {
      "aria-label": label,
      onchange: (event) => {
        const value = (event.target as HTMLSelectElement).value;
        if (isOneOf(values, value)) onChange(value);
      },
    },
    ...values.map((value) => h("option", { value, selected: value === current }, value)),
  );
  return element;
};

const textInput = (value: string, label: string, onInput: (value: string) => void) => {
  const element = h("input", {
    type: "text",
    "aria-label": label,
    placeholder: label,
    spellcheck: "false",
    autocomplete: "off",
    oninput: (event) => onInput((event.target as HTMLInputElement).value),
  }) as HTMLInputElement;
  element.value = value;
  return element;
};

const mount = (root: HTMLElement, app: App) => {
  const { client, persistence } = app;
  const restored = persistence.restored.decoder;
  let pasted = "";
  let pastedIsBase64 = false;
  let steps: Step[] = [];
  if (isRecord(restored)) {
    if (typeof restored.input === "string") pasted = restored.input;
    pastedIsBase64 = restored.base64 === true;
    if (Array.isArray(restored.steps)) {
      steps = restored.steps.slice(0, MAX_STEPS).flatMap((raw) => restoreStep(raw) ?? []);
    }
  }
  let source: Source = { kind: "paste" };
  let result: DecodeResult | undefined;
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Only text the user typed or pasted is saved: a step output or forwarded value may be a secret.
  let inputTyped = pasted !== "";
  const unregister = persistence.register("decoder", (maxBytes) => {
    const saved = { input: "", base64: false, steps: steps.map(persistStep) };
    if (!inputTyped || pasted.length > MAX_PERSISTED_INPUT_CHARS) return saved;
    const withInput = { ...saved, input: pasted, base64: pastedIsBase64 };
    return jsonBytes(withInput) <= maxBytes ? withInput : saved;
  });

  const textarea = h("textarea", {
    "aria-label": "Input",
    placeholder: "Paste a value to decode",
    spellcheck: "false",
    oninput: () => {
      pasted = textarea.value;
      inputTyped = true;
      persistence.soon();
      schedule();
    },
  }) as HTMLTextAreaElement;
  textarea.value = pasted;
  const base64Toggle = h("input", {
    type: "checkbox",
    checked: pastedIsBase64,
    onchange: () => {
      pastedIsBase64 = base64Toggle.checked;
      persistence.soon();
      schedule();
    },
  }) as HTMLInputElement;
  const sourceBox = h("div", { class: "decoder-source" });
  const stepList = h("ol", { class: "decoder-steps" });
  const chainError = h("div", { class: "notice error", hidden: true });
  const addMenu = h(
    "select",
    {
      "aria-label": "Add step",
      onchange: () => {
        const op = addMenu.value;
        addMenu.value = "";
        if (!isOneOf(DECODE_OP_LIST, op) || steps.length >= MAX_STEPS) return;
        steps.push(newStep(op));
        changed(true);
      },
    },
    h("option", { value: "", selected: true }, "Add step…"),
    ...OP_GROUPS.map((group) =>
      h(
        "optgroup",
        { label: group.label },
        ...group.ops.map(({ op, label }) => h("option", { value: op }, label)),
      ),
    ),
  ) as HTMLSelectElement;

  const cards = new Map<number, { card: HTMLElement; output: HTMLElement; index: HTMLElement }>();

  const changed = (structural: boolean) => {
    persistence.soon();
    if (structural) renderSteps();
    schedule();
  };

  const useAsInput = (index: number) => {
    const output = result?.steps[index];
    if (output === undefined) return;
    if (output.text !== undefined) {
      pasted = output.text;
      pastedIsBase64 = false;
    } else if (output.base64 !== undefined) {
      pasted = output.base64;
      pastedIsBase64 = true;
    } else return;
    inputTyped = false;
    source = { kind: "paste" };
    steps = steps.slice(index + 1);
    textarea.value = pasted;
    base64Toggle.checked = pastedIsBase64;
    result = undefined;
    renderSource();
    changed(true);
  };

  const moveStep = (id: number, by: -1 | 1, button: HTMLElement) => {
    const from = steps.findIndex((step) => step.id === id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= steps.length) return;
    const [step] = steps.splice(from, 1);
    steps.splice(to, 0, step!);
    changed(true);
    button.focus();
  };

  const buildParams = (step: Step) => {
    const info = OP_INFO.get(step.op);
    const params: Array<HTMLElement> = [];
    if (info?.encodes) {
      params.push(
        select(
          ["decode", "encode"] as const,
          step.direction,
          (value) => {
            step.direction = value;
            changed(false);
          },
          "Direction",
        ),
      );
    }
    if (step.op === "hash") {
      params.push(
        select(
          HASH_ALGORITHMS,
          step.algorithm,
          (value) => {
            step.algorithm = value;
            changed(false);
          },
          "Algorithm",
        ),
      );
    }
    if (step.op === "aes") {
      const tag = textInput(step.aes.tag, "Tag", (value) => {
        step.aes.tag = value;
        changed(false);
      });
      tag.hidden = step.aes.mode !== "gcm";
      params.push(
        select(
          AES_MODES,
          step.aes.mode,
          (value) => {
            step.aes.mode = value;
            tag.hidden = value !== "gcm";
            changed(false);
          },
          "Mode",
        ),
        textInput(step.aes.key, "Key", (value) => {
          step.aes.key = value;
          changed(false);
        }),
        textInput(step.aes.iv, "IV", (value) => {
          step.aes.iv = value;
          changed(false);
        }),
        tag,
        h(
          "label",
          {},
          "as",
          select(
            KEY_ENCODINGS,
            step.aes.encoding,
            (value) => {
              step.aes.encoding = value;
              changed(false);
            },
            "Key encoding",
          ),
        ),
      );
    }
    if (step.op === "xor") {
      params.push(
        textInput(step.xor.key, "Key", (value) => {
          step.xor.key = value;
          changed(false);
        }),
        h(
          "label",
          {},
          "as",
          select(
            KEY_ENCODINGS,
            step.xor.encoding,
            (value) => {
              step.xor.encoding = value;
              changed(false);
            },
            "Key encoding",
          ),
        ),
      );
    }
    return params;
  };

  const cardFor = (step: Step) => {
    const existing = cards.get(step.id);
    if (existing !== undefined) return existing;
    const index = h("span", { class: "index" });
    const output = h("div", { class: "decoder-output" });
    const up: HTMLElement = h(
      "button",
      {
        type: "button",
        class: "ghost",
        "aria-label": "Move up",
        onclick: () => moveStep(step.id, -1, up),
      },
      "↑",
    );
    const down: HTMLElement = h(
      "button",
      {
        type: "button",
        class: "ghost",
        "aria-label": "Move down",
        onclick: () => moveStep(step.id, 1, down),
      },
      "↓",
    );
    const card = h(
      "li",
      { class: "decoder-step" },
      h(
        "div",
        { class: "row" },
        index,
        h("span", { class: "name" }, OP_INFO.get(step.op)?.label ?? step.op),
        ...buildParams(step),
        h("span", { class: "spacer" }),
        up,
        down,
        h(
          "button",
          {
            type: "button",
            class: "ghost",
            "aria-label": "Remove step",
            onclick: () => {
              steps = steps.filter((candidate) => candidate.id !== step.id);
              changed(true);
            },
          },
          "✕",
        ),
      ),
      output,
    );
    const entry = { card, output, index };
    cards.set(step.id, entry);
    return entry;
  };

  const renderSteps = () => {
    const live = new Set(steps.map((step) => step.id));
    for (const id of cards.keys()) if (!live.has(id)) cards.delete(id);
    fill(
      stepList,
      ...steps.map((step, position) => {
        const entry = cardFor(step);
        entry.index.textContent = String(position + 1);
        return entry.card;
      }),
    );
    if (steps.length === 0) {
      stepList.append(h("li", { class: "muted" }, "Add a step to decode the input."));
    }
    addMenu.toggleAttribute("disabled", steps.length >= MAX_STEPS);
    renderOutputs();
  };

  const renderOutputs = () => {
    let blocked: number | undefined;
    for (const [position, step] of steps.entries()) {
      const { output } = cardFor(step);
      const pending = wireStep(step);
      if (typeof pending === "string" && blocked === undefined) {
        blocked = position;
        fill(output, h("div", { class: "meta" }, pending));
        continue;
      }
      if (blocked !== undefined) {
        fill(output, h("div", { class: "meta" }, `Waits for step ${blocked + 1}.`));
        continue;
      }
      const stepResult = result?.steps[position];
      if (stepResult === undefined) {
        const failed = result?.steps.some((entry) => !entry.ok) === true;
        fill(output, failed && h("div", { class: "meta" }, "Not run: an earlier step failed."));
        continue;
      }
      if (!stepResult.ok) {
        fill(output, h("div", { class: "step-error" }, stepResult.error ?? "This step failed."));
        continue;
      }
      const value = stepResult.text ?? stepResult.base64;
      const shownAs = stepResult.text !== undefined ? "text" : "base64";
      fill(
        output,
        h(
          "div",
          { class: "row meta" },
          h(
            "span",
            { class: "spacer" },
            [
              bytesLabel(stepResult.bytes),
              stepResult.isText ? "text" : "binary",
              value === undefined ? "too large to show" : shownAs === "base64" && "shown as base64",
              value !== undefined && stepResult.truncated && "preview truncated",
            ]
              .filter(Boolean)
              .join(" · "),
          ),
          value !== undefined &&
            h(
              "button",
              { type: "button", "data-host-tools": "", onclick: () => void copy(value) },
              stepResult.truncated ? "Copy preview" : "Copy",
            ),
          h(
            "button",
            {
              type: "button",
              disabled: value === undefined || stepResult.truncated === true,
              title: stepResult.truncated ? "Only a preview of this output is available." : "",
              onclick: () => useAsInput(position),
            },
            "Use as input",
          ),
        ),
        value !== undefined && h("pre", {}, value),
      );
    }
  };

  const copy = async (value: string) => {
    try {
      await client.copyText(value);
    } catch (error) {
      app.notices.set("dismiss:decoder-copy", "error", `Copy failed: ${messageOf(error)}`);
    }
  };

  const renderSource = () => {
    if (source.kind === "paste") {
      fill(
        sourceBox,
        textarea,
        h("label", { class: "row muted" }, base64Toggle, "Input is base64 (binary)"),
      );
      return;
    }
    fill(
      sourceBox,
      h(
        "div",
        { class: "row" },
        h("span", { class: "what spacer" }, `Input: ${sourceLabel(source)}`),
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              source = { kind: "paste" };
              result = undefined;
              renderSource();
              changed(false);
            },
          },
          "Paste instead",
        ),
      ),
    );
  };

  const run = async () => {
    const id = ++sequence;
    const chain: DecodeStep[] = [];
    for (const step of steps) {
      const wire = wireStep(step);
      if (typeof wire === "string") break;
      chain.push(wire);
    }
    let wireSource: Record<string, unknown>;
    if (source.kind === "request") {
      wireSource = {
        requestId: source.requestId,
        side: source.side,
        ...(source.header === undefined ? {} : { header: source.header }),
      };
    } else {
      if (pasted === "" || chain.length === 0) {
        result = undefined;
        stepList.classList.remove("stale");
        chainError.hidden = true;
        renderOutputs();
        return;
      }
      wireSource = pastedIsBase64 ? { base64: pasted.replace(/\s+/g, "") } : { text: pasted };
    }
    try {
      const response = await client.call("decode_value", { source: wireSource, steps: chain });
      if (id !== sequence) return;
      if (!isDecodeResult(response)) throw new Error("The decoder returned an unexpected result.");
      result = response;
      chainError.hidden = response.error === undefined;
      chainError.textContent = response.error ?? "";
    } catch (error) {
      if (id !== sequence) return;
      result = undefined;
      chainError.hidden = false;
      chainError.textContent = explainCallFailure(error);
    }
    stepList.classList.remove("stale");
    renderOutputs();
  };

  const schedule = (delay = DEBOUNCE_MS) => {
    clearTimeout(timer);
    // Invalidate any in-flight call now so its late answer cannot overwrite newer edits.
    sequence++;
    stepList.classList.add("stale");
    timer = setTimeout(() => void run(), delay);
  };

  const receive = (input: DecoderInput) => {
    if (input.kind === "text") {
      source = { kind: "paste" };
      pasted = input.text;
      inputTyped = false;
      pastedIsBase64 = false;
      textarea.value = pasted;
      base64Toggle.checked = false;
      persistence.soon();
    } else {
      source = {
        kind: "request",
        requestId: input.requestId,
        side: input.side,
        ...(input.kind === "header" ? { header: input.header } : {}),
      };
    }
    result = undefined;
    renderSource();
    renderOutputs();
    app.view.set("decoder");
    schedule(0);
  };
  const unsubscribe = app.sendToDecoder.on(receive);

  fill(
    root,
    h(
      "div",
      { class: "decoder" },
      sourceBox,
      chainError,
      stepList,
      h("div", { class: "row" }, addMenu),
    ),
  );
  renderSource();
  renderSteps();
  schedule(0);

  return () => {
    unsubscribe();
    unregister();
    clearTimeout(timer);
    sequence++;
  };
};

export const view: ViewDefinition = { slot: "decoder", styles: [styles], mount };
