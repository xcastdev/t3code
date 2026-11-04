import { h } from "../dom.ts";
import type { App, ViewModule } from "./state.ts";

/** Nav order and labels. A slot shows only when a view is registered for it. */
export const NAV_SLOTS = [
  { slot: "requests", label: "Requests" },
  { slot: "replayer", label: "Replayer" },
  { slot: "decoder", label: "Decoder" },
  { slot: "proxies", label: "Proxies" },
] as const;

export type NavSlot = (typeof NAV_SLOTS)[number]["slot"];

export interface ViewDefinition extends Omit<ViewModule, "styles"> {
  readonly slot: NavSlot;
  /** Every stylesheet the view and its nested views need; the shell injects each once. */
  readonly styles: ReadonlyArray<string>;
}

export const navStyles = `
.topnav {
  display: flex;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}
.topnav button {
  height: 32px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
}
.topnav button[aria-selected="true"] {
  border-bottom-color: var(--text);
  color: var(--text);
}
.view {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
`;

/**
 * Views mount on first show and stay mounted while hidden, so switching back keeps their
 * subscriptions and scroll position. Returns a function that unmounts every view.
 */
export const mountNav = (
  bar: HTMLElement,
  host: HTMLElement,
  views: ReadonlyArray<ViewDefinition>,
  app: App,
): (() => void) => {
  const mounted = new Map<NavSlot, { root: HTMLElement; dispose: () => void }>();
  const slots = NAV_SLOTS.flatMap(({ slot, label }) => {
    const view = views.find((candidate) => candidate.slot === slot);
    return view === undefined ? [] : [{ slot, label, view }];
  });
  const buttons = slots.map(({ slot, label }) =>
    h(
      "button",
      { type: "button", role: "tab", "data-slot": slot, onclick: () => app.view.set(slot) },
      label,
    ),
  );
  bar.setAttribute("role", "tablist");
  bar.replaceChildren(...buttons);

  const show = (active: NavSlot) => {
    const entry = slots.find(({ slot }) => slot === active);
    if (entry !== undefined && !mounted.has(active)) {
      const root = h("div", { class: "view", "data-view": active });
      host.append(root);
      mounted.set(active, { root, dispose: entry.view.mount(root, app) });
    }
    for (const [slot, { root }] of mounted) root.hidden = slot !== active;
    for (const button of buttons)
      button.setAttribute("aria-selected", String(button.dataset.slot === active));
  };

  const unsubscribe = app.view.subscribe(show);
  show(app.view.get());
  return () => {
    unsubscribe();
    for (const { root, dispose } of mounted.values()) {
      dispose();
      root.remove();
    }
    mounted.clear();
  };
};
