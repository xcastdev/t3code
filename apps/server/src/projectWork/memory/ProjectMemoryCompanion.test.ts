import { assert, it } from "@effect/vitest";
import { companionPathOutsideArchive } from "./ProjectMemoryCompanion.ts";
it.each([
  [
    "/work/server/src/memory/companion/mem0_backend.py",
    "/work/server/src/memory/companion/mem0_backend.py",
  ],
  ["/usr/lib/t3/dist/companion/mem0_backend.py", "/usr/lib/t3/dist/companion/mem0_backend.py"],
  ["/usr/bin/companion/mem0_backend.py", "/usr/bin/companion/mem0_backend.py"],
  [
    "/resources/app.asar/node_modules/t3/dist/companion/mem0_backend.py",
    "/resources/app.asar.unpacked/node_modules/t3/dist/companion/mem0_backend.py",
  ],
  [
    "/resources/server.asar/companion/mem0_backend.py",
    "/resources/server.asar.unpacked/companion/mem0_backend.py",
  ],
  [
    "C:\\resources\\app.asar\\companion\\mem0_backend.py",
    "C:\\resources\\app.asar.unpacked\\companion\\mem0_backend.py",
  ],
  [
    "/resources/app.asar.unpacked/companion/mem0_backend.py",
    "/resources/app.asar.unpacked/companion/mem0_backend.py",
  ],
])("resolves external companion path %s", (input, expected) =>
  assert.equal(companionPathOutsideArchive(input), expected),
);
