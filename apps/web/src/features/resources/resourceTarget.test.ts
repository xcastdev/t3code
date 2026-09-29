import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import {
  buildResourceTarget,
  isResourceTargetFor,
  makeEnvironmentCreateTarget,
  parseResourceTarget,
} from "./resourceTarget";

describe("resource editor targets", () => {
  it("round trips a namespaced item identity without losing punctuation", () => {
    const target = {
      namespace: "t3-resource",
      version: 1,
      kind: "command",
      scope: "project",
      scopeId: "project.with/slash",
      intent: "item",
      identity: "summary",
      id: "command:deploy:project:project.with/slash",
    } as const;

    expect(parseResourceTarget(buildResourceTarget(target))).toEqual(target);
    expect(isResourceTargetFor(target, "command", "project", "project.with/slash")).toBe(true);
    expect(isResourceTargetFor(target, "snippet", "project", "project.with/slash")).toBe(false);
  });

  it("rejects malformed, unknown, and incomplete targets", () => {
    expect(parseResourceTarget("t3-resource-v1:%zz")).toBeNull();
    expect(parseResourceTarget("t3-resource-v2:{}")).toBeNull();
    expect(
      parseResourceTarget(
        `t3-resource-v1:${encodeURIComponent(
          JSON.stringify({
            namespace: "t3-resource",
            version: 1,
            kind: "mcp",
            scope: "project",
            scopeId: "project-1",
            intent: "item",
            identity: "definition",
          }),
        )}`,
      ),
    ).toBeNull();
    expect(
      parseResourceTarget(
        buildResourceTarget({
          namespace: "t3-resource",
          version: 1,
          kind: "mcp",
          scope: "environment",
          scopeId: "environment-1",
          intent: "create",
        } as const) + "-suffix",
      ),
    ).toBeNull();
    expect(
      parseResourceTarget(
        `t3-resource-v1:${encodeURIComponent(
          JSON.stringify({
            namespace: "t3-resource",
            version: 1,
            kind: "mcp",
            scope: "environment",
            scopeId: "environment-1",
            intent: "create",
            body: "must-not-cross-the-route",
          }),
        )}`,
      ),
    ).toBeNull();
  });

  it("builds a scoped create destination without an item identity", () => {
    const target = makeEnvironmentCreateTarget("mcp", EnvironmentId.make("server-1"));
    expect(parseResourceTarget(buildResourceTarget(target))).toEqual(target);
    expect(target).toMatchObject({ kind: "mcp", scope: "environment", intent: "create" });
  });
});
