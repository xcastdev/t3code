/* @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

const queriedCwds = vi.hoisted(() => [] as string[]);

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (target: { input?: { cwd?: string } } | null) => {
    const cwd = target?.input?.cwd ?? null;
    if (cwd) queriedCwds.push(cwd);
    return {
      data:
        cwd === null
          ? null
          : {
              sourceControlProvider:
                cwd === "/repo/packages/api"
                  ? { kind: "gitlab", name: "NestedLab", baseUrl: "https://gitlab.com" }
                  : { kind: "github", name: "OuterHub", baseUrl: "https://github.com" },
            },
    };
  },
}));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: { status: ({ input }: { input: { cwd: string } }) => ({ input }) },
}));

import { useRightPanelStore } from "~/rightPanelStore";
import { useChatViewSourceControlScope } from "./chatViewSourceControlScope";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const threadRef = scopeThreadRef(environmentId, threadId);
const roots: Root[] = [];

function ProviderRailAndActionsProbe({ onAction }: { onAction: (cwd: string | null) => void }) {
  const scope = useChatViewSourceControlScope({
    environmentId,
    threadRef,
    projectRoot: "/repo",
    hasProject: true,
  });
  return (
    <button type="button" onClick={() => onAction(scope.cwd)}>
      {scope.presentation?.providerName ?? "Source Control"}
    </button>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queriedCwds.splice(0);
  useRightPanelStore.setState({ sourceControlRepositoryRootByThreadKey: {} });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("ChatView Source Control scope", () => {
  it("switches the provider rail and its action scope with the shared selected repository", async () => {
    const actions: Array<string | null> = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<ProviderRailAndActionsProbe onAction={(cwd) => actions.push(cwd)} />);
    });
    expect(container.textContent).toBe("OuterHub");
    expect(queriedCwds).toContain("/repo");
    await act(async () => {
      useRightPanelStore.getState().setSourceControlRepositoryRoot(threadRef, "/repo/packages/api");
    });
    expect(container.textContent).toBe("NestedLab");
    expect(queriedCwds).toContain("/repo/packages/api");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(actions).toEqual(["/repo/packages/api"]);
  });
});
