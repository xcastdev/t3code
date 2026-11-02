import {
  EnvironmentId,
  ProjectId,
  ProjectTeamRecordRead,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { WorkTeam } from "./WorkTeam";
import type { WorkWriter } from "./useWorkWriter";

const mocks = vi.hoisted(() => ({ roster: vi.fn(), providers: vi.fn() }));
vi.mock("./useWorkTeamRoster", () => ({ useWorkTeamRoster: mocks.roster }));
vi.mock("./WorkTeamRoster", () => ({
  // Stands in for the member cards' edit buttons.
  WorkTeamMembers: (props: { onEditMember?: (role: string) => void }) => (
    <button type="button" onClick={() => props.onEditMember?.("planner")}>
      Edit planner
    </button>
  ),
}));
vi.mock("../../state/environments", () => ({ useEnvironmentProviders: mocks.providers }));
// The composer's model picker has its own tests; this one covers names and avatars.
vi.mock("../chat/ModelSelectionPicker", () => ({ ModelSelectionPicker: () => null }));

function setup() {
  document.documentElement.classList.add("dark");
  mocks.roster.mockReset();
  mocks.providers.mockReset();
  mocks.providers.mockReturnValue(new Map());
  const setRevision = (revision: number, records: ReadonlyArray<unknown> = []) => {
    const set = {
      complete: true,
      truncated: false,
      failed: false,
      status: "ready",
      revision,
      records: [],
      retry: () => {},
    };
    mocks.roster.mockReturnValue({ limits: set, roles: set, members: set, records, roster: [] });
  };
  setRevision(0);
  const writer: WorkWriter = {
    canWrite: true,
    canIssue: false,
    canDeliver: false,
    pendingKey: null,
    failure: null,
    submit: vi.fn(async () => false),
    runIssue: vi.fn(async () => null),
    runDelivery: vi.fn(async () => null),
    failureFor: () => null,
    dismiss: () => {},
  };
  const scope = {
    environmentId: EnvironmentId.make("team-env"),
    projectId: ProjectId.make("team-project"),
    checkoutPath: "/demo",
  };
  return { writer, scope, setRevision };
}

it("keeps unsaved team names and avatar choices when reviewing a newer project revision", async () => {
  const { writer, scope, setRevision } = setup();
  await using screen = await render(
    <WorkTeam scope={scope} writer={writer} onOpenTask={() => {}} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Set up team", exact: true }));
  await userEvent.fill(screen.getByPlaceholder("Coordinator"), "Unsaved QA name");
  const coordinator = screen.getByRole("group", { name: "Unsaved QA name · Coordinator" });
  await userEvent.click(coordinator.getByRole("button", { name: "Sand", exact: true }));
  await userEvent.click(coordinator.getByRole("button", { name: "Curious", exact: true }));
  await userEvent.click(coordinator.getByRole("switch", { name: "Animate", exact: true }));
  setRevision(1);
  await screen.rerender(<WorkTeam scope={scope} writer={writer} onOpenTask={() => {}} />);
  await expect
    .element(screen.getByRole("button", { name: "Review current revision" }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Review current revision" }));
  await expect.element(screen.getByPlaceholder("Coordinator")).toHaveValue("Unsaved QA name");
  await expect
    .element(coordinator.getByRole("img", { name: "Unsaved QA name's avatar: curious, sand face" }))
    .toBeVisible();
  await expect
    .element(coordinator.getByRole("button", { name: "Preview", exact: true }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Review current revision" }))
    .not.toBeInTheDocument();
  setRevision(2);
  await screen.rerender(<WorkTeam scope={scope} writer={writer} onOpenTask={() => {}} />);
  await expect
    .element(screen.getByRole("button", { name: "Review current revision" }))
    .toBeVisible();
  expect(writer.submit).not.toHaveBeenCalled();
});

const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecordRead);
const ROLES = ["coordinator", "investigator", "planner", "implementer", "reviewer", "integrator"];
function configuredTeam(generation: number) {
  const fields = { projectId: "team-project", updatedAt: "2026-01-01T00:00:00.000Z" };
  const roles = ROLES.map((role) =>
    decodeRecord({
      ...fields,
      recordId: `role:${role}:${generation}`,
      revision: 0,
      generation,
      kind: "role-revision",
      status: "available",
      roleId: role,
      roleRevision: generation,
      role,
      instructions: `Act as ${role}`,
      skills: [],
      tools: [],
      model: "model-a",
      providerInstanceId: "codex",
      memoryAccess: "project",
      delegationDepth: 1,
    }),
  );
  const limits = decodeRecord({
    ...fields,
    recordId: "limits:codex:model-a",
    revision: 0,
    generation,
    kind: "limits",
    status: "disabled",
    environmentModelCalls: 2,
    projectWritableWorkers: 1,
    modelCalls: 3,
    delegationDepth: 2,
    repairAllowance: 2,
    model: "model-a",
    tokenLimit: 1000,
    durationLimitMs: 60_000,
    providerInstanceId: "codex",
    projectPriority: 0,
    taskPriorities: [],
    profileRecordIds: roles.map((role) => role.recordId),
  });
  return [limits, ...roles];
}

it("saves one member's edit with every other member and the limits as recorded", async () => {
  const { writer, scope, setRevision } = setup();
  setRevision(4, configuredTeam(3));
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: "model-a", name: "Model A", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  };
  mocks.providers.mockReturnValue(new Map([[scope.environmentId, [provider]]]));
  await using screen = await render(
    <WorkTeam scope={scope} writer={writer} onOpenTask={() => {}} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Edit planner", exact: true }));
  const save = screen.getByRole("button", { name: "Save", exact: true });
  await expect.element(save).toBeDisabled();
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Instructions" }),
    "Plan in small steps",
  );
  await expect.element(save).toBeEnabled();
  await userEvent.click(save);

  expect(writer.submit).toHaveBeenCalledTimes(1);
  const intent = vi.mocked(writer.submit).mock.calls[0]![3] as {
    readonly expectedConfigurationGeneration: number;
    readonly profiles: ReadonlyArray<{ readonly role: string; readonly instructions: string }>;
    readonly modelPolicies: ReadonlyArray<{ readonly model: string; readonly modelCalls: number }>;
    readonly enabled: boolean;
  };
  expect(intent.expectedConfigurationGeneration).toBe(3);
  expect(intent.enabled).toBe(false);
  expect(intent.profiles.map((profile) => [profile.role, profile.instructions])).toEqual(
    ROLES.map((role) => [role, role === "planner" ? "Plan in small steps" : `Act as ${role}`]),
  );
  expect(intent.modelPolicies).toMatchObject([{ model: "model-a", modelCalls: 3 }]);
});
