/* @vitest-environment happy-dom */

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useConfirmationLease } from "./confirmationLease";

type Lease = ReturnType<typeof useConfirmationLease>;

function LeaseProbe(props: { readonly onReady: (lease: Lease) => void }) {
  const lease = useConfirmationLease();
  useEffect(() => props.onReady(lease), [lease, props]);
  return null;
}

let root: Root | null = null;
let lease: Lease | null = null;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <LeaseProbe
        onReady={(next) => {
          lease = next;
        }}
      />,
    );
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  lease = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("useConfirmationLease", () => {
  it("keeps an executing owner exclusive until that exact token settles", () => {
    const first = lease!.issue();
    expect(first).not.toBeNull();
    expect(lease!.consume(first!)).toBe(true);

    // A subsequent dialog/cancel cannot steal the lane while the original
    // provider request has not settled.
    expect(lease!.issue()).toBeNull();
    lease!.revoke(first!);
    expect(lease!.issue()).toBeNull();

    lease!.settle(first!);
    const second = lease!.issue();
    expect(second).toBeGreaterThan(first!);
    expect(lease!.consume(second!)).toBe(true);
  });

  it("replaces pending form approval without reviving the retained callback", () => {
    const original = lease!.issue();
    const replacement = lease!.replace(original!);

    expect(replacement).not.toBeNull();
    expect(lease!.consume(original!)).toBe(false);
    expect(lease!.consume(replacement!)).toBe(true);
    lease!.settle(replacement!);
  });
});
