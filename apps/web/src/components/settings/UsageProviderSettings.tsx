import { getProviderClient } from "@t3tools/client-runtime/provider-clients";
import type { EnvironmentId, ServerProvider, UnifiedSettings } from "@t3tools/contracts";
import { reportsOwnUsageLimits } from "@t3tools/shared/usageLimits";
import { useAtomValue } from "@effect/atom-react";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  cursorKeychainUsageEnabled,
  limitMappings,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly cursorKeychainUsageEnabled: boolean;
  /** Null when the server predates usage limit mappings. */
  readonly limitMappings: UnifiedSettings["usageLimitMappings"] | null;
  readonly providers: readonly ServerProvider[];
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const updateCursorSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update Cursor account usage",
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const platform = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .platform;
  const [adding, setAdding] = useState(false);
  const [updatingCursor, setUpdatingCursor] = useState(false);
  const entries = Object.entries(sources);

  const setCursorUsageEnabled = async (enabled: boolean) => {
    setUpdatingCursor(true);
    const result = await updateCursorSettings({
      environmentId,
      input: { patch: { cursorKeychainUsageEnabled: enabled } },
    });
    if (result._tag === "Success") {
      await refreshProviders({ environmentId, input: {} });
    }
    setUpdatingCursor(false);
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              Add hub
            </Button>
          ) : null
        }
      >
        {platform?.os === "darwin" ? (
          <SettingsRow
            id="cursor-keychain-usage"
            title="Cursor account usage"
            description="Read your existing Cursor CLI login from macOS Keychain to show account history and monthly limits. macOS may ask you to allow access."
            control={
              <Switch
                aria-label="Cursor account usage"
                checked={cursorKeychainUsageEnabled}
                disabled={readOnly || updatingCursor}
                onCheckedChange={(enabled) => void setCursorUsageEnabled(enabled)}
              />
            }
          />
        ) : null}
        {limitMappings !== null ? (
          <UsageLimitMappingRows
            providers={providers}
            mappings={limitMappings}
            readOnly={readOnly}
            onChange={(instanceId, value) =>
              updateSettings({ usageLimitMappings: { [instanceId]: value } })
            }
          />
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow title="No hubs configured." />
        ) : (
          entries.map(([id, source]) => {
            const label = source.label?.trim() || source.url;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    CLI Proxy{source.enabled ? "" : " · Disabled"}
                    {label !== source.url ? ` · ${source.url}` : ""}
                  </span>
                }
                control={
                  !readOnly ? (
                    <RemoveUsageProviderButton
                      label={label}
                      onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                    />
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
        />
      ) : null}
    </>
  );
}

function RemoveUsageProviderButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The hub's management key is deleted from this server. Its accounts leave the Limits
              view; the hub itself is untouched. Add it again with the URL and key to bring them
              back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Remove hub
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

const UNMAPPED = "unmapped";

function driverLabel(driver: string): string {
  return getProviderClient(driver)?.label ?? driver;
}

/** Universal harnesses run on another provider's login; this picks whose limits they show. */
function UsageLimitMappingRows({
  providers,
  mappings,
  readOnly,
  onChange,
}: {
  readonly providers: readonly ServerProvider[];
  readonly mappings: UnifiedSettings["usageLimitMappings"];
  readonly readOnly: boolean;
  readonly onChange: (instanceId: string, value: string | null) => void;
}) {
  const harnesses = providers.filter(
    (provider) => provider.enabled && !reportsOwnUsageLimits(provider),
  );
  const targets = [
    ...new Set(providers.filter(reportsOwnUsageLimits).map((provider) => provider.driver)),
  ];
  const label = (value: string) => (value === UNMAPPED ? "Don't show limits" : driverLabel(value));
  return harnesses.map((harness) => {
    const value = mappings[harness.instanceId] ?? UNMAPPED;
    const options = [
      UNMAPPED,
      ...targets,
      // A saved provider that is now disabled stays selectable rather than vanishing.
      ...(value === UNMAPPED || targets.some((target) => target === value) ? [] : [value]),
    ];
    const name = harness.displayName?.trim() || driverLabel(harness.driver);
    return (
      <SettingsRow
        key={harness.instanceId}
        title={`${name} usage limits`}
        description="Whose plan limits this harness shows in thread details."
        control={
          <Select
            value={value}
            disabled={readOnly}
            onValueChange={(next) => {
              if (typeof next !== "string" || next === value) return;
              onChange(harness.instanceId, next === UNMAPPED ? null : next);
            }}
          >
            <SelectTrigger size="sm" aria-label={`${name} usage limits`}>
              <SelectValue>{(selected: string) => label(selected)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {options.map((option) => (
                <SelectItem key={option} value={option}>
                  {label(option)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    );
  });
}
