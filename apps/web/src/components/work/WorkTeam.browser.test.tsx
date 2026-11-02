import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { WorkTeam } from "./WorkTeam";
import type { WorkWriter } from "./useWorkWriter";

const mocks = vi.hoisted(() => ({ roster: vi.fn(), providers: vi.fn() }));
vi.mock("./useWorkTeamRoster", () => ({ useWorkTeamRoster: mocks.roster }));
vi.mock("./WorkTeamRoster", () => ({ WorkTeamMembers: () => null }));
vi.mock("../../state/environments", () => ({ useEnvironmentProviders: mocks.providers }));

function setup() {
  document.documentElement.classList.add("dark");
  mocks.roster.mockReset();
  mocks.providers.mockReset();
  mocks.providers.mockReturnValue(new Map());
  const setRevision = (revision: number) => {
    const set = {
      complete: true,
      truncated: false,
      failed: false,
      status: "ready",
      revision,
      records: [],
      retry: () => {},
    };
    mocks.roster.mockReturnValue({ limits: set, roles: set, members: set, records: [] });
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
