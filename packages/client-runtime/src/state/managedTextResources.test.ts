import {
  EnvironmentId,
  ManagedTextResourceCatalogRevision,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { makeManagedTextResourceInvalidationSignals } from "./managedTextResources.ts";

describe("managed text resource catalog invalidation", () => {
  it("refreshes the affected project and its thread across subscribed clients", () => {
    const registry = AtomRegistry.make();
    const signals = makeManagedTextResourceInvalidationSignals();
    const environmentId = EnvironmentId.make("environment-a");
    const projectId = ProjectId.make("project-a");
    const threadId = ThreadId.make("thread-a");
    const query = (input: Parameters<typeof signals.refresh>[0]["input"]) => {
      const atom = signals.refresh({ environmentId, input });
      registry.mount(atom);
      return atom;
    };
    try {
      const project = query({ projectId });
      const otherProject = query({ projectId: ProjectId.make("project-b") });
      const thread = query({ threadId });
      const before = [project, otherProject, thread].map((atom) => registry.get(atom));
      signals.publish(
        { environmentId, input: { threadId } },
        {
          scope: "project",
          scopeId: projectId,
          catalogRevision: ManagedTextResourceCatalogRevision.make(1),
          changedKeys: [],
        },
        registry,
      );
      expect(registry.get(project)).not.toBe(before[0]);
      expect(registry.get(otherProject)).toBe(before[1]);
      expect(registry.get(thread)).not.toBe(before[2]);
    } finally {
      registry.dispose();
    }
  });
});
