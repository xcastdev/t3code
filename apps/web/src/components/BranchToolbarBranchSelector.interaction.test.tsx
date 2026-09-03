import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

import { runAuthoritativeDirtyBranchMutation } from "./source-control/sourceControlPanel.logic";

describe("BranchToolbarBranchSelector branch interaction", () => {
  it("cancelling the proactive confirmation sends no checkout mutation", async () => {
    const confirm = vi.fn(async () => false);
    const mutate = vi.fn(async () => ({
      _tag: "Success" as const,
      value: { refName: "feature" },
    }));

    const result = await runAuthoritativeDirtyBranchMutation({
      hasWorkingTreeChanges: true,
      confirm,
      mutate,
    });

    expect(result).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("cancelling the proactive confirmation sends no create-and-switch mutation", async () => {
    const confirm = vi.fn(async () => false);
    const createAndSwitch = vi.fn(async () => ({
      _tag: "Success" as const,
      value: { refName: "feature" },
    }));

    const result = await runAuthoritativeDirtyBranchMutation({
      hasWorkingTreeChanges: true,
      confirm,
      mutate: createAndSwitch,
    });

    expect(result).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(createAndSwitch).not.toHaveBeenCalled();
  });

  it("cancelling the authoritative retry sends no second checkout mutation", async () => {
    const confirm = vi.fn(async () => false);
    const mutate = vi.fn().mockResolvedValue({
      _tag: "Failure" as const,
      cause: Cause.fail({ code: "dirty_worktree_confirmation_required" }),
    });

    const result = await runAuthoritativeDirtyBranchMutation({
      hasWorkingTreeChanges: false,
      confirm,
      mutate,
    });

    expect(result).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(false);
  });

  it("retries create-and-switch exactly once with authoritative confirmation", async () => {
    const confirm = vi.fn(async () => true);
    const mutate = vi
      .fn()
      .mockResolvedValueOnce({
        _tag: "Failure" as const,
        cause: Cause.fail({ code: "dirty_worktree_confirmation_required" }),
      })
      .mockResolvedValueOnce({ _tag: "Success" as const, value: { refName: "feature" } });

    await expect(
      runAuthoritativeDirtyBranchMutation({
        hasWorkingTreeChanges: true,
        confirm,
        mutate,
      }),
    ).resolves.toEqual({ _tag: "Success", value: { refName: "feature" } });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenNthCalledWith(1, false);
    expect(mutate).toHaveBeenNthCalledWith(2, true);
  });
});
