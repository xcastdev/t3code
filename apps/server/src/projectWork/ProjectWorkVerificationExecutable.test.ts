import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  captureVerificationExecutable,
  supportedVerificationRuntimeFiles,
} from "./ProjectWorkVerificationExecutable.ts";
import { setup } from "./ProjectWorkVerification.testFixtures.ts";
const fs = process.getBuiltinModule("fs");

it.live("detects replacement with identical bytes using the retained runtime file identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup();
      const first = yield* captureVerificationExecutable(fixture.executable, [fixture.executable]);
      const replacement = `${fixture.root}/identical`;
      fs.writeFileSync(replacement, fs.readFileSync(fixture.executable), { mode: 0o700 });
      fs.renameSync(replacement, fixture.executable);
      const second = yield* captureVerificationExecutable(fixture.executable, [fixture.executable]);
      assert.equal(second.sha256, first.sha256);
      assert.notEqual(second.runtimeClosureSha256, first.runtimeClosureSha256);
    }),
  ),
);

it.live("fingerprints every host runtime file and rejects duplicate or symbolic link targets", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup();
      const dependency = `${fixture.root}/runtime`;
      fs.writeFileSync(dependency, "dependency one");
      const first = yield* captureVerificationExecutable(fixture.executable, [
        fixture.executable,
        dependency,
      ]);
      fs.writeFileSync(dependency, "dependency two");
      const second = yield* captureVerificationExecutable(fixture.executable, [
        dependency,
        fixture.executable,
      ]);
      assert.notEqual(first.runtimeClosureSha256, second.runtimeClosureSha256);
      assert.isTrue(
        Exit.isFailure(
          yield* captureVerificationExecutable(fixture.executable, [
            fixture.executable,
            fixture.executable,
          ]).pipe(Effect.exit),
        ),
      );
      const link = `${fixture.root}/link`;
      fs.symlinkSync(fixture.executable, link);
      assert.isTrue(
        Exit.isFailure(yield* captureVerificationExecutable(link, [link]).pipe(Effect.exit)),
      );
    }),
  ),
);

it.live("does not treat unresolved shebang interpreters as a captured runtime closure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup();
      fs.writeFileSync(fixture.executable, "#!/usr/bin/env node\nprocess.exit(0)\n");
      assert.isTrue(
        Exit.isFailure(
          yield* captureVerificationExecutable(fixture.executable, [fixture.executable]).pipe(
            Effect.exit,
          ),
        ),
      );
      fs.writeFileSync(fixture.executable, "#!/missing/interpreter\nexit 0\n");
      assert.isTrue(
        Exit.isFailure(
          yield* captureVerificationExecutable(fixture.executable, [fixture.executable]).pipe(
            Effect.exit,
          ),
        ),
      );
    }),
  ),
);

it.live(
  "captures a finite native/interpreter/entrypoint/config closure and refuses dynamic interpreter arguments",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup();
        const node = `${fixture.root}/node`;
        fs.writeFileSync(node, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), { mode: 0o700 });
        fs.writeFileSync(`${fixture.repo}/check.js`, "process.exit(0)");
        fs.writeFileSync(`${fixture.repo}/package.json`, '{"type":"module"}');
        const command = { ...fixture.input.command, executable: node, argv: ["check.js"] };
        assert.deepStrictEqual(
          yield* supportedVerificationRuntimeFiles(command, fixture.repo),
          [node, `${fixture.repo}/check.js`, `${fixture.repo}/package.json`].sort(),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* supportedVerificationRuntimeFiles(
              { ...command, argv: ["-e", "process.exit(0)"] },
              fixture.repo,
            ).pipe(Effect.exit),
          ),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* supportedVerificationRuntimeFiles(
              { ...command, argv: ["../verify"] },
              fixture.repo,
            ).pipe(Effect.exit),
          ),
        );
        fs.writeFileSync(fixture.executable, `#!${node}\nfixture`);
        assert.deepStrictEqual(
          yield* supportedVerificationRuntimeFiles(
            { ...command, executable: fixture.executable, argv: [] },
            fixture.repo,
          ),
          [node, fixture.executable, `${fixture.repo}/package.json`].sort(),
        );
      }),
    ),
);
