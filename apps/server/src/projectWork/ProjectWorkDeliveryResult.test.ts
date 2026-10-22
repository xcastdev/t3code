import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ProjectWorkDeliveryResult } from "@t3tools/contracts";
import { publicDeliveryResult } from "./ProjectWorkDeliveryGateway.ts";
import { publicationHash } from "./ProjectWorkPublicationJournal.ts";
import { operation, confirmation } from "./ProjectWorkPublication.testkit.ts";

it("exposes only the opaque retained confirmed merge receipt required for acceptance", () => {
  const retained = { ...operation("merge", "confirmed"), merge: confirmation };
  const result = Schema.decodeUnknownSync(ProjectWorkDeliveryResult)(
    publicDeliveryResult(retained),
  );
  expect(result.receiptHash).toBe(publicationHash(retained));
  expect(JSON.stringify(result)).not.toMatch(
    /fingerprint|owned\/workspace|principal|authorizationRecordIds/,
  );
  expect(publicDeliveryResult({ ...retained, stage: "uncertain" }).receiptHash).toBeUndefined();
  expect(publicDeliveryResult(operation("create-pr", "confirmed")).receiptHash).toBeUndefined();
  expect(
    publicDeliveryResult({
      ...retained,
      merge: { ...confirmation, mergedCommitSha: "f".repeat(40) },
    }).receiptHash,
  ).not.toBe(result.receiptHash);
});
