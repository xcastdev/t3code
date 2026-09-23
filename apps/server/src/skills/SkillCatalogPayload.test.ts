import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ManagedSkillContent, ManagedSkillKey } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ManagedSkillRepository from "./ManagedSkillRepository.ts";
import { toSkillCatalogEntry } from "./SkillCatalogIndex.ts";
import { projectSkillCatalog } from "./SkillCatalogProjection.ts";
import { resolveSkillCatalog } from "./SkillCatalogResolver.ts";

const content = (key: string): ManagedSkillContent => ({
  key: key as ManagedSkillKey,
  name: key,
  body: "Use the attached reference.",
});

const TestLayer = ManagedSkillRepository.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "skill-payload-" })),
  Layer.provideMerge(NodeServices.layer),
);

describe("skill catalog payload bounds", () => {
  it.layer(TestLayer)("keeps large package assets out of ordinary catalog summaries", (it) => {
    it.effect("changes only bounded hash metadata", () =>
      Effect.gen(function* () {
        const repository = yield* ManagedSkillRepository.ManagedSkillRepository;
        yield* repository.importGlobal({
          expectedRevision: 0,
          content: content("small"),
          files: [{ relativePath: "assets/reference.bin", bytes: new Uint8Array(1) }],
        });
        yield* repository.importGlobal({
          expectedRevision: 0,
          content: content("large"),
          files: [
            {
              relativePath: "assets/reference.bin",
              bytes: new Uint8Array(1024 * 1024),
            },
          ],
        });
        const entries = yield* repository.listGlobal();
        const projected = projectSkillCatalog(
          resolveSkillCatalog({
            global: {
              scope: "global",
              scopeId: "global",
              catalogRevision: 1,
              availability: "available",
              entries: entries.map((entry) => toSkillCatalogEntry(entry, "global")),
            },
          }),
        );
        const sizes = projected.entries.map((entry) => JSON.stringify(entry).length);
        assert.isBelow(Math.max(...sizes), 1_024);
        assert.isBelow(Math.abs((sizes[0] ?? 0) - (sizes[1] ?? 0)), 64);
      }),
    );
  });
});
