import { type ProviderInstanceId, VISION_MODEL_DRIVERS } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { toastManager } from "../ui/toast";
import { ScopedSwitch } from "./ScopedSwitch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const UNSUPPORTED_DRIVER_REASON = "Only Codex and OpenCode models can look at images.";

export function ViewImageToolSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedEnabled = useScopedSettingsMixed(["viewImageToolEnabled"]);
  const mixedModel = useScopedSettingsMixed(["visionModelSelection"]);
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const providers = (
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS
  ).filter((provider) => provider.supportsTextGeneration !== false);
  const instanceEntries = providerInstanceEntriesFor(
    providers,
    settings,
    target?.projectId ?? null,
  );
  const scopedDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const disabledReason = (instanceId: ProviderInstanceId, model: string) => {
    const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);
    return entry === undefined || !VISION_MODEL_DRIVERS.has(entry.driverKind)
      ? UNSUPPORTED_DRIVER_REASON
      : scopedDisabledReason(instanceId, model);
  };
  const firstVisionEntry = instanceEntries.find(
    (entry) => VISION_MODEL_DRIVERS.has(entry.driverKind) && entry.enabled && entry.isAvailable,
  );
  const selection =
    settings.visionModelSelection ??
    (firstVisionEntry
      ? { instanceId: firstVisionEntry.instanceId, model: firstVisionEntry.models[0]?.slug ?? "" }
      : null);

  return (
    <SettingsSection id="image-viewing" title="Image viewing">
      <SettingsRow
        serverScoped
        settingKeys={["viewImageToolEnabled"]}
        {...searchableSetting("view-image-tool")}
        description="Give agents a tool that asks a vision model to describe an image file in their workspace, for models that can't see images. New agent sessions get it."
        control={
          <ScopedSwitch
            settingKeys={["viewImageToolEnabled"]}
            aria-label="View image tool"
            checked={settings.viewImageToolEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ viewImageToolEnabled: Boolean(checked) })
            }
          />
        }
      />
      {settings.viewImageToolEnabled || mixedEnabled ? (
        <SettingsRow
          serverScoped
          settingKeys={["visionModelSelection"]}
          {...searchableSetting("vision-model")}
          description="The model that looks at the image. Codex and OpenCode models only. Agents don't get the tool until you choose one."
          control={
            connectedEnvironments.length === 0 ? (
              <span className="text-sm text-muted-foreground">
                Connect an environment to choose its vision model.
              </span>
            ) : selection === null ? (
              <span className="text-sm text-muted-foreground">
                Add a Codex or OpenCode provider to choose a vision model.
              </span>
            ) : (
              <ProviderModelPicker
                environmentId={environment?.environmentId ?? null}
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={getCustomModelOptionsByInstance(
                  settings,
                  providers,
                  selection.instanceId,
                  selection.model,
                )}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerAriaLabel="Vision model"
                {...(mixedModel
                  ? { triggerLabel: "Mixed" }
                  : settings.visionModelSelection === null
                    ? { triggerLabel: "Choose a model" }
                    : {})}
                getModelDisabledReason={disabledReason}
                onInstanceModelChange={(instanceId, model) => {
                  const reason = disabledReason(instanceId, model);
                  if (reason) {
                    toastManager.add({
                      type: "error",
                      title: "Vision model not saved",
                      description: reason,
                    });
                    return;
                  }
                  updateSettings({ visionModelSelection: createModelSelection(instanceId, model) });
                }}
              />
            )
          }
        />
      ) : null}
    </SettingsSection>
  );
}
