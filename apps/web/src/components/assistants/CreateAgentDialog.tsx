import {
  type AssistantConfiguration,
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectTeamAvatar,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { assistantsEnvironment } from "../../state/assistants";
import { WorkAvatarEditor } from "../work/WorkAvatarEditor";
import { WorkField, WorkFormStatus } from "../work/WorkLayout";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  RUNTIME_MODE_LABELS,
  assistantConfigurationError,
  defaultAssistantConfiguration,
} from "@t3tools/client-runtime/assistant-presentation";
import { agentInitials, newAgentAvatar } from "./AgentAvatar";
import { ChoiceSelect } from "./AgentConfiguration";
import { AssistantModelPicker } from "./AssistantParts";
import {
  newAssistantCommandId,
  useAssistantConnection,
  useAssistantWriter,
  useMountedRef,
} from "./useAssistants";

const STEPS = ["Identity", "Model", "Personality"] as const;
const DEFAULT_RUNTIME_MODE: AssistantConfiguration["runtimeMode"] = "approval-required";

function AgentSteps(props: {
  readonly step: number;
  readonly reachable: (step: number) => boolean;
  readonly onSelect: (step: number) => void;
}) {
  return (
    <ol aria-label="Steps" className="flex items-center gap-1 px-6 pb-1">
      {STEPS.map((label, index) => (
        <li key={label} className="flex items-center gap-1">
          {index > 0 ? <span aria-hidden className="h-px w-4 bg-border" /> : null}
          <button
            type="button"
            aria-current={props.step === index ? "step" : undefined}
            disabled={!props.reachable(index)}
            onClick={() => props.onSelect(index)}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              props.step === index
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "grid size-4 place-items-center rounded-full text-2xs tabular-nums",
                props.step === index ? "bg-primary text-primary-foreground" : "bg-muted",
              )}
            >
              {index + 1}
            </span>
            {label}
          </button>
        </li>
      ))}
    </ol>
  );
}

const TEXT_FIELDS = [
  ["personality", "Personality", "Optional. How it should sound."],
  ["rules", "Rules", "Optional. What it must and must not do."],
  ["prompt", "Prompt", "Optional. Standing context for every turn."],
] as const;

export function CreateAgentDialog({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const writer = useAssistantWriter(environmentId);
  const connection = useAssistantConnection(environmentId);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [initialAvatar] = useState(newAgentAvatar);
  const [avatar, setAvatar] = useState<ProjectTeamAvatar | null>(initialAvatar);
  const [text, setText] = useState({ personality: "", rules: "", prompt: "" });
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<AssistantConfiguration["runtimeMode"]>(
    () => DEFAULT_RUNTIME_MODE,
  );
  const [step, setStep] = useState(0);
  // A step opens once everything before it is filled in.
  const reachable = (target: number) =>
    target === 0 || (name.trim().length > 0 && (target === 1 || selection !== null));
  // One command ID per dialog, so a retried submit is the same creation.
  const [commandId] = useState(() => CommandId.make(newAssistantCommandId()));
  const configuration =
    selection === null
      ? null
      : {
          ...defaultAssistantConfiguration(name, selection),
          ...text,
          runtimeMode,
          ...(avatar ? { avatar } : {}),
        };
  const invalid =
    configuration === null ? "Choose a model." : assistantConfigurationError(configuration);
  const blocked = !connection.connected
    ? "Reconnect to create an agent."
    : !writer.permissions.create
      ? "This connection isn't allowed to create agents."
      : null;
  const pending = writer.pendingKey === "create";
  const mounted = useMountedRef();

  const submit = async () => {
    if (configuration === null || invalid !== null || blocked !== null || !mounted.current) return;
    const result = await writer.run("create", assistantsEnvironment.create, {
      environmentId,
      commandId,
      configuration,
    });
    // The agent exists either way; a dialog closed meanwhile must not reopen anything.
    if (result === null || !mounted.current) return;
    onClose();
    void navigate({
      to: "/agents/$environmentId/$assistantId",
      params: { environmentId, assistantId: result.summary.assistantId },
      search: { section: "overview" },
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            The agent gets its own chat and private memory on this environment. Creating it doesn't
            start a run. Tools and memory can be set after creating it.
          </DialogDescription>
        </DialogHeader>
        <AgentSteps step={step} reachable={reachable} onSelect={setStep} />
        <DialogPanel>
          <fieldset disabled={pending} className="flex min-w-0 flex-col gap-4">
            {step === 0 ? (
              <>
                <WorkAvatarEditor
                  identity={agentInitials(name)}
                  preset={initialAvatar}
                  name={name.trim() || "New agent"}
                  avatar={avatar}
                  others={[]}
                  onChange={setAvatar}
                />
                <WorkField label="Name">
                  {(id) => (
                    <Input
                      id={id}
                      autoFocus
                      maxLength={120}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  )}
                </WorkField>
              </>
            ) : step === 1 ? (
              <>
                <WorkField label="Model" hint="Its Home and chats always use this model.">
                  {() => (
                    <div>
                      <AssistantModelPicker
                        environmentId={environmentId}
                        selection={selection}
                        disabled={pending || !connection.connected}
                        onChange={setSelection}
                      />
                    </div>
                  )}
                </WorkField>
                <WorkField
                  label="Runtime mode"
                  hint="Ask before actions means you approve its edits and commands."
                >
                  {(id) => (
                    <div>
                      <ChoiceSelect
                        id={id}
                        value={runtimeMode}
                        labels={RUNTIME_MODE_LABELS}
                        disabled={pending}
                        onChange={setRuntimeMode}
                      />
                    </div>
                  )}
                </WorkField>
              </>
            ) : (
              TEXT_FIELDS.map(([key, label, hint]) => (
                <WorkField key={key} label={label} hint={hint}>
                  {(id) => (
                    <Textarea
                      id={id}
                      rows={3}
                      value={text[key]}
                      onChange={(event) => setText({ ...text, [key]: event.target.value })}
                    />
                  )}
                </WorkField>
              ))
            )}
            <WorkFormStatus message={writer.failureFor("create") ?? blocked} />
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => (step === 0 ? onClose() : setStep(step - 1))}
          >
            {step === 0 ? "Cancel" : "Back"}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button
              size="sm"
              disabled={pending || !reachable(step + 1)}
              onClick={() => setStep(step + 1)}
            >
              Next
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={pending || invalid !== null || blocked !== null}
              onClick={() => void submit()}
            >
              {pending ? "Creating…" : "Create agent"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
