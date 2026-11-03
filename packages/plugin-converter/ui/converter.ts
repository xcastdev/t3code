// @effect-diagnostics globalTimers:off - Runs inside a sandboxed plugin frame, outside any Effect runtime.
import { connectT3, type PluginHostContext, type T3PluginClient } from "@t3tools/plugin-sdk/ui";

type Mode = "json" | "base64" | "url";
interface SavedState {
  readonly mode: Mode;
  readonly input: string;
}

const ACTIONS: Record<Mode, readonly [string, string]> = {
  json: ["Format", "Minify"],
  base64: ["Encode", "Decode"],
  url: ["Encode", "Decode"],
};

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = element<HTMLTextAreaElement>("input");
const output = element<HTMLTextAreaElement>("output");
const error = element<HTMLSpanElement>("error");
const actionA = element<HTMLButtonElement>("action-a");
const actionB = element<HTMLButtonElement>("action-b");
const copy = element<HTMLButtonElement>("copy");
const insert = element<HTMLButtonElement>("insert");
const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-mode]")];

let mode: Mode = "json";
let client: T3PluginClient | undefined;

const encodeBase64 = (text: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const decodeBase64 = (text: string) => {
  const binary = atob(text.replace(/\s+/g, "").replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

const convert = (which: 0 | 1, text: string): string => {
  switch (mode) {
    case "json":
      return JSON.stringify(JSON.parse(text), null, which === 0 ? 2 : undefined);
    case "base64":
      return which === 0 ? encodeBase64(text) : decodeBase64(text);
    case "url":
      return which === 0 ? encodeURIComponent(text) : decodeURIComponent(text);
  }
};

const describeFailure = (cause: unknown) => {
  if (mode === "json") return `Not valid JSON: ${cause instanceof Error ? cause.message : ""}`;
  if (mode === "base64") return "Not valid Base64 for UTF-8 text.";
  return "Not a valid URL-encoded string.";
};

const setOutput = (text: string) => {
  output.value = text;
  copy.disabled = text === "";
  insert.disabled = text === "" || client?.context.chatTarget == null;
};

const run = (which: 0 | 1) => {
  error.textContent = "";
  try {
    setOutput(convert(which, input.value));
  } catch (cause) {
    setOutput("");
    error.textContent = describeFailure(cause);
  }
};

let saveTimer: ReturnType<typeof setTimeout> | undefined;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void client?.state.set({ mode, input: input.value } satisfies SavedState);
  }, 300);
};

const selectMode = (next: Mode) => {
  mode = next;
  for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.mode === next));
  [actionA.textContent, actionB.textContent] = ACTIONS[next];
  error.textContent = "";
  setOutput("");
};

const applyContext = (context: PluginHostContext) => {
  const root = document.documentElement;
  root.dataset.theme = context.theme;
  for (const [name, value] of Object.entries(context.styles.variables)) {
    root.style.setProperty(name, value);
  }
  const target = context.chatTarget;
  insert.title =
    target === null ? "Open a chat to insert the output." : `Insert into ${target.title}`;
  insert.disabled = output.value === "" || target === null;
};

const isSavedState = (value: unknown): value is SavedState =>
  typeof value === "object" &&
  value !== null &&
  "mode" in value &&
  (value.mode === "json" || value.mode === "base64" || value.mode === "url") &&
  "input" in value &&
  typeof value.input === "string";

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    selectMode(tab.dataset.mode as Mode);
    save();
  });
}
actionA.addEventListener("click", () => run(0));
actionB.addEventListener("click", () => run(1));
input.addEventListener("input", save);
copy.addEventListener("click", () => {
  void navigator.clipboard.writeText(output.value).catch(() => {
    output.select();
  });
});
insert.addEventListener("click", () => {
  const text = output.value;
  if (client === undefined || text === "") return;
  insert.disabled = true;
  void client
    .attach({ kind: "text", text })
    .catch((cause: unknown) => {
      error.textContent = cause instanceof Error ? cause.message : "Could not insert into chat.";
    })
    .finally(() => {
      insert.disabled = output.value === "" || client?.context.chatTarget == null;
    });
});

void connectT3().then(async (connected) => {
  client = connected;
  applyContext(connected.context);
  connected.onContextChange(applyContext);
  const stored = await connected.state.get().catch(() => null);
  if (stored !== null && isSavedState(stored.value)) {
    selectMode(stored.value.mode);
    input.value = stored.value.input;
  }
});
