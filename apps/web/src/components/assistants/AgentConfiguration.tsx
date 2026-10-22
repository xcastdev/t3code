import {
  captureAssistantConfigurationDraft,
  prepareAssistantConfigurationMutation,
  type AssistantConfigurationDraft,
} from "@t3tools/client-runtime/state/assistants";
import { CommandId, type AssistantConfiguration } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { assistantsEnvironment } from "../../state/assistants";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  WorkField,
  WorkFormStatus,
  WorkMeta,
  WorkRevision,
  WorkRow,
  WorkSection,
} from "../work/WorkLayout";
import { agentBlockedReason, type AgentContext } from "./AgentDetailPage";
import { AgentResourceBindings } from "./AgentResourceBindings";
import {
  INTERACTION_MODE_LABELS,
  RUNTIME_MODE_LABELS,
  assistantConfigurationChanged,
  assistantConfigurationError,
  assistantDraftState,
} from "@t3tools/client-runtime/assistant-presentation";
import { AssistantModelPicker } from "./AssistantParts";
import { newAssistantCommandId } from "./useAssistants";

interface EditSession {
  readonly draft: AssistantConfigurationDraft;
  /** One command per reviewed draft, so a retried save is the same request. */
  readonly commandId: CommandId;
}

export function AgentConfiguration({ context }: { readonly context: AgentContext }) {
  const { detail, writer } = context;
  const [session, setSession] = useState<EditSession | null>(null);
  const saved = detail.configuration.configuration;
  const blocked = agentBlockedReason(context, writer.permissions.configure);

  const begin = () => {
    if (context.epoch === null) return;
    setSession({
      draft: captureAssistantConfigurationDraft(detail, context.epoch),
      commandId: CommandId.make(newAssistantCommandId()),
    });
  };

  if (session === null)
    return (
      <WorkSection
        title="Configuration"
        description={
          <>
            Saved revision <WorkRevision>r{detail.configuration.revision}</WorkRevision>. Changes
            apply to the agent's next runs; runs already admitted keep the revision they started
            with.
          </>
        }
        actions={
          <Button size="xs" variant="outline" disabled={blocked !== null} onClick={begin}>
            Edit
          </Button>
        }
      >
        <ConfigurationFields
          context={context}
          configuration={saved}
          disabled
          onChange={() => undefined}
        />
        {blocked !== null ? (
          <WorkRow>
            <WorkFormStatus tone="muted" message={blocked} />
          </WorkRow>
        ) : null}
      </WorkSection>
    );

  const { draft } = session;
  const state = assistantDraftState(draft, { detail, epoch: context.epoch });
  const invalid = assistantConfigurationError(draft.configuration);
  const changed = assistantConfigurationChanged(draft.configuration, saved);
  const pending = writer.pendingKey === "configure";
  const update = (configuration: AssistantConfiguration) =>
    setSession({ ...session, draft: { ...draft, configuration } });

  const save = async () => {
    const result = await writer.run(
      "configure",
      assistantsEnvironment.updateConfiguration,
      context.selection === null
        ? null
        : prepareAssistantConfigurationMutation({
            draft,
            current: context.selection,
            commandId: session.commandId,
          }),
    );
    if (result !== null) setSession(null);
  };

  return (
    <WorkSection
      title="Edit configuration"
      description={
        <>
          Editing revision <WorkRevision>r{draft.selected.configurationRevision}</WorkRevision>.
          Saving never starts a run.
        </>
      }
    >
      {state.kind !== "current" ? (
        <WorkRow className="bg-warning/8">
          <WorkFormStatus
            message={
              state.kind === "offline"
                ? "Offline. Your edits are kept; reconnect to save."
                : state.reason
            }
          />
          {state.kind === "stale" ? (
            <div>
              <Button size="xs" variant="outline" disabled={context.epoch === null} onClick={begin}>
                Discard edits and open the current version
              </Button>
            </div>
          ) : null}
        </WorkRow>
      ) : null}
      <ConfigurationFields
        context={context}
        configuration={draft.configuration}
        disabled={pending}
        onChange={update}
      />
      <WorkRow>
        <WorkFormStatus message={writer.failureFor("configure") ?? (changed ? invalid : null)} />
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            disabled={
              pending ||
              !changed ||
              invalid !== null ||
              state.kind !== "current" ||
              blocked !== null
            }
            onClick={() => void save()}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button size="xs" variant="ghost" disabled={pending} onClick={() => setSession(null)}>
            Cancel
          </Button>
        </div>
      </WorkRow>
    </WorkSection>
  );
}

