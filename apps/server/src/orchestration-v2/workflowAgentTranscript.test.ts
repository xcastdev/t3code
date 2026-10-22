// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { assert } from "vite-plus/test";

import {
  initialWorkflowAgentTranscriptCursor,
  readWorkflowAgentTranscript,
  readWorkflowAgentTranscriptPage,
} from "./workflowAgentTranscript.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const assistant = (uuid: string, text: string) =>
  line({
    type: "assistant",
    uuid,
    message: { role: "assistant", id: uuid, content: [{ type: "text", text }] },
  });
const uuids = (lines: ReadonlyArray<unknown>) =>
  lines.map((entry) => (entry as { readonly uuid: string }).uuid);

it.layer(NodeServices.layer)("readWorkflowAgentTranscript", (it) => {
  it.effect("reads complete lines from its cursor and starts over on a new file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "wf-transcript-" });
      const transcriptDir = NodePath.join(configDir, "projects", "test");
      yield* fileSystem.makeDirectory(transcriptDir, { recursive: true });
      const file = NodePath.join(transcriptDir, "agent-a1.jsonl");
      const read = (cursor = initialWorkflowAgentTranscriptCursor) =>
        readWorkflowAgentTranscript({ transcriptDir, agentId: "a1", cursor, configDir });

      const bookkeeping =
        line({ type: "attachment", uuid: "att", attachment: { type: "skill_listing" } }) +
        line({ type: "user", uuid: "meta", isMeta: true, message: { content: "context" } });
      const second = assistant("b", "second");
      NodeFS.writeFileSync(file, bookkeeping + assistant("a", "first") + second.slice(0, 20));
      const first = yield* read();
      assert.deepEqual(uuids(first.lines), ["a"]);
      assert.equal(first.fidelity, "partial");
      assert.equal(first.incompleteLine, true);
      assert.equal(
        first.cursor.offset,
        Buffer.byteLength(bookkeeping + assistant("a", "first")),
        "a half-written line is left for the next read",
      );

      NodeFS.appendFileSync(file, second.slice(20));
      const next = yield* read(first.cursor);
      assert.deepEqual(uuids(next.lines), ["b"]);
      assert.equal(next.cursor.offset, NodeFS.statSync(file).size);

      NodeFS.rmSync(file);
      NodeFS.writeFileSync(file, assistant("c", "replaced"));
      const replaced = yield* read(next.cursor);
      assert.deepEqual(uuids(replaced.lines), ["c"], "a new inode reads from 0");
      assert.equal(replaced.reset, true);
      assert.equal(replaced.fidelity, "partial");

      NodeFS.writeFileSync(file, assistant("d", "x"));
      assert.equal(NodeFS.statSync(file).ino, replaced.cursor.identity?.ino);
      const shrunk = yield* read(replaced.cursor);
      assert.deepEqual(uuids(shrunk.lines), ["d"], "a shrunk file reads from 0");
    }).pipe(Effect.scoped),
  );
  it.effect(
    "reports unavailable, malformed and capped files without claiming complete history",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "wf-fidelity-" });
        const transcriptDir = NodePath.join(configDir, "projects", "test");
        yield* fileSystem.makeDirectory(transcriptDir, { recursive: true });
        const input = {
          transcriptDir,
          agentId: "a1",
          cursor: initialWorkflowAgentTranscriptCursor,
          configDir,
        };
        const unavailable = yield* readWorkflowAgentTranscriptPage(input);
        assert.deepEqual(unavailable, { availability: "unavailable", reason: "not-found" });
        const file = NodePath.join(transcriptDir, "agent-a1.jsonl");
        NodeFS.writeFileSync(
          file,
          assistant("same", "a") +
            assistant("same", "a") +
            "broken\n" +
            line({ type: "assistant", message: {} }),
        );
        const malformed = yield* readWorkflowAgentTranscriptPage(input);
        assert.equal(malformed.availability, "available");
        if (malformed.availability !== "available") return;
        assert.deepEqual(uuids(malformed.lines), ["same"]);
        assert.equal(malformed.omittedLines, 2);
        assert.equal(malformed.fidelity, "partial");

        NodeFS.writeFileSync(file, "x".repeat(512 * 1024) + "\n" + assistant("after", "retained"));
        const capped = yield* readWorkflowAgentTranscript(input);
        assert.equal(capped.truncated, true);
        assert.equal(capped.skippedBytes, true);
        assert.equal(capped.fidelity, "partial");
        const after = yield* readWorkflowAgentTranscript({ ...input, cursor: capped.cursor });
        assert.deepEqual(uuids(after.lines), ["after"]);
        assert.equal(after.fidelity, "partial");
        NodeFS.writeFileSync(file, assistant("whole", "retained"));
        const complete = yield* readWorkflowAgentTranscript(input);
        assert.equal(complete.fidelity, "complete");
        assert.equal(complete.omittedLines, 0);
      }).pipe(Effect.scoped),
  );
  it.effect("omits conversation shapes the Claude projector cannot consume", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "wf-shape-" });
      const transcriptDir = NodePath.join(configDir, "projects", "test");
      yield* fileSystem.makeDirectory(transcriptDir, { recursive: true });
      const invalid = [
        { type: "assistant", uuid: "missing-message" },
        { type: "assistant", uuid: "null-message", message: null },
        { type: "assistant", uuid: "missing-content", message: {} },
        { type: "assistant", uuid: "null-content", message: { content: null } },
        { type: "assistant", uuid: "string-content", message: { content: "not an array" } },
        { type: "user", uuid: "invalid-user-content", message: { content: 42 } },
      ];
      const retained =
        assistant("assistant", "é 🚀") +
        line({ type: "user", uuid: "user-string", message: { content: "hello" } }) +
        line({
          type: "user",
          uuid: "user-array",
          message: { content: [{ type: "text", text: "hello" }] },
        });
      const contents =
        invalid.map(line).join("") +
        retained +
        line({ type: "user", uuid: "meta", isMeta: true, message: null }) +
        line({ type: "attachment", uuid: "attachment" });
      NodeFS.writeFileSync(NodePath.join(transcriptDir, "agent-a1.jsonl"), contents);
      const result = yield* readWorkflowAgentTranscript({
        transcriptDir,
        agentId: "a1",
        cursor: initialWorkflowAgentTranscriptCursor,
        configDir,
      });
      assert.deepEqual(uuids(result.lines), ["assistant", "user-string", "user-array"]);
      assert.equal(result.omittedLines, invalid.length);
      assert.equal(result.fidelity, "partial");
      assert.equal(result.cursor.offset, Buffer.byteLength(contents));
      assert.equal(result.skippedBytes, false);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps UTF-8 cursor offsets exact across an incomplete multibyte write", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "wf-utf8-" });
      const transcriptDir = NodePath.join(configDir, "projects", "test");
      yield* fileSystem.makeDirectory(transcriptDir, { recursive: true });
      const file = NodePath.join(transcriptDir, "agent-a1.jsonl");
      const retained = Buffer.from(assistant("retained", "é 🚀"));
      const pending = Buffer.from(assistant("pending", "🚀"));
      const split = pending.indexOf(Buffer.from("🚀")) + 2;
      NodeFS.writeFileSync(file, Buffer.concat([retained, pending.subarray(0, split)]));
      const input = {
        transcriptDir,
        agentId: "a1",
        cursor: initialWorkflowAgentTranscriptCursor,
        configDir,
      };
      const first = yield* readWorkflowAgentTranscript(input);
      assert.deepEqual(uuids(first.lines), ["retained"]);
      assert.equal(first.cursor.offset, retained.length);
      assert.equal(first.incompleteLine, true);
      assert.equal(first.fidelity, "partial");
      assert.equal(first.skippedBytes, false);
      NodeFS.appendFileSync(file, pending.subarray(split));
      const next = yield* readWorkflowAgentTranscript({ ...input, cursor: first.cursor });
      assert.deepEqual(uuids(next.lines), ["pending"]);
      assert.equal(next.cursor.offset, retained.length + pending.length);
      assert.equal(next.incompleteLine, false);
      assert.equal(next.skippedBytes, false);
    }).pipe(Effect.scoped),
  );
});
