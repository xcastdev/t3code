import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { useRightPanelStore } from "~/rightPanelStore";

/** The provider rail and its actions share one selected-repository subscription. */
export function useChatViewSourceControlScope({
  environmentId,
  threadRef,
  projectRoot,
  hasProject,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  projectRoot: string | null;
  hasProject: boolean;
}) {
  const selectedRepositoryRoot = useRightPanelStore((state) =>
    threadRef ? state.getSourceControlRepositoryRoot(threadRef) : null,
  );
  const cwd = selectedRepositoryRoot ?? projectRoot;
  const statusQuery = useEnvironmentQuery(
    cwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd },
        }),
  );
  const presentation =
    hasProject && statusQuery.data?.sourceControlProvider
      ? getSourceControlPresentation(statusQuery.data.sourceControlProvider)
      : null;

  return { cwd, presentation };
}
