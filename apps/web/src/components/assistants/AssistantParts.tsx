import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  RuntimeMode,
} from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";

import { useClientSettings, useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import {
  ComposerEffortColumn,
  ComposerPickerFooter,
  describeComposerEffort,
} from "../chat/ComposerModelEffort";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { resolveCompatibleRuntimeMode, runtimeModeConfig } from "../chat/runtimeModeConfig";
import type { TraitsSelectionInput } from "../chat/TraitsPicker";
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
  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
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

const effortDisplaySetting = (settings: ClientSettings) => settings.effortDisplay;

/**
 * The composer's model control: models, the chosen model's effort beside them, and a footer with
 * speed and, when given, the agent's permissions.
 */
export function AssistantModelPicker({
  environmentId,
  selection,
  disabled,
  onChange,
  runtimeMode,
  onRuntimeModeChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly selection: ModelSelection | null;
  readonly disabled: boolean;
  readonly onChange: (selection: ModelSelection) => void;
  readonly runtimeMode?: RuntimeMode;
  readonly onRuntimeModeChange?: (mode: RuntimeMode) => void;
}) {
  const choices = useAssistantModelChoices(environmentId, selection);
  const effortDisplay = useClientSettings(effortDisplaySetting);
  const entry =
    choices.instanceEntries.find(
      (candidate) => candidate.instanceId === choices.activeInstanceId,
    ) ?? null;
  const traits: TraitsSelectionInput | null =
    selection === null || entry === null
      ? null
      : {
          provider: entry.driverKind,
          instanceId: selection.instanceId,
          models: entry.models,
          model: selection.model,
          modelOptions: selection.options ?? null,
          allowPromptInjectedEffort: false,
          planModeEnabled: false,
          onModelOptionsChange: (options) => {
            const { options: _previous, ...rest } = selection;
            onChange(options === undefined ? rest : { ...rest, options });
          },
        };
  const effort = describeComposerEffort(traits, effortDisplay, "sm");
  const modes = resolveCompatibleRuntimeMode(
    runtimeMode ?? "approval-required",
    entry?.snapshot.supportedRuntimeModes,
  );
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
      triggerSuffix={effort.suffix}
      triggerDetail={effort.detail}
      effortColumn={<ComposerEffortColumn traits={traits} />}
      footer={
        runtimeMode !== undefined && onRuntimeModeChange ? (
          <ComposerPickerFooter
            traits={traits}
            runtimeMode={modes.mode}
            runtimeModeOptions={modes.modes.map((mode) => ({ mode, ...runtimeModeConfig[mode] }))}
            onRuntimeModeChange={onRuntimeModeChange}
          />
        ) : undefined
      }
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
