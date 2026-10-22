import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import type { AssistantTone } from "@t3tools/client-runtime/assistant-presentation";

const TONE_VARIANTS = {
  neutral: "secondary",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "error",
} as const satisfies Record<AssistantTone, string>;

export function AssistantToneBadge({
  tone,
  children,
}: {
  readonly tone: AssistantTone;
  readonly children: string;
}) {
  return (
    <Badge variant={TONE_VARIANTS[tone]} className="shrink-0">
      {children}
    </Badge>
  );
}

/**
 * The environment's actual provider instances, the same entries the composer
 * and scheduled tasks offer. The agent's backing project carries no defaults.
 */
function useAssistantModelChoices(environmentId: EnvironmentId, selection: ModelSelection | null) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const fallback = instanceEntries.find((entry) => entry.enabled) ?? instanceEntries[0];
  const activeInstanceId =
    selection?.instanceId ?? fallback?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = selection?.model ?? "";
  return {
    instanceEntries,
    activeInstanceId,
    activeModel,
    modelOptionsByInstance: getCustomModelOptionsByInstance(
      settings,
      providers,
      activeInstanceId,
      activeModel,
    ),
  };
}

export function AssistantModelPicker({
  environmentId,
  selection,
  disabled,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly selection: ModelSelection | null;
  readonly disabled: boolean;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const choices = useAssistantModelChoices(environmentId, selection);
  return (
    <ProviderModelPicker
      environmentId={environmentId}
      disabled={disabled}
      activeInstanceId={choices.activeInstanceId}
      model={choices.activeModel}
      lockedProvider={null}
      instanceEntries={choices.instanceEntries}
      modelOptionsByInstance={choices.modelOptionsByInstance}
      isComposerOwned={false}
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      // The picker would otherwise display the instance's first model, which isn't chosen.
      {...(selection === null ? { triggerLabel: "Choose a model" } : {})}
      onInstanceModelChange={(instanceId, model) =>
        // Provider options belong to the previous instance; a new instance starts clean.
        onChange(
          selection !== null && selection.instanceId === instanceId
            ? { ...selection, model }
            : { instanceId, model },
        )
      }
    />
  );
}
