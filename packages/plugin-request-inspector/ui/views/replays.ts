import type { HistoryEntry, LookedUp } from "../app/replays.ts";
import type { App } from "../app/state.ts";
import { h, timeLabel } from "../dom.ts";
import { MAX_UNSETTLED_REPLAYS, mayHaveBeenSent } from "../replayTracker.ts";

export const styles = `
.replays {
  border-top: 1px solid var(--border);
}
.replays summary {
  padding: 6px 12px;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
}
.replays > .replay-list {
  max-height: 30vh;
  padding: 0 12px 8px;
  overflow-y: auto;
}
.replay-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.replay-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 4px 0;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.replay-list .what {
  flex: 1 1 140px;
  min-width: 0;
  overflow: hidden;
  font-family: var(--mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.replay-list .when {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.replay-list .why {
  flex-basis: 100%;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
.replay-list button {
  height: 22px;
  font-size: 12px;
}
`;

const describe = (status: LookedUp | undefined, tracked: boolean) => {
  if (status === "gone") return { cls: "faint", text: "No longer kept" };
  if (status === undefined) {
    return tracked
      ? { cls: "state-pending", text: "Pending" }
      : { cls: "faint", text: "Checking…" };
  }
  if (mayHaveBeenSent(status)) {
    return {
      cls: "state-maybe",
      text:
        status.state === "unknown" ? "Unknown, may have been sent" : "Failed, may have been sent",
    };
  }
  switch (status.state) {
    case "pending":
      return {
        cls: "state-pending",
        text: status.dispatched ? "Sent, waiting for response" : "Pending",
      };
    case "completed":
      return { cls: "state-completed", text: "Completed" };
    default:
      return { cls: "state-failed", text: "Not sent" };
  }
};

/** Opens a replay's result request in the Requests view. */
export const openInRequests = (app: App, requestId: string) => {
  app.selection.set(requestId);
  app.view.set("requests");
};

const itemOf = (app: App, entry: HistoryEntry, showLabel: boolean): HTMLElement => {
  const model = app.replays;
  const tracked = model.tracker.tracked().find((item) => item.key === entry.key);
  const what = showLabel
    ? h(
        "button",
        {
          type: "button",
          class: "ghost what",
          title: `Open ${entry.label} in the Replayer`,
          onclick: () => model.tabs.open(entry.requestId),
        },
        entry.label,
      )
    : h("span", { class: "what", title: entry.label }, entry.label);
  const when = h("span", { class: "when" }, timeLabel(entry.at));

  if (tracked !== undefined && tracked.replayId === undefined) {
    const inFlight = model.inFlight(entry.key);
    return h(
      "li",
      {},
      what,
      when,
      h("span", { class: "state-maybe" }, inFlight ? "Sending…" : "Not confirmed"),
      !inFlight &&
        h("button", { type: "button", onclick: () => void model.submit(entry.key) }, "Retry"),
      !inFlight &&
        h(
          "span",
          { class: "why" },
          model.note(entry.key)?.text ??
            "The inspector has not confirmed this replay. Retry reuses the same key, so it cannot send twice.",
        ),
    );
  }

  const replayId = entry.replayId ?? tracked?.replayId;
  if (replayId === undefined) {
    const state =
      entry.outcome === "not-sent"
        ? { cls: "state-failed", text: "Not sent" }
        : { cls: "state-maybe", text: "Refused, may have been sent" };
    return h(
      "li",
      {},
      what,
      when,
      h("span", { class: state.cls }, state.text),
      entry.text !== undefined && h("span", { class: "why" }, entry.text),
    );
  }

  const status = model.statusOf(replayId);
  if (status === undefined && tracked === undefined) model.lookup(replayId);
  const state = describe(status, tracked !== undefined);
  const known = status === "gone" ? undefined : status;
  const resultId = known?.resultRequestId;
  return h(
    "li",
    {},
    what,
    when,
    h("span", { class: state.cls }, state.text),
    resultId !== undefined &&
      h("button", { type: "button", onclick: () => openInRequests(app, resultId) }, "Open result"),
    known?.detail !== undefined && h("span", { class: "why" }, known.detail),
  );
};

export interface ReplayHistory {
  readonly render: () => void;
  readonly dispose: () => void;
}

/**
 * A list of Sends, newest first. With `requestId`, only that request's, under a heading;
 * without, every Send in a collapsible section whose labels open their tab.
 */
export const mountHistory = (
  root: HTMLElement,
  app: App,
  options: { readonly requestId?: string; readonly isVisible: () => boolean },
): ReplayHistory => {
  const model = app.replays;
  const list = h("ul", { class: "replay-list" });
  const summary = h("summary", {}, "All replays");
  const scoped = options.requestId !== undefined;
  const container = scoped
    ? h("div", { class: "field" }, h("h3", {}, "Sent from this tab"), list)
    : h("details", { class: "replays" }, summary, list);
  root.replaceChildren(container);
  let dirty = true;

  const render = () => {
    if (!options.isVisible()) {
      dirty = true;
      return;
    }
    dirty = false;
    const entries = model
      .history()
      .filter((entry) => !scoped || entry.requestId === options.requestId);
    container.hidden = entries.length === 0;
    list.replaceChildren(...entries.map((entry) => itemOf(app, entry, !scoped)));
    if (!scoped) {
      const unsettled = model.tracker.tracked().length;
      summary.textContent =
        unsettled === 0
          ? `All replays · ${entries.length}`
          : `All replays · ${unsettled} unsettled${unsettled >= MAX_UNSETTLED_REPLAYS ? " (limit reached)" : ""}`;
    }
  };

  const offChanged = model.changed.on(render);
  render();
  return {
    render: () => {
      if (dirty) render();
    },
    dispose: offChanged,
  };
};
