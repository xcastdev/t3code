import {
  type AssistantConfiguration,
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectTeamAvatar,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

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
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  assistantConfigurationError,
  defaultAssistantConfiguration,
} from "@t3tools/client-runtime/assistant-presentation";
import { agentInitials, newAgentAvatar } from "./AgentAvatar";
import { AssistantModelPicker } from "./AssistantParts";
import {
  newAssistantCommandId,
  useAssistantConnection,
  useAssistantWriter,
  useMountedRef,
} from "./useAssistants";

const DEFAULT_RUNTIME_MODE: AssistantConfiguration["runtimeMode"] = "approval-required";

const INSTRUCTIONS = {
  personality: {
    label: "Personality",
    placeholder: "How it should sound. Dry and brief, warm and patient…",
  },
  rules: { label: "Rules", placeholder: "What it must and must not do." },
  prompt: { label: "Prompt", placeholder: "Standing context for every turn." },
} as const;
type InstructionKey = keyof typeof INSTRUCTIONS;
const INSTRUCTION_KEYS = Object.keys(INSTRUCTIONS) as InstructionKey[];

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
  const [instruction, setInstruction] = useState<InstructionKey>("personality");
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
            start a run.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={pending} className="flex min-w-0 flex-col gap-4">
            <WorkAvatarEditor
              identity={agentInitials(name)}
              preset={initialAvatar}
              name={name.trim() || "New agent"}
              avatar={avatar}
              others={[]}
              onChange={setAvatar}
            />
            <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
              <WorkField label="Name">
                {(id) => (
                  <Input
                    id={id}
                    autoFocus
                    maxLength={120}
                    placeholder="What to call it"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                )}
              </WorkField>
              <WorkField label="Model">
                {() => (
                  <div>
                    <AssistantModelPicker
                      environmentId={environmentId}
                      selection={selection}
                      disabled={pending || !connection.connected}
                      onChange={setSelection}
                      runtimeMode={runtimeMode}
                      onRuntimeModeChange={setRuntimeMode}
                    />
                  </div>
                )}
              </WorkField>
            </div>
            <section aria-label="Instructions" className="flex min-w-0 flex-col gap-2">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="text-sm font-medium">Instructions</span>
                <ToggleGroup
                  aria-label="Instruction"
                  size="sm"
                  value={[instruction]}
                  onValueChange={(next) => {
                    const key = INSTRUCTION_KEYS.find((candidate) => candidate === next[0]);
                    if (key) setInstruction(key);
                  }}
                >
                  {INSTRUCTION_KEYS.map((key) => (
                    <Toggle key={key} value={key}>
                      {INSTRUCTIONS[key].label}
                      {text[key].trim() ? (
                        <span aria-hidden className="size-1.5 rounded-full bg-primary" />
                      ) : null}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>
              <Textarea
                aria-label={INSTRUCTIONS[instruction].label}
                rows={4}
                placeholder={INSTRUCTIONS[instruction].placeholder}
                value={text[instruction]}
                onChange={(event) => setText({ ...text, [instruction]: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                All optional. Tools, skills and memory can be set after creating it.
              </p>
            </section>
            <WorkFormStatus message={writer.failureFor("create") ?? blocked} />
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={pending || invalid !== null || blocked !== null}
            onClick={() => void submit()}
          >
            {pending ? "Creating…" : "Create agent"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
