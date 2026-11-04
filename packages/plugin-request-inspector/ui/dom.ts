// @effect-diagnostics globalTimers:off globalDate:off - Runs inside a sandboxed plugin frame, outside any Effect runtime.
export type Child = Node | string | null | undefined | false;

export type HeaderPairs = ReadonlyArray<readonly [string, string]>;

export function h(
  tag: string,
  props: Record<string, string | boolean | ((event: Event) => void)> = {},
  ...children: ReadonlyArray<Child>
): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (typeof value === "function") element.addEventListener(name.slice(2), value);
    else if (value === true) element.setAttribute(name, "");
    else if (value !== false) element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

export const fill = (element: HTMLElement, ...children: ReadonlyArray<Child>) =>
  element.replaceChildren(
    ...children.filter(
      (child): child is Node | string => child !== null && child !== undefined && child !== false,
    ),
  );

let lastId = 0;
/** A document-unique id, for `label for` inside views that may mount more than once. */
export const uid = (prefix: string) => `${prefix}-${++lastId}`;

export const injectStyles = (css: string) => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^The plugin operation failed: /,
    "",
  );

export const bytesLabel = (bytes: number | undefined) => {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const timeFormat = new Intl.DateTimeFormat([], {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export const timeLabel = (ms: number | undefined) =>
  ms === undefined ? "" : timeFormat.format(ms);

export const compareIdsDesc = (a: string, b: string) =>
  a.length !== b.length ? b.length - a.length : a < b ? 1 : a > b ? -1 : 0;

export const statusClass = (status: number | undefined, error: string | undefined) =>
  error !== undefined ? "s5" : status === undefined ? "" : `s${Math.floor(status / 100)}`;

export const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

export const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

export const hexDump = (bytes: Uint8Array) => {
  const lines: Array<string> = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.subarray(offset, offset + 16);
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row]
      .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "."))
      .join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
};

export const headersText = (headers: HeaderPairs) =>
  headers.map(([name, value]) => `${name}: ${value}`).join("\n");

export const parseHeaderLines = (text: string): Array<[string, string]> =>
  text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const colon = line.indexOf(":");
      if (colon <= 0) return [line.trim(), ""];
      return [line.slice(0, colon).trim(), line.slice(colon + 1).replace(/^ /, "")];
    });
