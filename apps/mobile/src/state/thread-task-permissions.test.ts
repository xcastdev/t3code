import {
  AuthOrchestrationOperateScope,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  v2Now,
  v2Projection,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { AsyncResult, type Atom } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  grantedEnvironments: new Set<string>(),
  connectionState: "connected",
  draft: {
    text: "Keep my draft",
    attachments: [] as DraftComposerImageAttachment[],
    modelSelection: undefined as ModelSelection | undefined,
    runtimeMode: undefined as RuntimeMode | undefined,
    interactionMode: undefined as ProviderInteractionMode | undefined,
  },
  ownerKind: "ordinary" as "offline" | "unknown" | "ordinary" | "canonical" | "child",
  serverConfig: null as ServerConfig | null,
  projection: null as OrchestrationV2ThreadProjection | null,
  pendingRequests: { approvals: [], userInputs: [] } as PendingThreadRequests,
  enqueue: vi.fn(async () => undefined),
  clearDraft: vi.fn(),
  approve: vi.fn(),
  answer: vi.fn(),
  feedback: vi.fn(),
  updateSettings: vi.fn(),
  question: {
    id: "language",
    header: "Language",
    question: "Which language?",
    options: [{ label: "TypeScript", description: "Use the existing code" }],
    multiSelect: false,
  },
  thread: {
    id: "thread",
    environmentId: "secondary",
    projectId: "project",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    latestRun: null,
  },
}));

vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: () => {},
  useRef: <A>(current: A) => ({ current }),
  useMemo: <A>(factory: () => A) => factory(),
  useState: <A>(initial: A | (() => A)) => [
    typeof initial === "function" ? (initial as () => A)() : initial,
    vi.fn(),
  ],
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "uuid" }));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: vi.fn() }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid" }));
vi.mock("./queued-run-edit", () => ({
  useQueuedRunEdit: () => null,
  getQueuedRunEdit: () => null,
}));
vi.mock("./preferences", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return { mobilePreferencesAtom: Atom.make(AsyncResult.success({})) };
});
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@effect/atom-react", async () => {
  const { appAtomRegistry } = await import("./atom-registry");
  return { useAtomValue: <A>(atom: Atom.Atom<A>) => appAtomRegistry.get(atom) };
});
vi.mock("./entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("./session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.grantedEnvironments.has(environmentId),
}));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: state.thread,
    selectedThreadCreation: null,
    selectedEnvironmentRuntime: {
      connectionState: state.connectionState,
      serverConfig: state.serverConfig,
    },
  }),
}));
vi.mock("./use-thread-detail", () => ({
  useSelectedThreadProjection: () =>
    state.projection === null ? null : { projection: state.projection },
  useSelectedThreadVisibleTurnItems: () => [],
  useSelectedThreadPendingRequests: () => state.pendingRequests,
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: <A>(command: A) => command }));
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadDetails: {
      queueWorkflowAtom: () => Atom.make(null),
      checkpointSummariesAtom: () => Atom.make([]),
    },
    threadEnvironment: {
      respondToApproval: state.approve,
      respondToUserInput: state.answer,
      uploadFeedback: state.feedback,
    },
  };
});
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return { dispatchingQueuedMessageIdAtom: Atom.make(null), useThreadOutboxMessages: () => ({}) };
});
vi.mock("./thread-outbox", () => ({ enqueueThreadOutboxMessage: state.enqueue }));
vi.mock("./composer-attachment-uploads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerAttachmentUploadsAtom: Atom.make({}),
    composerAttachmentUploadBlockReason: () => null,
    composerAttachmentsStillUploading: () => false,
  };
});
vi.mock("./use-composer-drafts", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerDraftsAtom: Atom.make({}),
    composerContextImportsAtom: Atom.make({}),
    getComposerDraftSnapshot: () => state.draft,
    clearComposerDraftContent: state.clearDraft,
    clearComposerDraft: state.clearDraft,
    setComposerDraftText: (_key: string, text: string) => {
      state.draft.text = text;
    },
    updateComposerDraftSettings: state.updateSettings,
    ensureComposerDraftsLoaded: () => {},
    scheduleUnusedComposerAttachmentCleanup: () => {},
    appendComposerDraftAttachments: vi.fn(),
    appendComposerDraftText: vi.fn(),
    mergeComposerDraftContent: vi.fn(),
    removeComposerDraftAttachment: vi.fn(),
    useComposerDraft: () => state.draft,
    useComposerDraftSettings: () => state.draft,
    questionAttachmentDraftsAtom: () => Atom.make({}),
  };
});
vi.mock("../lib/composerImages", () => ({
  convertPastedImagesToAttachments: vi.fn(),
  pasteComposerClipboard: vi.fn(),
  pickComposerFiles: vi.fn(),
  pickComposerMedia: vi.fn(),
}));
vi.mock("../lib/commandMetadata", () => ({
  makeQueuedMessageMetadata: () => ({
    messageId: "message",
    commandId: "command",
    createdAt: "2026-09-05T00:00:00.000Z",
  }),
}));
vi.mock("../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("./use-remote-environment-registry", () => ({ setPendingConnectionError: vi.fn() }));
vi.mock("../features/assistants/useAgentThreadOwner", () => ({
  useAgentThreadOwner: () => ({ kind: state.ownerKind }),
}));

import { useThreadComposerState } from "./use-thread-composer-state";
import { useSelectedThreadRequests } from "./use-selected-thread-requests";

beforeEach(() => {
  state.grantedEnvironments = new Set(["primary"]);
  state.connectionState = "connected";
  state.draft = {
    text: "Keep my draft",
    attachments: [],
    modelSelection: undefined,
    runtimeMode: undefined,
    interactionMode: undefined,
  };
  state.ownerKind = "ordinary";
  state.thread.modelSelection = { instanceId: "codex", model: "gpt-5.4" };
  state.thread.interactionMode = "default";
  state.projection = null;
  state.serverConfig = {
    providers: [
      { instanceId: "codex", driver: "codex", enabled: true },
      { instanceId: "grok", driver: "grok", enabled: true, showInteractionModeToggle: false },
    ],
    environment: { capabilities: {} },
  } as unknown as ServerConfig;
  state.pendingRequests = {
    approvals: [
      {
        requestId: RuntimeRequestId.make("approval"),
        requestKind: "command",
        createdAt: "2026-09-05T00:00:00.000Z",
        responseCapability: "live",
      },
    ],
    userInputs: [],
  };
  vi.clearAllMocks();
  state.approve.mockResolvedValue(AsyncResult.success(undefined));
  state.answer.mockResolvedValue(AsyncResult.success(undefined));
  state.feedback.mockResolvedValue(AsyncResult.success({ feedbackId: "feedback" }));
});

describe("mobile task permissions", () => {
  it("keeps a connected read-only task's draft instead of queueing it with another environment's grant", async () => {
    const composer = useThreadComposerState();
    expect(await composer.onSendMessage()).toBeNull();
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();
    composer.onChangeDraftMessage("Edited locally");
    composer.onUpdateInteractionMode("plan");
    expect(state.draft.text).toBe("Edited locally");
    expect(state.updateSettings).toHaveBeenCalledWith("secondary:thread", {
      interactionMode: "plan",
    });
  });

  it("rechecks a retained send callback before clearing or queueing the draft", async () => {
    state.grantedEnvironments.add("secondary");
    const composer = useThreadComposerState();
    state.grantedEnvironments.delete("secondary");
    expect(await composer.onSendMessage()).toBeNull();
    expect(state.clearDraft).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
    state.grantedEnvironments.add("secondary");
    expect(await composer.onSendMessage()).toBe("message");
    expect(state.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "secondary",
        threadId: "thread",
        text: "Keep my draft",
      }),
    );
  });

  it("rechecks the target environment before an approval response", async () => {
    state.grantedEnvironments.add("secondary");
    const requests = useSelectedThreadRequests();
    state.grantedEnvironments.delete("secondary");
    await requests.onRespondToApproval(RuntimeRequestId.make("approval"), "accept");
    expect(state.approve).not.toHaveBeenCalled();
    state.grantedEnvironments.add("secondary");
    await requests.onRespondToApproval(RuntimeRequestId.make("approval"), "accept");
    expect(state.approve).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: { threadId: "thread", requestId: "approval", decision: "accept" },
    });
  });

  it("keeps answer drafts editable after revocation while blocking their submission", async () => {
    state.pendingRequests = {
      approvals: [],
      userInputs: [
        {
          requestId: RuntimeRequestId.make("input"),
          createdAt: "2026-09-05T00:00:00.000Z",
          responseCapability: "live",
          dismissible: false,
          questions: [state.question],
        },
      ],
    };
    const requestId = RuntimeRequestId.make("input");
    useSelectedThreadRequests().onSelectUserInputOption(requestId, state.question, "TypeScript");
    state.grantedEnvironments.add("secondary");
    const requests = useSelectedThreadRequests();
    expect(requests.activePendingUserInputAnswers).toEqual({ language: "TypeScript" });
    state.grantedEnvironments.delete("secondary");
    await requests.onSubmitUserInput();
    expect(state.answer).not.toHaveBeenCalled();
    expect(useSelectedThreadRequests().activePendingUserInputAnswers).toEqual({
      language: "TypeScript",
    });
    state.grantedEnvironments.add("secondary");
    await requests.onSubmitUserInput();
    expect(state.answer).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: { threadId: "thread", requestId: "input", answers: { language: "TypeScript" } },
    });
  });
});

