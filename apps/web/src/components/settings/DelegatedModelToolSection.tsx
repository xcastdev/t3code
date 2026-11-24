import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { toastManager } from "../ui/toast";
import { ScopedSwitch } from "./ScopedSwitch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";
import { type SettingsSearchItemId, useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import type { ScopedSettingsPatch } from "./scopedSettings";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

type DelegatedModelToolKeys =
  | { readonly enabledKey: "viewImageToolEnabled"; readonly modelKey: "visionModelSelection" }
  | { readonly enabledKey: "webSearchToolEnabled"; readonly modelKey: "webSearchModelSelection" };

export type DelegatedModelToolConfig = DelegatedModelToolKeys & {
  readonly sectionId: string;
  readonly title: string;
  readonly drivers: ReadonlySet<string>;
  readonly unsupportedDriverReason: string;
  readonly toggleSearchId: SettingsSearchItemId;
  readonly toggleLabel: string;
  readonly toggleDescription: string;
  readonly modelSearchId: SettingsSearchItemId;
  readonly modelLabel: string;
  readonly modelDescription: string;
  readonly noProviderMessage: string;
  readonly noEnvironmentMessage: string;
  readonly patchEnabled: (enabled: boolean) => ScopedSettingsPatch;
  readonly patchModel: (selection: ModelSelection) => ScopedSettingsPatch;
};

/** A settings section for a tool that delegates work to a model on another provider. */
export function DelegatedModelToolSection({
  config,
}: {
  readonly config: DelegatedModelToolConfig;
}) {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedEnabled = useScopedSettingsMixed([config.enabledKey]);
  const mixedModel = useScopedSettingsMixed([config.modelKey]);
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
    return entry === undefined || !config.drivers.has(entry.driverKind)
      ? config.unsupportedDriverReason
      : scopedDisabledReason(instanceId, model);
  };
  const firstEligibleEntry = instanceEntries.find(
    (entry) => config.drivers.has(entry.driverKind) && entry.enabled && entry.isAvailable,
  );
  const enabled = settings[config.enabledKey];
  const savedSelection = settings[config.modelKey];
  const selection =
    savedSelection ??
    (firstEligibleEntry
      ? {
          instanceId: firstEligibleEntry.instanceId,
          model: firstEligibleEntry.models[0]?.slug ?? "",
        }
      : null);

  return (
    <SettingsSection id={config.sectionId} title={config.title}>
      <SettingsRow
        serverScoped
        settingKeys={[config.enabledKey]}
        {...searchableSetting(config.toggleSearchId)}
        description={config.toggleDescription}
        control={
          <ScopedSwitch
            settingKeys={[config.enabledKey]}
            aria-label={config.toggleLabel}
            checked={enabled}
            onCheckedChange={(checked) => updateSettings(config.patchEnabled(Boolean(checked)))}
          />
        }
      />
      {enabled || mixedEnabled ? (
        <SettingsRow
          serverScoped
          settingKeys={[config.modelKey]}
          {...searchableSetting(config.modelSearchId)}
          description={config.modelDescription}
          control={
            connectedEnvironments.length === 0 ? (
              <span className="text-sm text-muted-foreground">{config.noEnvironmentMessage}</span>
            ) : selection === null ? (
              <span className="text-sm text-muted-foreground">{config.noProviderMessage}</span>
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
                triggerAriaLabel={config.modelLabel}
                {...(mixedModel
                  ? { triggerLabel: "Mixed" }
                  : savedSelection === null
                    ? { triggerLabel: "Choose a model" }
                    : {})}
                getModelDisabledReason={disabledReason}
                onInstanceModelChange={(instanceId, model) => {
                  const reason = disabledReason(instanceId, model);
                  if (reason) {
                    toastManager.add({
                      type: "error",
                      title: `${config.modelLabel} not saved`,
                      description: reason,
                    });
                    return;
                  }
                  updateSettings(config.patchModel(createModelSelection(instanceId, model)));
                }}
              />
            )
          }
        />
      ) : null}
    </SettingsSection>
  );
}
