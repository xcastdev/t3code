import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { EnvironmentId, OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";

import { resolveSettingsScope } from "../../components/settings/settingsScope";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { resolveResourceScope } from "./resourceScope";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const decodeProject = Schema.decodeUnknownSync(OrchestrationProjectShell);
const makeMember = (id: ProjectId, root: string): SidebarProjectGroupMember => ({
  ...decodeProject({
    id,
    title: root,
    workspaceRoot: root,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }),
  environmentId,
  physicalProjectKey: root,
  environmentLabel: "Dev",
});
const makeGroup = (members: readonly SidebarProjectGroupMember[]): SidebarProjectSnapshot => ({
  ...members[0]!,
  projectKey: "group-1",
  displayName: "Project",
  groupedProjectCount: members.length,
  environmentPresence: "local-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  memberProjects: members,
  memberProjectRefs: members.map((member) => ({
    environmentId: member.environmentId,
    projectId: member.id,
  })),
  remoteEnvironmentLabels: [],
});
const makeEnvironment = (connected: boolean, capabilities = {}) => ({
  environmentId,
  label: "Dev",
  connection: { phase: connected ? "connected" : "disconnected" },
  serverConfig: connected
    ? {
        settings: {},
        environment: { capabilities },
      }
    : null,
});
const makeTarget = () => ({
  environmentId,
  label: "Dev",
  projectId,
  settings: {},
  sources: {},
});

describe("resolveResourceScope", () => {
  it("requires one physical checkout even when multiple checkouts share an environment", () => {
    const scope = resolveSettingsScope(
      { project: "group-1", machine: environmentId },
      [
        makeGroup([
          makeMember(projectId, "/first"),
          makeMember(ProjectId.make("project-2"), "/second"),
        ]),
      ],
      [{ environmentId, label: "Dev" }],
    );
    const result = resolveResourceScope({
      scope,
      environments: [makeEnvironment(true)],
      targets: [makeTarget()],
    });

    expect(result.kind).toBe("ambiguous");
  });

  it("does not pick a connected representative for an explicit disconnected environment", () => {
    const scope = resolveSettingsScope(
      { machine: environmentId },
      [],
      [{ environmentId, label: "Dev" }],
    );
    const result = resolveResourceScope({
      scope,
      environments: [makeEnvironment(false)],
      targets: [],
    });

    expect(result).toMatchObject({
      kind: "unavailable",
      message: "Reconnect Dev to view its resources.",
    });
  });

  it("requires a checkout when one project member is disconnected", () => {
    const secondEnvironmentId = EnvironmentId.make("environment-2");
    const members = [
      makeMember(projectId, "/connected"),
      {
        ...makeMember(ProjectId.make("project-2"), "/disconnected"),
        environmentId: secondEnvironmentId,
        environmentLabel: "Offline",
      },
    ];
    const scope = resolveSettingsScope(
      { project: "group-1" },
      [makeGroup(members)],
      [
        { environmentId, label: "Dev" },
        { environmentId: secondEnvironmentId, label: "Offline" },
      ],
    );
    const result = resolveResourceScope({
      scope,
      environments: [makeEnvironment(true)],
      targets: [makeTarget()],
    });

    expect(result.kind).toBe("ambiguous");
  });

  it("rejects an explicitly disconnected checkout before catalog queries are built", () => {
    const scope = resolveSettingsScope(
      { project: "group-1", machine: environmentId, checkout: "/offline" },
      [makeGroup([makeMember(projectId, "/offline")])],
      [{ environmentId, label: "Dev" }],
    );
    const result = resolveResourceScope({
      scope,
      environments: [makeEnvironment(false)],
      targets: [],
    });

    expect(result.kind).toBe("unavailable");
  });

  it("keeps stale checkout selections unavailable", () => {
    const scope = resolveSettingsScope(
      { project: "group-1", machine: environmentId, checkout: "/removed" },
      [makeGroup([makeMember(projectId, "/current")])],
      [{ environmentId, label: "Dev" }],
    );
    const result = resolveResourceScope({
      scope,
      environments: [makeEnvironment(true)],
      targets: [makeTarget()],
    });

    expect(result).toMatchObject({ kind: "unavailable" });
  });
});
