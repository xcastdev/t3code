import { getProviderClient } from "@t3tools/client-runtime/provider-clients";
import type { EnvironmentId, ServerProvider, UnifiedSettings } from "@t3tools/contracts";
import { reportsOwnUsageLimits } from "@t3tools/shared/usageLimits";
import { T, useGT, Var } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
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
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const CLI_PROXY_NAME = "CLI Proxy";

export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  limitMappings,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  /** Null when the server predates usage limit mappings. */
  readonly limitMappings: UnifiedSettings["usageLimitMappings"] | null;
  readonly providers: readonly ServerProvider[];
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [adding, setAdding] = useState<"cliproxy" | "http" | null>(null);
  const entries = Object.entries(sources);

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <div className="flex gap-2">
              <Button size="xs" variant="outline" onClick={() => setAdding("cliproxy")}>
                <PlusIcon className="size-3" aria-hidden />
                <T>Add hub</T>
              </Button>
              <Button size="xs" variant="outline" onClick={() => setAdding("http")}>
                <PlusIcon className="size-3" aria-hidden />
                <T>Add HTTP source</T>
              </Button>
            </div>
          ) : null
        }
      >
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
          <SettingsRow title={gt("No usage sources configured.")} />
        ) : (
          entries.map(([id, source]) => {
            const kindLabel = source.kind === "http" ? gt("HTTP quota source") : CLI_PROXY_NAME;
            const label = source.label?.trim() || source.url;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    {source.enabled ? kindLabel : gt("{name} · Disabled", { name: kindLabel })}
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
          kind={adding}
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          sources={sources}
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
        <T>Remove</T>
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove <Var>{label}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>The saved connection and its credentials are removed from this environment.</T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              <T>Remove</T>
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
  const gt = useGT();
  const harnesses = providers.filter(
    (provider) => provider.enabled && !reportsOwnUsageLimits(provider),
  );
  const targets = [
    ...new Set(providers.filter(reportsOwnUsageLimits).map((provider) => provider.driver)),
  ];
  const label = (value: string) =>
    value === UNMAPPED ? gt("Don't show limits") : driverLabel(value);
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
        title={gt("{name} usage limits", { name })}
        description={gt("Whose plan limits this harness shows in thread details.")}
        control={
          <Select
            value={value}
            disabled={readOnly}
            onValueChange={(next) => {
              if (typeof next !== "string" || next === value) return;
              onChange(harness.instanceId, next === UNMAPPED ? null : next);
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("{name} usage limits", { name })}>
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
