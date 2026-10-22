import {
  assistantHomeTarget,
  captureAssistantConfigurationDraft,
  prepareAssistantConfigurationMutation,
  prepareAssistantLifecycleMutation,
  prepareAssistantStop,
  type AssistantConfigurationDraft,
  type AssistantSelection,
} from "@t3tools/client-runtime/state/assistants";
import {
  AssistantId,
  EnvironmentId,
  UnknownUnionMember,
  type AssistantConfiguration,
  type AssistantDetail,
  type AssistantLifecycleInput,
  type AssistantSummary,
  type ModelSelection,
} from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import * as Dialog from "../../components/ui/Dialog";
import { assistantsEnvironment } from "../../state/assistants";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { WorkBlock, WorkFormActions, WorkText } from "../work/WorkParts";
import { AgentMemorySection } from "./AssistantMemory";
import { AgentResourceBindings } from "./AssistantResources";
import { AgentRoutinesSection } from "./AssistantRoutines";
import {
  INTERACTION_MODE_LABELS,
  RUNTIME_MODE_LABELS,
  assistantAttentionCounts,
  assistantConfigurationChanged,
  assistantConfigurationError,
  assistantDraftState,
  assistantHasStoppableWork,
  assistantRunStatus,
  assistantStatus,
  currentAssistantSelection,
  defaultAssistantConfiguration,
} from "@t3tools/client-runtime/assistant-presentation";
import { AgentInput, AssistantModelChoice, TONE_PREFIX, useOpenAgentChat } from "./AssistantParts";
import {
  newAssistantCommandId,
  useAssistantConnection,
  useAssistantDetail,
  useAssistantRoster,
  useAssistantWriter,
  useCursorPages,
  useMountedRef,
  type AssistantWriter,
} from "./useAssistants";

function useScrollInsets() {
  const insets = useSafeAreaInsets();
  return { paddingBottom: Math.max(insets.bottom, 18) + 18 };
}

