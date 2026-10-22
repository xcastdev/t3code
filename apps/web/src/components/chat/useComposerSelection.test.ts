import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { makeThreadFixture } from "../../test-fixtures";
import { resolveComposerSettingsSource } from "../ChatView.logic";
import { useComposerSelection } from "./useComposerSelection";

// Exercise the event handlers and real draft store without mounting a client.
vi.mock(import("../../hooks/useStableCallback"), () => ({
  useStableCallback: (callback) => callback,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => vi.fn(),
}));
vi.mock(import("../../composerDraftStore"), async (original) => {
  const actual = await original();
  const store = actual.useComposerDraftStore;
  return {
    ...actual,
    useComposerDraftStore: Object.assign(
      (selector: Parameters<typeof store>[0]) => selector(store.getState()),
      store,
    ),
  };
});
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function setup(
  owner: "unknown" | "offline" | "ordinary" | "child" | "canonical" | null,
  ownerSettingsPending = owner === "unknown" || owner === "offline",
) {
  const previousState = useComposerDraftStore.getState();
  onTestFinished(() => {
    useComposerDraftStore.setState(previousState, true);
  });
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
  const activeThread = makeThreadFixture();
  const composerDraftTarget = scopeThreadRef(activeThread.environmentId, activeThread.id);
  if (owner === null) {
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(
        scopeProjectRef(activeThread.environmentId, activeThread.projectId),
        DraftId.make("draft-local"),
        { threadId: activeThread.id },
      );
  }
  const instanceId = ProviderInstanceId.make("codex");
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  };
  const onOwnerSettingsPending = vi.fn();
  const onAgentConfigured = vi.fn();
  const confirmComposerSettings = () =>
    resolveComposerSettingsSource({
      owner,
      draft: { modelSelection: null, runtimeMode: null, interactionMode: null },
      thread: owner === null ? null : activeThread,
    }) !== "wait";
  const input = {
    agentConfigured: owner === "canonical",
    onAgentConfigured,
    ownerSettingsPending,
    onOwnerSettingsPending,
    confirmComposerSettings,
    environmentId: activeThread.environmentId,
    composerDraftTarget,
    draftThread: null,
    activeThread,
    activeRuntime: null,
    activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
    settings: DEFAULT_UNIFIED_SETTINGS,
    providerStatuses: [provider],
    lockedProvider: null,
    supportsProviderSwitchingViaHandoff: false,
    multipleModelSelections: null,
    runtimeMode: activeThread.runtimeMode,
    interactionMode: activeThread.interactionMode,
    interactionModeEnabled: true,
    isLocalDraftThread: owner === null,
    canOverrideServerThreadEnvMode: false,
    setPendingServerThreadEnvModeEntry: vi.fn(),
    setPendingServerThreadStartFromOriginByThreadId: vi.fn(),
    scheduleComposerFocus: vi.fn(),
  };
  return { ...input, selection: useComposerSelection(input), instanceId };
}

const edits = ["runtime", "interaction", "model", "Shift+Tab"] as const;
function changeSettings(context: ReturnType<typeof setup>, edit: (typeof edits)[number]) {
  switch (edit) {
    case "runtime":
      context.selection.handleRuntimeModeChangeStable("approval-required");
      break;
    case "interaction":
      context.selection.handleInteractionModeChangeStable("plan");
      break;
    case "model":
      context.selection.onProviderModelSelectStable(context.instanceId, "gpt-5.5");
      break;
    case "Shift+Tab":
      context.selection.toggleInteractionModeStable();
      break;
  }
}

it.each(["unknown", "offline"] as const)(
  "blocks all settings edits for a clean draft while ownership is %s",
  (owner) => {
    const context = setup(owner);
    expect(context.confirmComposerSettings()).toBe(true);
    const before = useComposerDraftStore.getState();
    for (const edit of edits) changeSettings(context, edit);
    expect(useComposerDraftStore.getState()).toBe(before);
    expect(context.onOwnerSettingsPending).toHaveBeenCalledTimes(4);
    expect(context.onAgentConfigured).not.toHaveBeenCalled();
    expect(context.scheduleComposerFocus).not.toHaveBeenCalled();
  },
);

it.each(["ordinary", "child", null] as const)(
  "allows draft and sticky settings edits for ownership %s",
  (owner) => {
    const context = setup(owner);
    for (const edit of edits) changeSettings(context, edit);
    const state = useComposerDraftStore.getState();
    expect(state.getComposerDraft(context.composerDraftTarget)).toMatchObject({
      runtimeMode: "approval-required",
      interactionMode: "plan",
      modelSelectionByProvider: {
        [context.instanceId]: { instanceId: context.instanceId, model: "gpt-5.5" },
      },
    });
    expect(state.stickyModelSelectionByProvider[context.instanceId]).toEqual({
      instanceId: context.instanceId,
      model: "gpt-5.5",
    });
    if (owner === null) {
      expect(state.getDraftThread(context.composerDraftTarget)).toMatchObject({
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
    }
    expect(context.onOwnerSettingsPending).not.toHaveBeenCalled();
    expect(context.onAgentConfigured).not.toHaveBeenCalled();
  },
);

it("directs canonical settings edits to agent configuration before the pending-owner guard", () => {
  const context = setup("canonical", true);
  const before = useComposerDraftStore.getState();
  for (const edit of edits) changeSettings(context, edit);
  expect(useComposerDraftStore.getState()).toBe(before);
  expect(context.onAgentConfigured).toHaveBeenCalledTimes(4);
  expect(context.onOwnerSettingsPending).not.toHaveBeenCalled();
});
