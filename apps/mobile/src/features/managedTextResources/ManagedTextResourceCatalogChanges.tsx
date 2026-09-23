import type { EnvironmentId, ManagedTextResourceCatalogListInput } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import { managedTextResourcesEnvironment } from "../../state/managedTextResources";

export function ManagedTextResourceCatalogChanges(props: {
  readonly environmentId: EnvironmentId;
  readonly input: ManagedTextResourceCatalogListInput;
}) {
  const target = useMemo(
    () => ({ environmentId: props.environmentId, input: props.input }),
    [props.environmentId, props.input],
  );
  useAtomValue(managedTextResourcesEnvironment.changes(target));
  return null;
}
