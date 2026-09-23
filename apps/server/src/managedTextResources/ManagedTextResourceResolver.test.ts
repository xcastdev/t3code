import { assert, describe, it } from "@effect/vitest";

import {
  resolveManagedTextResources,
  type ManagedTextResourceCandidate,
} from "./ManagedTextResourceResolver.ts";

const candidate = (
  scope: "environment" | "project",
  kind: "command" | "snippet",
  key: string,
  state: "active" | "disabled" | "invalid" = "active",
): ManagedTextResourceCandidate => ({
  id: `${scope}-${kind}-${key}`,
  scope,
  kind,
  key,
  name: key,
  revision: `${scope}-${kind}-${key}-revision`,
  state,
});

describe("ManagedTextResourceResolver", () => {
  it("inherits, overrides, disables, and re-enables entries by kind and key", () => {
    const environment = [
      candidate("environment", "command", "deploy"),
      candidate("environment", "snippet", "deploy"),
    ];
    const inherited = resolveManagedTextResources({ environment });
    assert.equal(inherited.get("command:deploy")?.winner?.id, "environment-command-deploy");
    assert.equal(inherited.get("snippet:deploy")?.winner?.id, "environment-snippet-deploy");

    const overridden = resolveManagedTextResources({
      environment,
      project: [candidate("project", "command", "deploy")],
    });
    assert.equal(overridden.get("command:deploy")?.winner?.id, "project-command-deploy");
    assert.equal(overridden.get("snippet:deploy")?.winner?.id, "environment-snippet-deploy");

    const disabled = resolveManagedTextResources({
      environment,
      project: [candidate("project", "command", "deploy", "disabled")],
    });
    assert.isFalse(disabled.get("command:deploy")?.effective);
    assert.equal(disabled.get("command:deploy")?.projectState, "disabled");

    const disabledForThread = resolveManagedTextResources({
      environment,
      project: [candidate("project", "command", "deploy", "disabled")],
      thread: [{ kind: "command", key: "deploy", enabled: true }],
    });
    assert.isFalse(disabledForThread.get("command:deploy")?.effective);
    assert.isUndefined(disabledForThread.get("command:deploy")?.winner);
    assert.equal(disabledForThread.get("command:deploy")?.projectState, "disabled");
    assert.isTrue(
      disabledForThread.get("command:deploy")?.diagnostics.includes("project_disabled"),
    );
  });

  it("blocks inheritance when a project override is malformed or duplicated", () => {
    const environment = [candidate("environment", "snippet", "answer")];
    const malformed = resolveManagedTextResources({
      environment,
      project: [candidate("project", "snippet", "answer", "invalid")],
    });
    assert.isUndefined(malformed.get("snippet:answer")?.winner);
    assert.isFalse(malformed.get("snippet:answer")?.effective);

    const duplicate = resolveManagedTextResources({
      environment,
      project: [
        candidate("project", "snippet", "answer"),
        candidate("project", "snippet", "answer"),
      ],
    });
    assert.isUndefined(duplicate.get("snippet:answer")?.winner);
    assert.isTrue(duplicate.get("snippet:answer")?.diagnostics.includes("duplicate_project_key"));
  });

  it("keeps disabled environment definitions visible but ineffective unless a project overrides them", () => {
    const environment = [candidate("environment", "command", "deploy", "disabled")];
    const disabled = resolveManagedTextResources({ environment });
    assert.equal(disabled.get("command:deploy")?.winner?.id, "environment-command-deploy");
    assert.isFalse(disabled.get("command:deploy")?.effective);

    const threadEnabled = resolveManagedTextResources({
      environment,
      thread: [{ kind: "command", key: "deploy", enabled: true }],
    });
    assert.equal(threadEnabled.get("command:deploy")?.winner?.id, "environment-command-deploy");
    assert.isFalse(threadEnabled.get("command:deploy")?.effective);

    const projectOverride = resolveManagedTextResources({
      environment,
      project: [candidate("project", "command", "deploy")],
    });
    assert.equal(projectOverride.get("command:deploy")?.winner?.id, "project-command-deploy");
    assert.isTrue(projectOverride.get("command:deploy")?.effective);
  });
});
