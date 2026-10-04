import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";

import { Configuration } from "../../features/projectTeams/Configuration";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { SettingsSection } from "./settingsLayout";

interface Checkout {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly workspaceRoot: string;
  readonly environmentLabel: string | null;
}
const keyOf = (checkout: Checkout) => JSON.stringify([checkout.environmentId, checkout.id]);

/** Team configuration belongs to one environment-local project, even when settings group checkouts. */
export function ProjectTeamSettings({
  checkouts,
}: {
  readonly checkouts: ReadonlyArray<Checkout>;
}) {
  const { environments } = useEnvironments();
  // The initial single checkout is convenient; another owner always needs a choice.
  const [selection, select] = useState(() => ({
    key: checkouts.length === 1 && checkouts[0] ? keyOf(checkouts[0]) : null,
    explicit: false,
  }));
  const checkout =
    selection.explicit || checkouts.length === 1
      ? checkouts.find((item) => keyOf(item) === selection.key)
      : undefined;
  const environment = environments.find((item) => item.environmentId === checkout?.environmentId);
  const config = environment?.serverConfig;
  const providers = config
    ? applyProviderInstanceSettings(
        deriveProviderInstanceEntries(config.providers),
        config.settings,
      )
        .filter((entry) => entry.driverKind === "piAgent")
        .map((entry) => ({
          instanceId: entry.instanceId,
          driverKind: entry.driverKind,
          enabled: entry.enabled && entry.isAvailable,
          label: entry.displayName,
          models: entry.models.map((model) => model.slug),
        }))
    : [];
  return (
    <SettingsSection id="project-team" title="Project team">
      {checkouts.length > 1 || !checkout ? (
        <label className="flex flex-col gap-1 text-sm">
          Team checkout
          <select
            aria-label="Team checkout"
            className="rounded-md border border-input bg-background p-2"
            value={checkout ? keyOf(checkout) : ""}
            onChange={(event) => select({ key: event.target.value, explicit: true })}
          >
            <option value="">Choose a checkout</option>
            {checkouts.map((item) => (
              <option key={keyOf(item)} value={keyOf(item)}>
                {item.environmentLabel ?? "Environment"} · {item.workspaceRoot}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {checkout ? (
        <CheckoutConfiguration
          key={keyOf(checkout)}
          environmentId={checkout.environmentId}
          projectId={checkout.id}
          connected={environment?.connection.phase === "connected"}
          enabled={config?.settings.projectWorkEnabled === true}
          supported={config?.environment?.capabilities?.projectTeamFoundationReads === true}
          writesSupported={config?.environment?.capabilities?.projectTeamGuidedWrites === true}
          providers={providers}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Choose one checkout to configure its team. Each environment keeps its own team and limits.
        </p>
      )}
    </SettingsSection>
  );
}

function CheckoutConfiguration(props: Parameters<typeof Configuration>[0]) {
  return props.supported ? (
    <CurrentCheckoutConfiguration {...props} />
  ) : (
    <Configuration {...props} />
  );
}

function CurrentCheckoutConfiguration(props: Parameters<typeof Configuration>[0]) {
  const result = useAtomValue(
    projectEnvironment.lifecycle({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const lifecycle = Option.getOrNull(AsyncResult.value(result));
  const active = result._tag === "Success" && !result.waiting && lifecycle?.state === "active";
  return <Configuration {...props} enabled={props.enabled && active} />;
}
