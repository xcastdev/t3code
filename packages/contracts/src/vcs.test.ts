import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { VcsMutationRejectionCode } from "./vcs.ts";

const decodeVcsMutationRejectionCode = Schema.decodeUnknownSync(VcsMutationRejectionCode);

describe("VcsMutationRejectionCode", () => {
  it("accepts each typed repository mutation rejection", () => {
    expect(decodeVcsMutationRejectionCode("dirty_worktree_confirmation_required")).toBe(
      "dirty_worktree_confirmation_required",
    );
    expect(decodeVcsMutationRejectionCode("default_ref_confirmation_required")).toBe(
      "default_ref_confirmation_required",
    );
    expect(decodeVcsMutationRejectionCode("stale_git_state")).toBe("stale_git_state");
  });
});
