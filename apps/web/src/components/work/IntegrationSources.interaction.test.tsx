/* @vitest-environment happy-dom */
import {
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectTeamIntegrationSourcePage,
  type ProjectTeamIntegrationSourceRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const read = vi.hoisted(() => vi.fn());
vi.mock("../../state/projectWork", () => ({
  projectWorkEnvironment: { integrationSources: vi.fn() },
}));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => read }));
import { IntegrationSources } from "./IntegrationSources";

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const taskId = ProjectWorkTaskId.make("integration");
const decodePage = Schema.decodeUnknownSync(ProjectTeamIntegrationSourcePage);
function page(head = "d") {
  return decodePage({
    environmentId,
    projectId,
    taskId,
    revision: 10,
    taskRevision: 2,
    nextOffset: 2,
    hasMore: false,
    candidates: ["source-a", "source-b"].map((id, index) => {
      const source = {
        taskId: id,
        bindingId: `binding-${id}`,
        bindingRevision: 1,
        generation: 0,
        dispatchId: `dispatch-${id}`,
        workspaceReceiptSha256: "a".repeat(64),
        specRevision: 1,
        planRevision: 1,
        scopeHash: "b".repeat(64),
        branchRef: `refs/heads/${id}`,
        baseSha: "c".repeat(40),
        headSha: (index === 0 ? head : "e").repeat(40),
        testedTree: "f".repeat(40),
        reviewDispatchId: `review-${id}`,
        reviewProposalSha256: "1".repeat(64),
        joinedReceiptId: `joined-${id}`,
        jobId: `job-${id}`,
        manifestHash: "2".repeat(64),
        attemptId: `attempt-${id}`,
        resultHash: "3".repeat(64),
      };
      return {
        taskTitle: id,
        source,
        ref: {
          taskId: id,
          bindingId: source.bindingId,
          expectedBindingRevision: 1,
          generation: 0,
          reviewDispatchId: source.reviewDispatchId,
          expectedReviewProposalSha256: source.reviewProposalSha256,
          verificationJobId: source.jobId,
          expectedManifestHash: source.manifestHash,
          expectedBranchRef: source.branchRef,
          expectedBaseSha: source.baseSha,
          expectedHeadSha: source.headSha,
          expectedTestedTree: source.testedTree,
        },
      };
    }),
  });
}
let root: Root | undefined;
let host: HTMLDivElement | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  read.mockReset();
  vi.unstubAllGlobals();
});
async function mount(selected: readonly ProjectTeamIntegrationSourceRef[] = []) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const onChange = vi.fn((next: readonly ProjectTeamIntegrationSourceRef[]) => {
    props = { ...props, selected: next };
    root!.render(<IntegrationSources {...props} />);
  });
  let props = {
    environmentId,
    projectId,
    taskId,
    revision: 10,
    taskRevision: 2,
    disabled: false,
    selected,
    onChange,
  };
  await act(async () => root!.render(<IntegrationSources {...props} />));
  return {
    onChange,
    update: async (change: Partial<typeof props>) => {
      props = { ...props, ...change };
      await act(async () => root!.render(<IntegrationSources {...props} />));
    },
  };
}
function button(label: string, index = 0) {
  const matches = [...host!.querySelectorAll("button")].filter(
    (element) => element.textContent === label,
  );
  expect(matches[index]).toBeDefined();
  return matches[index]!;
}
it("retains exact reviewed commits and changes their approved order only on a user action", async () => {
  const candidates = page();
  read.mockResolvedValue({ _tag: "Success", value: candidates });
  const mounted = await mount();
  await act(async () => button("Load reviewed sources").click());
  expect(host!.textContent).toContain(candidates.candidates[0]!.source.headSha);
  await act(async () => button("Select source", 0).click());
  await act(async () => button("Select source", 0).click());
  expect(mounted.onChange.mock.lastCall?.[0]).toEqual(
    candidates.candidates.map((candidate) => candidate.ref),
  );
  await act(async () => button("Move earlier", 1).click());
  expect(mounted.onChange.mock.lastCall?.[0]).toEqual(
    candidates.candidates.toReversed().map((candidate) => candidate.ref),
  );
});
it("preserves a retained old commit until the human replaces the changed source", async () => {
  const old = page().candidates[0]!.ref;
  const fresh = page("9");
  read.mockResolvedValue({ _tag: "Success", value: fresh });
  const second = fresh.candidates[1]!.ref;
  const mounted = await mount([old, second]);
  await act(async () => button("Load reviewed sources").click());
  expect(host!.textContent).toContain(`Commit ${old.expectedHeadSha}`);
  expect(mounted.onChange).not.toHaveBeenCalled();
  await act(async () => button("Replace changed source").click());
  expect(mounted.onChange.mock.lastCall?.[0]).toEqual([fresh.candidates[0]!.ref, second]);
});
it("discards a source response when access changes while its read is pending", async () => {
  let complete!: (value: unknown) => void;
  read.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const mounted = await mount();
  await act(async () => button("Load reviewed sources").click());
  await mounted.update({ disabled: true });
  await act(async () => complete({ _tag: "Success", value: page() }));
  expect(host!.textContent).not.toContain("Select source");
  expect(mounted.onChange).not.toHaveBeenCalled();
});

it("discards the old page and pending response when the owning task revision changes", async () => {
  let complete!: (value: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const old = page().candidates[0]!.ref;
  const mounted = await mount([old]);
  await act(async () => button("Load reviewed sources").click());
  await mounted.update({ revision: 11, taskRevision: 3 });
  await act(async () => complete({ _tag: "Success", value: page("9") }));
  expect(host!.textContent).not.toContain("Replace changed source");
  expect(host!.textContent).toContain(`Commit ${old.expectedHeadSha}`);
  expect(button("Load reviewed sources").disabled).toBe(false);
  const fresh = { ...page("9"), revision: 11, taskRevision: 3 };
  read.mockResolvedValueOnce({ _tag: "Success", value: fresh });
  await act(async () => button("Load reviewed sources").click());
  expect(host!.textContent).toContain("Replace changed source");
  expect(mounted.onChange).not.toHaveBeenCalled();
});