export function SettingsAgentsRouteScreen() {
  const style = useScrollInsets();
  const { environments, isReady } = useEnvironments();
  const [includeArchived, setIncludeArchived] = useState(false);
  return (
    <SettingsScreen title="Agents">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={style}
      >
        <ListSection>
          <ListToggleRow
            label="Show archived"
            value={includeArchived}
            onValueChange={setIncludeArchived}
          />
        </ListSection>
        {environments.length === 0 ? (
          <WorkText muted>
            {isReady ? "Pair an environment to create agents there." : "Loading environments…"}
          </WorkText>
        ) : (
          environments.map((environment) => (
            <EnvironmentAgents
              // The archived filter starts its own paging from the first page.
              key={`${environment.environmentId}:${includeArchived}`}
              environment={environment}
              includeArchived={includeArchived}
            />
          ))
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function EnvironmentAgents(props: {
  readonly environment: EnvironmentPresentation;
  readonly includeArchived: boolean;
}) {
  const navigation = useNavigation();
  const environmentId = props.environment.environmentId;
  const pages = useCursorPages();
  const roster = useAssistantRoster(environmentId, props.includeArchived, pages.cursor);
  const connection = useAssistantConnection(environmentId);
  const [creating, setCreating] = useState(false);
  const assistants = roster.data?.assistants ?? [];
  const next = roster.data?.nextCursor ?? null;
  return (
    <ListSection
      title={`${props.environment.label}${connection.connected ? "" : " · offline"}`}
      {...(!connection.connected
        ? { footer: "Last known state. Nothing here is current until it reconnects." }
        : {})}
    >
      {roster.data === null ? (
        <WorkBlock>
          <WorkText muted>
            {roster.error
              ? "Agents aren't available here. It may need a newer server."
              : connection.connected
                ? "Loading agents…"
                : "Offline"}
          </WorkText>
        </WorkBlock>
      ) : assistants.length === 0 && !creating ? (
        <WorkBlock>
          <WorkText muted>No agents yet. Creating one never starts a run.</WorkText>
        </WorkBlock>
      ) : (
        assistants.map((assistant) => {
          const status = assistantStatus({ connected: connection.connected, summary: assistant });
          return (
            <ListRow
              key={assistant.assistantId}
              icon="person.crop.circle"
              label={assistant.name}
              description={`${TONE_PREFIX[status.tone]}${status.label}${status.detail ? ` · ${status.detail}` : ""}`}
              onPress={() =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: {
                    screen: "SettingsAgent",
                    params: { environmentId, assistantId: assistant.assistantId },
                  },
                })
              }
            />
          );
        })
      )}
      {pages.hasPrevious ? (
        <ListActionRow label="Previous agents" onPress={pages.previous} />
      ) : null}
      {next !== null ? (
        <ListActionRow label="More agents" onPress={() => pages.next(next)} />
      ) : null}
      {creating ? (
        <CreateAgentForm environmentId={environmentId} onDone={() => setCreating(false)} />
      ) : (
        <ListActionRow
          icon="plus"
          label="New agent"
          disabled={!connection.connected}
          onPress={() => setCreating(true)}
        />
      )}
    </ListSection>
  );
}

function CreateAgentForm(props: {
  readonly environmentId: EnvironmentId;
  readonly onDone: () => void;
}) {
  const writer = useAssistantWriter(props.environmentId);
  const connection = useAssistantConnection(props.environmentId);
  const navigation = useNavigation();
  const mounted = useMountedRef();
  const [name, setName] = useState("");
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [commandId] = useState(newAssistantCommandId);
  const pending = writer.pendingKey === "create";
  const configuration = model === null ? null : defaultAssistantConfiguration(name, model);
  const invalid =
    configuration === null ? "Choose a model." : assistantConfigurationError(configuration);
  const blocked = !connection.connected
    ? "Reconnect to create an agent."
    : writer.permissions.create
      ? null
      : "This connection isn't allowed to create agents.";
  return (
    <>
      <WorkBlock>
        <AgentInput
          label="Name"
          value={name}
          onChange={setName}
          maxLength={120}
          disabled={pending}
        />
      </WorkBlock>
      <AssistantModelChoice
        environmentId={props.environmentId}
        selection={model}
        disabled={writer.pendingKey !== null}
        onChange={setModel}
      />
      <WorkBlock>
        <WorkText muted>
          The agent gets its own chat and private memory. Rules, tools and routines can be set after
          creating it.
        </WorkText>
        <WorkFormActions
          submitLabel="Create agent"
          pending={pending}
          disabled={invalid !== null || blocked !== null}
          failure={writer.failureFor("create") ?? blocked}
          onCancel={props.onDone}
          onSubmit={async () => {
            if (configuration === null || !mounted.current) return;
            const result = await writer.run("create", assistantsEnvironment.create, {
              environmentId: props.environmentId,
              commandId,
              configuration,
            });
            // The agent exists either way; a form left meanwhile must not navigate anywhere.
            if (result === null || !mounted.current) return;
            props.onDone();
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: {
                screen: "SettingsAgent",
                params: {
                  environmentId: props.environmentId,
                  assistantId: result.summary.assistantId,
                },
              },
            });
          }}
        />
      </WorkBlock>
    </>
  );
}

type AgentSection = "overview" | "activity" | "configuration" | "memory" | "routines";
const SECTIONS: ReadonlyArray<{ value: AgentSection; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "activity", label: "Activity" },
  { value: "configuration", label: "Setup" },
  { value: "memory", label: "Memory" },
  { value: "routines", label: "Routines" },
];

export interface MobileAgentContext {
  readonly environmentId: EnvironmentId;
  readonly detail: AssistantDetail;
  readonly connected: boolean;
  readonly epoch: string | null;
  readonly selection: AssistantSelection | null;
  readonly latestSelection: () => AssistantSelection | null;
  readonly writer: AssistantWriter;
}

export function agentBlockedReason(context: MobileAgentContext, allowed: boolean) {
  if (!context.connected || context.selection === null) return "Reconnect to make changes.";
  return allowed ? null : "This connection isn't allowed to do that.";
}

