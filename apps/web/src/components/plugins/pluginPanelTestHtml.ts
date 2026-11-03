import { vi } from "vite-plus/test";

/**
 * A panel document for browser tests. `script` runs after `t3/initialize` with `call(method,
 * params)` (resolves to the JSON-RPC response) and `probe(name, data)` (reports to the test).
 */
export function pluginPanelTestHtml(script: string, body = ""): string {
  return `<!doctype html><html><body style="margin:0">${body}<script>
const pending = new Map();
let nextId = 1;
addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const message = event.data;
  if (message && message.jsonrpc === "2.0" && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
  }
});
const call = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
});
const probe = (name, data) => parent.postMessage({ probe: name, data }, "*");
(async () => {
  const init = await call("t3/initialize", { apiVersion: "1.0" });
  probe("initialized", init.result ?? init.error);
  ${script}
})();
</script></body></html>`;
}

/** Collects probes posted by the iframe inside `container`; dispose to stop listening. */
export function collectPanelProbes(container: HTMLElement) {
  const probes: Array<{ readonly name: string; readonly data: unknown }> = [];
  const controller = new AbortController();
  window.addEventListener(
    "message",
    (event) => {
      const frame = container.querySelector("iframe");
      const data = event.data as { probe?: unknown; data?: unknown } | null;
      if (event.source === frame?.contentWindow && typeof data?.probe === "string") {
        probes.push({ name: data.probe, data: data.data });
      }
    },
    { signal: controller.signal },
  );
  return {
    probe: (name: string) =>
      vi.waitFor(() => {
        const found = probes.find((entry) => entry.name === name);
        if (found === undefined) throw new Error(`No ${name} probe yet`);
        return found.data;
      }),
    [Symbol.dispose]: () => controller.abort(),
  };
}
