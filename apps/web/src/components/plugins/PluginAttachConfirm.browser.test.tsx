import "~/index.css";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { PluginAttachRequest } from "@t3tools/client-runtime/plugins/bridge";
import { EnvironmentId, PluginId, ThreadId } from "@t3tools/contracts";
import { formatComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  attachPluginRequestToChat,
  type PluginAttachSource,
  type PluginChatTarget,
} from "../../plugins/attachToChat";
import { usePluginAttachConfirm } from "./PluginAttachConfirm";

const LOCAL = EnvironmentId.make("env-local");
const REMOTE = EnvironmentId.make("env-remote");
const threadRef = { environmentId: LOCAL, threadId: ThreadId.make("thread-attach") };
const chatTarget: NonNullable<PluginChatTarget> = {
  key: scopedThreadKey(threadRef),
  title: "Fix login",
  composerTarget: threadRef,
  environmentId: LOCAL,
};
const queuedEditDraft = DraftId.make(`queued-edit:${scopedThreadKey(threadRef)}:run-1`);
const inspector = PluginId.make("request-inspector");

const sourceIn = (environmentId: EnvironmentId, environmentLabel: string): PluginAttachSource => ({
  kind: "environment",
  environmentId,
  environmentLabel,
  pluginId: inspector,
  pluginName: "Request Inspector",
});

function AttachHarness(props: {
  readonly request: PluginAttachRequest;
  readonly source: PluginAttachSource;
  readonly chatTarget?: PluginChatTarget;
  readonly onOutcome?: (outcome: string) => void;
}) {
  const { confirm, dialog } = usePluginAttachConfirm();
  const [outcome, setOutcome] = useState("idle");
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOutcome("pending");
          attachPluginRequestToChat(props.request, {
            chatTarget: props.chatTarget ?? chatTarget,
            source: props.source,
            confirm,
          })
            .then((next) => {
              props.onOutcome?.(next);
              setOutcome(next);
            })
            .catch((error: Error) => setOutcome(error.message));
        }}
      >
        Request attach
      </button>
      <output aria-label="Outcome">{outcome}</output>
      {dialog}
    </>
  );
}

function setup() {
  const store = useComposerDraftStore.getState();
  store.clearComposerContent(threadRef);
  store.clearComposerContent(queuedEditDraft);
  return {
    draft: () => useComposerDraftStore.getState().getComposerDraft(threadRef),
    queuedEditDraft: () => useComposerDraftStore.getState().getComposerDraft(queuedEditDraft),
    [Symbol.dispose]: () => {
      store.clearComposerContent(threadRef);
      store.clearComposerContent(queuedEditDraft);
    },
  };
}

const reference = (snapshot: string): PluginAttachRequest => ({
  kind: "reference",
  label: "POST /login 500",
  locator: { requestId: "42" },
  snapshot,
  expectedChatTargetKey: chatTarget.key,
});

describe("PluginAttachConfirm", () => {
  it("attach refuses when target changed since request until confirmed", async () => {
    using drafts = setup();
    await using _screen = await render(
      <AttachHarness
        request={{ kind: "text", text: "converted", expectedChatTargetKey: "draft-elsewhere" }}
        source={{ kind: "client", pluginId: PluginId.make("converter"), pluginName: "Converter" }}
      />,
    );
    const outcome = page.getByRole("status", { name: "Outcome" });

    await page.getByRole("button", { name: "Request attach" }).click();
    await expect
      .element(page.getByRole("alertdialog", { name: "Attach to “Fix login”?" }))
      .toBeVisible();
    expect(drafts.draft()?.prompt ?? "").toBe("");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.element(outcome).toHaveTextContent("cancelled");
    expect(drafts.draft()?.prompt ?? "").toBe("");

    await page.getByRole("button", { name: "Request attach" }).click();
    await page.getByRole("button", { name: "Attach" }).click();
    await expect.element(outcome).toHaveTextContent("inserted");
    expect(drafts.draft()?.prompt).toBe("converted");
  });

  it("attach refuses a reference into another environment's thread", async () => {
    using drafts = setup();
    await using _screen = await render(
      <AttachHarness request={reference("HTTP/1.1 500")} source={sourceIn(REMOTE, "Build box")} />,
    );

    await page.getByRole("button", { name: "Request attach" }).click();
    await expect
      .element(page.getByRole("status", { name: "Outcome" }))
      .toHaveTextContent(
        "This capture belongs to Build box; attach it from a chat in that environment.",
      );
    expect(page.getByRole("alertdialog").query()).toBeNull();
    expect(drafts.draft()?.pluginReferences ?? []).toEqual([]);
  });

  it("always confirms a reference into its own environment and truncates its snapshot", async () => {
    using drafts = setup();
    await using _screen = await render(
      <AttachHarness request={reference("x".repeat(9_000))} source={sourceIn(LOCAL, "Laptop")} />,
    );

    await page.getByRole("button", { name: "Request attach" }).click();
    await expect
      .element(page.getByRole("alertdialog", { name: "Attach to “Fix login”?" }))
      .toBeVisible();
    expect(drafts.draft()?.pluginReferences ?? []).toEqual([]);
    await page.getByRole("button", { name: "Attach" }).click();
    await expect
      .element(page.getByRole("status", { name: "Outcome" }))
      .toHaveTextContent("inserted");
    const [record] = drafts.draft()?.pluginReferences ?? [];
    if (record === undefined) throw new Error("No reference was attached.");
    expect(record).toMatchObject({
      environmentId: LOCAL,
      pluginId: inspector,
      pluginName: "Request Inspector",
      locator: { requestId: "42" },
      snapshotTruncated: true,
    });
    expect(record.snapshot).toHaveLength(8_000);
    expect(drafts.draft()?.prompt).toContain(
      formatComposerContextHref("plugin-reference", record.contextId),
    );
  });

  it("attaches a reference into a queued edit of a thread in its environment", async () => {
    using drafts = setup();
    await using _screen = await render(
      <AttachHarness
        request={reference("HTTP/1.1 500")}
        source={sourceIn(LOCAL, "Laptop")}
        chatTarget={{ ...chatTarget, key: queuedEditDraft, composerTarget: queuedEditDraft }}
      />,
    );

    await page.getByRole("button", { name: "Request attach" }).click();
    await page.getByRole("button", { name: "Attach" }).click();
    await expect
      .element(page.getByRole("status", { name: "Outcome" }))
      .toHaveTextContent("inserted");
    expect(drafts.queuedEditDraft()?.pluginReferences).toHaveLength(1);
    expect(drafts.draft()?.pluginReferences ?? []).toEqual([]);
  });

  it("settles a pending confirm as cancelled when its host unmounts", async () => {
    using drafts = setup();
    let settle: (outcome: string) => void = () => {};
    const outcome = new Promise<string>((resolve) => {
      settle = resolve;
    });
    {
      await using _screen = await render(
        <AttachHarness
          request={reference("HTTP/1.1 500")}
          source={sourceIn(LOCAL, "Laptop")}
          onOutcome={(next) => settle(next)}
        />,
      );
      await page.getByRole("button", { name: "Request attach" }).click();
      await expect.element(page.getByRole("alertdialog")).toBeVisible();
    }

    expect(await outcome).toBe("cancelled");
    expect(drafts.draft()?.pluginReferences ?? []).toEqual([]);
  });
});