describe("mobile handoff preview and submission", () => {
  it("follows project enablement and provider availability for the selected destination", async () => {
    state.grantedEnvironments.add("secondary");
    const instanceId = ProviderInstanceId.make("antigravity");
    const projectId = ProjectId.make(state.thread.projectId);
    const selection = { instanceId, model: "gemini" };
    const provider = {
      instanceId,
      driver: ProviderDriverKind.make("antigravity"),
      enabled: false,
      installed: true,
      auth: { status: "authenticated" as const },
      availability: "available" as "available" | "unavailable",
      models: [{ slug: selection.model }],
    };
    const projectOverride = { enabled: false };
    state.serverConfig = {
      ...state.serverConfig,
      providers: [provider],
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: { [instanceId]: { driver: provider.driver, enabled: false } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: projectOverride } },
        },
      },
    } as unknown as ServerConfig;
    state.draft.modelSelection = selection;
    const source = v2Projection.thread.modelSelection;
    state.projection = {
      ...v2Projection,
      runs: [
        {
          id: RunId.make("source-run"),
          threadId: v2Projection.thread.id,
          ordinal: 1,
          providerInstanceId: source.instanceId,
          modelSelection: source,
          providerThreadId: null,
          userMessageId: MessageId.make("source-message"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: v2Now,
          startedAt: v2Now,
          completedAt: v2Now,
          checkpointId: null,
          contextHandoffId: null,
        },
      ],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: v2Projection.thread.id,
          sourceItemId: TurnItemId.make("reply"),
          item: {
            id: TurnItemId.make("reply"),
            threadId: v2Projection.thread.id,
            runId: RunId.make("source-run"),
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            type: "assistant_message",
            messageId: MessageId.make("reply"),
            status: "completed",
            title: null,
            text: "Task started",
            streaming: false,
            startedAt: v2Now,
            completedAt: v2Now,
            updatedAt: v2Now,
          },
        },
      ],
    };

    const disabled = useThreadComposerState();
    expect(disabled.pendingHandoff).toBeNull();
    expect(await disabled.onSendMessage()).toBeNull();
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();

    projectOverride.enabled = true;
    expect(useThreadComposerState().pendingHandoff).toEqual({ from: [source], to: selection });

    provider.availability = "unavailable";
    const unavailable = useThreadComposerState();
    expect(unavailable.pendingHandoff).toBeNull();
    expect(await unavailable.onSendMessage()).toBeNull();
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();

    provider.availability = "available";
    const available = useThreadComposerState();
    expect(available.pendingHandoff).toEqual({ from: [source], to: selection });
    expect(await available.onSendMessage()).toBe("message");
    expect(state.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        modelSelection: selection,
        text: "Keep my draft",
      }),
    );
    expect(state.clearDraft).toHaveBeenCalledTimes(1);
  });
});

