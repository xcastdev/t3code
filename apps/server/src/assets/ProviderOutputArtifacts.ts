import type { AssetResource } from "@t3tools/contracts";
import { ownedOmpSessionDirectory } from "@t3tools/provider-omp/server";
import { isOmpArtifactId, ompArtifactReferences } from "@t3tools/shared/ompEval";
import { isNetworkPath } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";

export const resolveProviderOutputArtifact = Effect.fn("ProviderOutputArtifacts.resolve")(
  function* (resource: Extract<AssetResource, { _tag: "provider-output-artifact" }>) {
    if (!isOmpArtifactId(resource.artifactId)) return null;
    const orchestrator = yield* OrchestratorV2;
    const item = yield* orchestrator.getTurnItem({
      threadId: resource.threadId,
      itemId: resource.turnItemId,
    });
    if (
      !item ||
      item.type !== "dynamic_tool" ||
      item.threadId !== resource.threadId ||
      item.nativeItemRef?.driver !== "omp" ||
      !item.providerThreadId ||
      !ompArtifactReferences(item.output).some((ref) => ref.id === resource.artifactId)
    )
      return null;
    const records = yield* orchestrator.getThreadRecords(resource.threadId, [
      "providerThreads",
      "providerSessions",
    ]);
    const owner = records.providerThreads.find((thread) => thread.id === item.providerThreadId);
    if (
      records.thread.id !== resource.threadId ||
      !owner ||
      owner.driver !== "omp" ||
      owner.appThreadId !== resource.threadId ||
      owner.nativeThreadRef?.driver !== "omp" ||
      owner.nativeThreadRef.strength !== "strong"
    )
      return null;
    if (
      owner.providerSessionId !== null &&
      !records.providerSessions.some(
        (session) =>
          session.id === owner.providerSessionId &&
          session.driver === "omp" &&
          session.providerInstanceId === owner.providerInstanceId,
      )
    )
      return null;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const nativeId = owner.nativeThreadRef.nativeId;
    if (
      typeof nativeId !== "string" ||
      !path.isAbsolute(nativeId) ||
      isNetworkPath(nativeId) ||
      !nativeId.endsWith(".jsonl")
    )
      return null;
    const root = ownedOmpSessionDirectory(config.stateDir, owner.providerInstanceId);
    const state = yield* fs.realPath(config.stateDir);
    const canonicalRoot = yield* fs.realPath(root);
    if (canonicalRoot !== ownedOmpSessionDirectory(state, owner.providerInstanceId)) return null;
    const journal = path.resolve(nativeId);
    const relativeRoot = isWithinRoot(path, journal, root) ? root : canonicalRoot;
    if (!isWithinRoot(path, journal, relativeRoot)) return null;
    const canonicalJournal = yield* fs.realPath(journal);
    if (
      canonicalJournal !== path.join(canonicalRoot, path.relative(relativeRoot, journal)) ||
      (yield* fs.stat(canonicalJournal)).type !== "File"
    )
      return null;
    const directory = canonicalJournal.slice(0, -".jsonl".length);
    if ((yield* fs.realPath(directory)) !== directory) return null;
    const pattern = new RegExp(`^${resource.artifactId}\\.[A-Za-z0-9_-]{1,64}\\.log$`);
    const matches = (yield* fs.readDirectory(directory)).filter((name) => pattern.test(name));
    if (matches.length !== 1) return null;
    const filePath = path.join(directory, matches[0]!);
    return (yield* fs.realPath(filePath)) === filePath ? { filePath, fileName: matches[0]! } : null;
  },
  (effect) => effect.pipe(Effect.orElseSucceed(() => null)),
);
