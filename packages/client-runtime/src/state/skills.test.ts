import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  SkillCatalogRevision,
  ThreadId,
  WS_METHODS,
  type SkillCatalogChanged,
  type SkillCatalogListInput,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { makeSkillInvalidationSignals } from "./skills.ts";

describe("skill query invalidation signals", () => {
  it("refreshes installed-copy queries on provider changes from another client", () => {
    const registry = AtomRegistry.make();
    const signals = makeSkillInvalidationSignals();
    const environmentId = EnvironmentId.make("environment");
    const query = signals.refresh(WS_METHODS.skillsDeploymentList, {
      environmentId,
      input: { providerInstanceId: ProviderInstanceId.make("codex") },
    });
    registry.mount(query);
    try {
      const before = registry.get(query);
      signals.publish(
        { environmentId, input: {} },
        {
          scope: "provider",
          scopeId: ProviderInstanceId.make("codex"),
          catalogRevision: SkillCatalogRevision.make(9),
          changedKeys: [],
        },
        registry,
      );
      expect(registry.get(query)).not.toBe(before);
    } finally {
      registry.dispose();
    }
  });
  it("refreshes application state for distinct domain events sharing one catalog revision", () => {
    const registry = AtomRegistry.make();
    const signals = makeSkillInvalidationSignals();
    const environmentId = EnvironmentId.make("environment");
    const threadId = ThreadId.make("thread-a");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const target = { environmentId, input: { threadId, providerInstanceId } };
    const application = signals.refresh(WS_METHODS.skillsApplicationGet, target);
    registry.mount(application);
    try {
      const desired: SkillCatalogChanged = {
        scope: "session",
        scopeId: threadId,
        catalogRevision: SkillCatalogRevision.make(7),
        changedKeys: [],
        eventId: EventId.make("desired-7"),
      };
      signals.publish(target, desired, registry);
      const desiredSignal = registry.get(application);
      const received: SkillCatalogChanged = { ...desired, eventId: EventId.make("received-7") };
      signals.publish(target, received, registry);
      const receivedSignal = registry.get(application);
      expect(receivedSignal).not.toBe(desiredSignal);
      signals.publish(target, received, registry);
      expect(registry.get(application)).toBe(receivedSignal);
    } finally {
      registry.dispose();
    }
  });
  it("refreshes the affected project and thread without refreshing another project or authored content for session changes", () => {
    const registry = AtomRegistry.make();
    const signals = makeSkillInvalidationSignals();
    const environmentId = EnvironmentId.make("environment");
    const projectId = ProjectId.make("project-a");
    const threadId = ThreadId.make("thread-a");
    const query = (tag: Parameters<typeof signals.refresh>[0], input: object) => {
      const atom = signals.refresh(tag, { environmentId, input });
      registry.mount(atom);
      return atom;
    };
    try {
      const project = query(WS_METHODS.skillsCatalogList, { projectId });
      const other = query(WS_METHODS.skillsCatalogList, { projectId: ProjectId.make("project-b") });
      const thread = query(WS_METHODS.skillsCatalogList, { threadId });
      const content = query(WS_METHODS.skillsContentGet, { projectId, skillId: "skill-a" });
      const history = query(WS_METHODS.skillsHistoryList, { skillId: "skill-a" });
      const before = [project, other, thread, content, history].map((atom) => registry.get(atom));
      signals.publish(
        { environmentId, input: { threadId } },
        {
          scope: "project",
          scopeId: projectId,
          catalogRevision: SkillCatalogRevision.make(1),
          changedKeys: [],
        },
        registry,
      );
      expect(registry.get(project)).not.toBe(before[0]);
      expect(registry.get(other)).toBe(before[1]);
      expect(registry.get(thread)).not.toBe(before[2]);
      expect(registry.get(content)).not.toBe(before[3]);
      expect(registry.get(history)).toBe(before[4]);
      const afterProject = registry.get(project);
      const afterContent = registry.get(content);
      const afterThread = registry.get(thread);
      signals.publish(
        { environmentId, input: { threadId } },
        {
          scope: "session",
          scopeId: threadId,
          catalogRevision: SkillCatalogRevision.make(2),
          changedKeys: [],
        },
        registry,
      );
      expect(registry.get(thread)).not.toBe(afterThread);
      expect(registry.get(project)).toBe(afterProject);
      expect(registry.get(content)).toBe(afterContent);
    } finally {
      registry.dispose();
    }
  });

  it("refreshes unfiltered and matching provider catalogs once per notice, keeping other providers and environments unchanged", () => {
    const registry = AtomRegistry.make();
    const signals = makeSkillInvalidationSignals();
    const environmentId = EnvironmentId.make("environment");
    const providerInstanceId = ProviderInstanceId.make("claude");
    const query = (input: SkillCatalogListInput, environment = environmentId) => {
      const atom = signals.refresh(WS_METHODS.skillsCatalogList, {
        environmentId: environment,
        input,
      });
      registry.mount(atom);
      return atom;
    };
    try {
      const all = query({});
      const matching = query({ providerInstanceId });
      const other = query({ providerInstanceId: ProviderInstanceId.make("codex") });
      const remote = query({}, EnvironmentId.make("other-environment"));
      const before = [all, matching, other, remote].map((atom) => registry.get(atom));
      const change: SkillCatalogChanged = {
        scope: "provider",
        scopeId: providerInstanceId,
        catalogRevision: SkillCatalogRevision.make(3),
        changedKeys: [],
      };
      signals.publish({ environmentId, input: {} }, change, registry);
      expect(registry.get(all)).not.toBe(before[0]);
      expect(registry.get(matching)).not.toBe(before[1]);
      expect(registry.get(other)).toBe(before[2]);
      expect(registry.get(remote)).toBe(before[3]);
      const after = registry.get(all);
      signals.publish({ environmentId, input: { providerInstanceId } }, change, registry);
      expect(registry.get(all)).toBe(after);
    } finally {
      registry.dispose();
    }
  });
});
