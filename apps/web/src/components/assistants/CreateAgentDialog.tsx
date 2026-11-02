import {
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
  // One command ID per dialog, so a retried submit is the same creation.
  const [commandId] = useState(() => CommandId.make(newAssistantCommandId()));
  const configuration =
    selection === null
      ? null
      : {
          ...defaultAssistantConfiguration(name, selection),
          ...text,
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
        <DialogPanel>
          <fieldset disabled={pending} className="flex min-w-0 flex-col gap-4">
            <WorkAvatarEditor
              identity={agentInitials(name)}
              preset={initialAvatar}
              name={name.trim() || "New agent"}
              avatar={avatar}
              recorded={initialAvatar}
              others={[]}
              onChange={setAvatar}
            />
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
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
              <WorkField label="Model">
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
            </div>
            {TEXT_FIELDS.map(([key, label, hint]) => (
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
            ))}
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