function ConfigurationFields({
  context,
  configuration,
  disabled,
  onChange,
}: {
  readonly context: AgentContext;
  readonly configuration: AssistantConfiguration;
  readonly disabled: boolean;
  readonly onChange: (configuration: AssistantConfiguration) => void;
}) {
  const set = <K extends keyof AssistantConfiguration>(key: K, value: AssistantConfiguration[K]) =>
    onChange({ ...configuration, [key]: value });
  const memory = configuration.memory;
  return (
    <>
      <WorkRow className="gap-4">
        <WorkField label="Name">
          {(id) => (
            <Input
              id={id}
              maxLength={120}
              disabled={disabled}
              value={configuration.name}
              onChange={(event) => set("name", event.target.value)}
            />
          )}
        </WorkField>
        <WorkField
          label="Model"
          hint="The agent's chat always uses this model. Changing it keeps the chat and memory."
        >
          {() => (
            <div>
              <AssistantModelPicker
                environmentId={context.environmentId}
                selection={configuration.modelSelection}
                disabled={disabled || !context.connected}
                onChange={(selection) => set("modelSelection", selection)}
              />
            </div>
          )}
        </WorkField>
        <div className="grid gap-4 sm:grid-cols-2">
          <WorkField label="Runtime mode">
            {(id) => (
              <ChoiceSelect
                id={id}
                value={configuration.runtimeMode}
                labels={RUNTIME_MODE_LABELS}
                disabled={disabled}
                onChange={(value) => set("runtimeMode", value)}
              />
            )}
          </WorkField>
          <WorkField label="Interaction">
            {(id) => (
              <ChoiceSelect
                id={id}
                value={configuration.interactionMode}
                labels={INTERACTION_MODE_LABELS}
                disabled={disabled}
                onChange={(value) => set("interactionMode", value)}
              />
            )}
          </WorkField>
        </div>
      </WorkRow>
      <WorkRow className="gap-4">
        {(
          [
            ["rules", "Rules", "What the agent must and must not do."],
            ["prompt", "Prompt", "Standing context for every turn."],
            ["personality", "Personality", "How it should sound."],
          ] as const
        ).map(([key, label, hint]) => (
          <WorkField key={key} label={label} hint={hint}>
            {(id) => (
              <Textarea
                id={id}
                rows={4}
                disabled={disabled}
                value={configuration[key]}
                onChange={(event) => set(key, event.target.value)}
              />
            )}
          </WorkField>
        ))}
      </WorkRow>
      <AgentResourceBindings
        binding={context.detail.summary.binding}
        providerInstanceId={configuration.modelSelection.instanceId}
        value={configuration.resources}
        disabled={disabled}
        onChange={(resources) => set("resources", resources)}
      />
      <WorkRow className="gap-3">
        <p className="text-sm font-medium">Memory</p>
        <SwitchRow
          label="Remember useful facts automatically"
          hint="Saved from this agent's own chat. You can review, edit or forget each one."
          checked={memory.automaticCapture}
          disabled={disabled}
          onChange={(automaticCapture) => set("memory", { ...memory, automaticCapture })}
        />
        <SwitchRow
          label="Allow the agent to create routines"
          hint="Off by default. Routines it creates still run only in its own chat."
          checked={memory.allowRoutineCreation}
          disabled={disabled}
          onChange={(allowRoutineCreation) => set("memory", { ...memory, allowRoutineCreation })}
        />
        {/* Fallback extraction and external indexing run only from the Memory tab's processing
            routes; the configuration's own fields for them are stored but never read. */}
        <WorkMeta>
          Extraction and external indexing routes are set under{" "}
          <Link
            to="/agents/$environmentId/$assistantId"
            params={{
              environmentId: context.environmentId,
              assistantId: context.detail.summary.assistantId,
            }}
            search={{ section: "memory" }}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Memory › Memory processing
          </Link>
          . They are off unless you turn them on there.
        </WorkMeta>
      </WorkRow>
    </>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm">{label}</p>
          <WorkMeta>{hint}</WorkMeta>
        </div>
        <Switch
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onChange(Boolean(next))}
        />
      </div>
    </div>
  );
}

function ChoiceSelect<T extends string>({
  id,
  value,
  labels,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly value: T;
  readonly labels: Record<T, string>;
  readonly disabled: boolean;
  readonly onChange: (value: T) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string" && next in labels) onChange(next as T);
      }}
    >
      <SelectTrigger id={id} size="sm">
        <SelectValue>{labels[value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {(Object.keys(labels) as T[]).map((key) => (
          <SelectItem key={key} value={key}>
            {labels[key]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