describe("mobile agent-owned composer settings", () => {
  function stageConflictingOverrides() {
    state.grantedEnvironments.add("secondary");
    state.draft.modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "old-model",
    };
    state.draft.runtimeMode = "approval-required";
    state.draft.interactionMode = "plan";
  }

  it("sends a canonical home with its current synchronized settings, not persisted overrides", async () => {
    stageConflictingOverrides();
    state.ownerKind = "canonical";
    const composer = useThreadComposerState();
    expect(composer.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.4" });
    expect(composer.runtimeMode).toBe("full-access");
    expect(composer.interactionMode).toBe("default");
    expect(await composer.onSendMessage()).toBe("message");
    expect(state.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "Keep my draft",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    );

    // The agent's configuration changed on the server while the composer stayed mounted.
    state.thread.modelSelection = { instanceId: "codex", model: "gpt-5.5" };
    const remounted = useThreadComposerState();
    expect(remounted.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.5" });
    expect(await remounted.onSendMessage()).toBe("message");
    expect(state.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelSelection: { instanceId: "codex", model: "gpt-5.5" } }),
    );
  });

  it("shows and queues a canonical home's saved Plan mode on a provider without a mode toggle", async () => {
    state.grantedEnvironments.add("secondary");
    state.ownerKind = "canonical";
    state.thread.modelSelection = { instanceId: "grok", model: "grok-code-fast-1" };
    state.thread.interactionMode = "plan";
    const composer = useThreadComposerState();
    expect(composer.interactionMode).toBe("plan");
    expect(await composer.onSendMessage()).toBe("message");
    expect(state.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ interactionMode: "plan", settingsSource: "agent" }),
    );

    // The agent's configuration moved back to Default on the server.
    state.thread.interactionMode = "default";
    const updated = useThreadComposerState();
    expect(updated.interactionMode).toBe("default");
    expect(await updated.onSendMessage()).toBe("message");
    expect(state.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ interactionMode: "default", settingsSource: "agent" }),
    );
  });

  it.each(["ordinary", "child"] as const)(
    "still normalizes a %s Plan override for a provider without a mode toggle",
    async (kind) => {
      state.grantedEnvironments.add("secondary");
      state.ownerKind = kind;
      state.thread.modelSelection = { instanceId: "grok", model: "grok-code-fast-1" };
      state.draft.interactionMode = "plan";
      const composer = useThreadComposerState();
      expect(composer.interactionMode).toBe("default");
      expect(await composer.onSendMessage()).toBe("message");
      expect(state.enqueue).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ settingsSource: "agent" }),
      );
      expect(state.enqueue).toHaveBeenLastCalledWith(
        expect.objectContaining({ interactionMode: "default" }),
      );
    },
  );

  it("keeps a canonical home's settings out of local drafts", () => {
    state.ownerKind = "canonical";
    const composer = useThreadComposerState();
    composer.onUpdateModelSelection({ instanceId: ProviderInstanceId.make("codex"), model: "x" });
    composer.onUpdateRuntimeMode("approval-required");
    composer.onUpdateInteractionMode("plan");
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it.each(["unknown", "offline"] as const)(
    "while ownership is %s, writes no overrides and holds a conflicting send with its content",
    async (kind) => {
      stageConflictingOverrides();
      state.ownerKind = kind;
      const composer = useThreadComposerState();
      composer.onUpdateModelSelection({ instanceId: ProviderInstanceId.make("codex"), model: "x" });
      composer.onUpdateRuntimeMode("full-access");
      composer.onUpdateInteractionMode("default");
      expect(state.updateSettings).not.toHaveBeenCalled();
      expect(await composer.onSendMessage()).toBeNull();
      expect(state.enqueue).not.toHaveBeenCalled();
      expect(state.clearDraft).not.toHaveBeenCalled();

      state.draft.modelSelection = undefined;
      state.draft.runtimeMode = undefined;
      state.draft.interactionMode = undefined;
      expect(await useThreadComposerState().onSendMessage()).toBe("message");
      expect(state.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ modelSelection: { instanceId: "codex", model: "gpt-5.4" } }),
      );
    },
  );

  it.each(["unknown", "offline"] as const)(
    "while ownership is %s, holds a saved Plan mode the provider would normalize away",
    async (kind) => {
      state.grantedEnvironments.add("secondary");
      state.ownerKind = kind;
      state.thread.modelSelection = { instanceId: "grok", model: "grok-code-fast-1" };
      state.thread.interactionMode = "plan";
      expect(await useThreadComposerState().onSendMessage()).toBeNull();
      expect(state.enqueue).not.toHaveBeenCalled();
      expect(state.clearDraft).not.toHaveBeenCalled();
      expect(state.draft.text).toBe("Keep my draft");

      state.ownerKind = "canonical";
      expect(await useThreadComposerState().onSendMessage()).toBe("message");
      expect(state.enqueue).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          text: "Keep my draft",
          interactionMode: "plan",
          settingsSource: "agent",
        }),
      );
    },
  );

  it.each(["ordinary", "child"] as const)("keeps %s draft overrides", async (kind) => {
    stageConflictingOverrides();
    state.ownerKind = kind;
    const composer = useThreadComposerState();
    composer.onUpdateRuntimeMode("full-access");
    expect(state.updateSettings).toHaveBeenCalledWith("secondary:thread", {
      runtimeMode: "full-access",
    });
    expect(await composer.onSendMessage()).toBe("message");
    expect(state.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: { instanceId: "codex", model: "old-model" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }),
    );
  });
});