export function SettingsAgentRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: string;
  readonly assistantId: string;
  readonly section?: AgentSection;
}>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const assistantId = AssistantId.make(route.params.assistantId);
  const style = useScrollInsets();
  // The roster stream is what refreshes this detail when another client changes it.
  useAssistantRoster(environmentId, true);
  const detailQuery = useAssistantDetail(environmentId, assistantId);
  const connection = useAssistantConnection(environmentId);
  const writer = useAssistantWriter(environmentId);
  const [section, setSection] = useState<AgentSection>(route.params.section ?? "overview");
  const detail = detailQuery.data;
  const selection = currentAssistantSelection(detail, connection.epoch);
  const latest = useRef(selection);
  useEffect(() => {
    latest.current = selection;
  });
  return (
    <SettingsScreen title={detail?.summary.name ?? "Agent"}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={style}
      >
        {detail === null ? (
          <WorkText muted>
            {detailQuery.error
              ? "This agent isn't available. It may have been removed."
              : connection.connected
                ? "Loading agent…"
                : "Offline"}
          </WorkText>
        ) : (
          <>
            <SegmentedControl
              options={SECTIONS}
              selected={section}
              onSelect={setSection}
              size="compact"
              role="tab"
            />
            <MobileAgentSection
              key={`${environmentId}:${assistantId}`}
              section={section}
              onOpenSection={setSection}
              context={{
                environmentId,
                detail,
                connected: connection.connected,
                epoch: connection.epoch,
                selection,
                latestSelection: () => latest.current,
                writer,
              }}
            />
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function MobileAgentSection(props: {
  readonly section: AgentSection;
  readonly context: MobileAgentContext;
  readonly onOpenSection: (section: AgentSection) => void;
}) {
  switch (props.section) {
    case "overview":
      return <Overview context={props.context} />;
    case "activity":
      return <Activity context={props.context} />;
    case "configuration":
      return (
        <Configuration context={props.context} onOpenMemory={() => props.onOpenSection("memory")} />
      );
    case "memory":
      return <AgentMemorySection context={props.context} />;
    case "routines":
      return <AgentRoutinesSection context={props.context} />;
  }
}

const LIFECYCLE: Record<
  AssistantLifecycleInput["action"],
  { readonly label: string; readonly message?: string; readonly destructive?: boolean }
> = {
  disable: {
    label: "Disable",
    message:
      "Routines and queued messages won't start new runs until you enable it. Running work continues until you stop it.",
  },
  enable: { label: "Enable" },
  archive: {
    label: "Archive",
    destructive: true,
    message:
      "It stops admitting new runs and routines. Chat and memory are kept and you can restore it. Running work continues until you stop it.",
  },
  restore: {
    label: "Restore",
    message: "Chat and memory come back. Routines stay paused until you turn them on.",
  },
  "retry-provisioning": { label: "Retry setup" },
};

function confirmThen(
  title: string,
  message: string | undefined,
  destructive: boolean,
  run: () => void,
) {
  if (message === undefined) return run();
  Dialog.confirm({
    title,
    message,
    confirmText: title,
    destructive,
    onConfirm: run,
  });
}

function Overview({ context }: { readonly context: MobileAgentContext }) {
  const { detail, writer } = context;
  const summary: AssistantSummary = detail.summary;
  const openChat = useOpenAgentChat();
  const status = assistantStatus({ connected: context.connected, summary });
  const counts = assistantAttentionCounts(summary);
  const provisioning =
    detail.provisioning instanceof UnknownUnionMember
      ? { state: "unknown" as const, value: detail.provisioning.value }
      : detail.provisioning;
  const lifecycleBlocked = agentBlockedReason(context, writer.permissions.lifecycle);
  const stopBlocked = agentBlockedReason(context, writer.permissions.stop);
  // A retry of an unconfirmed Stop reuses its ID; once one is accepted, the next Stop is new work.
  const [stopCommandId, setStopCommandId] = useState(newAssistantCommandId);

  const lifecycle = (action: AssistantLifecycleInput["action"]) => {
    const selected = context.selection;
    if (selected === null) return;
    const copy = LIFECYCLE[action];
    confirmThen(copy.label, copy.message, copy.destructive === true, () => {
      const current = context.latestSelection();
      void writer.run(
        "lifecycle",
        assistantsEnvironment.lifecycle,
        current === null
          ? null
          : prepareAssistantLifecycleMutation({
              selected,
              current,
              commandId: newAssistantCommandId(),
              action,
            }),
      );
    });
  };
  const actions: ReadonlyArray<AssistantLifecycleInput["action"]> =
    summary.lifecycle === "archived"
      ? ["restore"]
      : summary.lifecycle === "disabled"
        ? ["enable", "archive"]
        : ["disable", "archive"];
  const home = assistantHomeTarget(summary.binding);

  return (
    <>
      <ListSection title="Status">
        <WorkBlock>
          <WorkText>{`${TONE_PREFIX[status.tone]}${status.label}`}</WorkText>
          {status.detail ? <WorkText muted>{status.detail}</WorkText> : null}
          {context.connected && counts.length > 0 ? (
            <WorkText muted>{counts.join(" · ")}</WorkText>
          ) : null}
          <WorkText muted>{`Configuration r${summary.configurationRevision}`}</WorkText>
        </WorkBlock>
        <ListActionRow
          icon="bubble.left"
          label="Open chat"
          disabled={provisioning.state !== "ready"}
          onPress={() => openChat({ environmentId: home.environmentId, threadId: home.threadId })}
        />
      </ListSection>
      {provisioning.state === "failed" || provisioning.state === "needs-repair" ? (
        <ListSection title={provisioning.state === "failed" ? "Setup failed" : "Needs repair"}>
          <WorkBlock>
            <WorkText muted>{provisioning.reason}</WorkText>
          </WorkBlock>
          {provisioning.state === "failed" && provisioning.retryable ? (
            <ListActionRow
              icon="arrow.clockwise"
              label="Retry setup"
              disabled={lifecycleBlocked !== null || writer.pendingKey !== null}
              onPress={() => lifecycle("retry-provisioning")}
            />
          ) : null}
        </ListSection>
      ) : provisioning.state === "provisioning" || provisioning.state === "unknown" ? (
        <WorkText muted>
          {provisioning.state === "provisioning"
            ? `Setting up its workspace (${provisioning.stage}).`
            : `Setup state: ${provisioning.value}`}
        </WorkText>
      ) : null}
      <ListSection
        title="Lifecycle"
        footer="Changing the lifecycle never starts a run. History and memory are kept."
      >
        {actions.map((action) => (
          <ListActionRow
            key={action}
            label={LIFECYCLE[action].label}
            tone={LIFECYCLE[action].destructive ? "danger" : "default"}
            disabled={lifecycleBlocked !== null || writer.pendingKey !== null}
            loading={writer.pendingKey === "lifecycle"}
            onPress={() => lifecycle(action)}
          />
        ))}
        <ListActionRow
          icon="stop.fill"
          label="Stop current work"
          tone="danger"
          disabled={
            stopBlocked !== null ||
            writer.pendingKey !== null ||
            !assistantHasStoppableWork(summary)
          }
          onPress={() => {
            const selected = context.selection;
            if (selected === null) return;
            confirmThen(
              "Stop",
              "Queued and running turns in its chat are stopped. If a provider can't confirm the stop, it stays marked uncertain.",
              true,
              () => {
                const current = context.latestSelection();
                const prepared =
                  current === null
                    ? null
                    : prepareAssistantStop({ selected, current, commandId: stopCommandId });
                void writer
                  .run("stop", assistantsEnvironment.stop, prepared?.input ?? null)
                  .then((result) => {
                    if (result !== null) setStopCommandId(newAssistantCommandId());
                  });
              },
            );
          }}
        />
      </ListSection>
      {(writer.failureFor("lifecycle") ?? writer.failureFor("stop") ?? lifecycleBlocked) ? (
        <Notice
          tone={
            (writer.failureFor("lifecycle") ?? writer.failureFor("stop")) ? "danger" : "default"
          }
          message={
            (writer.failureFor("lifecycle") ?? writer.failureFor("stop") ?? lifecycleBlocked)!
          }
        />
      ) : null}
    </>
  );
}

function Activity({ context }: { readonly context: MobileAgentContext }) {
  const { environmentId, detail } = context;
  const pages = useCursorPages();
  const query = useEnvironmentQuery(
    assistantsEnvironment.activity({
      environmentId,
      input: {
        environmentId,
        assistantId: detail.summary.assistantId,
        limit: 25,
        ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
      },
    }),
  );
  const runs = query.data?.runs ?? [];
  const next = query.data?.nextCursor ?? null;
  return (
    <ListSection
      title="Activity"
      footer="A sent message counts as finished only when its run completes."
    >
      {query.data === null ? (
        <WorkBlock>
          <WorkText muted>
            {query.error ? "Activity isn't available." : "Loading activity…"}
          </WorkText>
        </WorkBlock>
      ) : runs.length === 0 ? (
        <WorkBlock>
          <WorkText muted>No runs yet.</WorkText>
        </WorkBlock>
      ) : (
        runs.map((run) => {
          const status = assistantRunStatus(run);
          return (
            <WorkBlock key={`${run.commandId}:${run.runId ?? "dispatch"}`}>
              <WorkText>{`${TONE_PREFIX[status.tone]}${status.label}`}</WorkText>
              <WorkText muted>
                {`${run.scheduledTaskId === null ? "Chat" : "Routine"} · configuration r${run.configurationRevision} · ${new Date(run.updatedAt).toLocaleString()}`}
              </WorkText>
            </WorkBlock>
          );
        })
      )}
      {pages.hasPrevious ? <ListActionRow label="Newer" onPress={pages.previous} /> : null}
      {next !== null ? <ListActionRow label="Older" onPress={() => pages.next(next)} /> : null}
    </ListSection>
  );
}

function Configuration({
  context,
  onOpenMemory,
}: {
  readonly context: MobileAgentContext;
  readonly onOpenMemory: () => void;
}) {
  const { detail, writer } = context;
  const saved = detail.configuration.configuration;
  const [session, setSession] = useState<{
    readonly draft: AssistantConfigurationDraft;
    readonly commandId: ReturnType<typeof newAssistantCommandId>;
  } | null>(null);
  const blocked = agentBlockedReason(context, writer.permissions.configure);
  const pending = writer.pendingKey === "configure";
  const begin = () => {
    if (context.epoch === null) return;
    setSession({
      draft: captureAssistantConfigurationDraft(detail, context.epoch),
      commandId: newAssistantCommandId(),
    });
  };
  const configuration = session?.draft.configuration ?? saved;
  // Fields lock while saving, so a successful save never discards later edits.
  const locked = session === null || pending;
  const state = session
    ? assistantDraftState(session.draft, { detail, epoch: context.epoch })
    : null;
  const update = (patch: Partial<AssistantConfiguration>) => {
    if (session === null || pending) return;
    setSession({
      ...session,
      draft: { ...session.draft, configuration: { ...session.draft.configuration, ...patch } },
    });
  };
  const memory = configuration.memory;
  const changed = assistantConfigurationChanged(configuration, saved);
  const invalid = assistantConfigurationError(configuration);

  return (
    <>
      {state !== null && state.kind !== "current" ? (
        <View className="gap-2">
          <Notice
            icon="info.circle"
            message={
              state.kind === "offline"
                ? "Offline. Your edits are kept; reconnect to save."
                : state.reason
            }
          />
          {state.kind === "stale" ? (
            <ListSection>
              <ListActionRow
                label="Discard edits and open the current version"
                disabled={pending}
                onPress={begin}
              />
            </ListSection>
          ) : null}
        </View>
      ) : null}
      <ListSection
        title={`Configuration r${session?.draft.selected.configurationRevision ?? detail.configuration.revision}`}
        footer="Changes apply to its next runs. Saving never starts a run."
      >
        {session !== null ? (
          <WorkBlock>
            <AgentInput
              label="Name"
              value={configuration.name}
              maxLength={120}
              disabled={locked}
              onChange={(name) => update({ name })}
            />
            <AgentInput
              label="Rules"
              multiline
              maxLength={65536}
              disabled={locked}
              value={configuration.rules}
              onChange={(rules) => update({ rules })}
            />
            <AgentInput
              label="Prompt"
              multiline
              maxLength={65536}
              disabled={locked}
              value={configuration.prompt}
              onChange={(prompt) => update({ prompt })}
            />
            <AgentInput
              label="Personality"
              multiline
              maxLength={65536}
              disabled={locked}
              value={configuration.personality}
              onChange={(personality) => update({ personality })}
            />
          </WorkBlock>
        ) : (
          <WorkBlock>
            <WorkText>{configuration.name}</WorkText>
            {(["rules", "prompt", "personality"] as const).map((key) =>
              configuration[key].trim() ? (
                <WorkText key={key} muted>
                  {`${key[0]!.toUpperCase()}${key.slice(1)}: ${configuration[key]}`}
                </WorkText>
              ) : null,
            )}
          </WorkBlock>
        )}
        <AssistantModelChoice
          environmentId={context.environmentId}
          selection={configuration.modelSelection}
          disabled={locked}
          onChange={(modelSelection) => update({ modelSelection })}
        />
      </ListSection>
      <ListSection title="Runtime mode">
        {(Object.keys(RUNTIME_MODE_LABELS) as Array<keyof typeof RUNTIME_MODE_LABELS>).map(
          (mode) => (
            <ListChoiceRow
              key={mode}
              label={RUNTIME_MODE_LABELS[mode]}
              selected={configuration.runtimeMode === mode}
              disabled={locked}
              onPress={() => update({ runtimeMode: mode })}
            />
          ),
        )}
      </ListSection>
      <ListSection title="Interaction">
        {(Object.keys(INTERACTION_MODE_LABELS) as Array<keyof typeof INTERACTION_MODE_LABELS>).map(
          (mode) => (
            <ListChoiceRow
              key={mode}
              label={INTERACTION_MODE_LABELS[mode]}
              selected={configuration.interactionMode === mode}
              disabled={locked}
              onPress={() => update({ interactionMode: mode })}
            />
          ),
        )}
      </ListSection>
      <ListSection
        title="Memory"
        footer="Extraction and external indexing routes are set under Memory processing. They are off unless you turn them on there."
      >
        <ListToggleRow
          label="Remember useful facts automatically"
          value={memory.automaticCapture}
          disabled={locked}
          onValueChange={(automaticCapture) => update({ memory: { ...memory, automaticCapture } })}
        />
        <ListToggleRow
          label="Allow the agent to create routines"
          value={memory.allowRoutineCreation}
          disabled={locked}
          onValueChange={(allowRoutineCreation) =>
            update({ memory: { ...memory, allowRoutineCreation } })
          }
        />
        {/* Fallback extraction and external indexing run only from Memory's processing routes;
            the configuration's own fields for them are stored but never read. */}
        <ListActionRow label="Memory processing" onPress={onOpenMemory} />
      </ListSection>
      <AgentResourceBindings
        binding={detail.summary.binding}
        providerInstanceId={configuration.modelSelection.instanceId}
        value={configuration.resources}
        disabled={locked}
        onChange={(resources) => update({ resources })}
      />
      {session !== null ? (
        <WorkFormActions
          submitLabel="Save"
          pending={pending}
          disabled={!changed || invalid !== null || state?.kind !== "current" || blocked !== null}
          failure={writer.failureFor("configure") ?? (changed ? invalid : null)}
          onCancel={() => setSession(null)}
          onSubmit={async () => {
            const submitted = session;
            const result = await writer.run(
              "configure",
              assistantsEnvironment.updateConfiguration,
              context.selection === null
                ? null
                : prepareAssistantConfigurationMutation({
                    draft: submitted.draft,
                    current: context.selection,
                    commandId: submitted.commandId,
                  }),
            );
            if (result !== null) setSession(null);
          }}
        />
      ) : (
        <ListSection {...(blocked ? { footer: blocked } : {})}>
          <ListActionRow icon="pencil" label="Edit" disabled={blocked !== null} onPress={begin} />
        </ListSection>
      )}
    </>
  );
}
