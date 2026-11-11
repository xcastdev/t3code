// @effect-diagnostics nodeBuiltinImport:off - a maintainer git report with no app dependencies.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

// Three-way line-count check: a clean merge keeps each line at base + (upstream - base) +
// (fork - base) copies; a shortfall or excess undoes that side's change.
// usage: node scripts/upstream-preservation-check.ts BASE UPSTREAM FORK [MERGED] [--json FILE]

const SKIP = [".repos/", "pnpm-lock.yaml", "routeTree.gen.ts", ".generated."];
const TRIVIAL = new Set([
  "});",
  "}),",
  "];",
  "]);",
  "},",
  ")}",
  "/>",
  "</>",
  "</div>",
  "})",
  "}));",
]);
const TRIVIAL_LENGTH = 6;

const args = process.argv.slice(2);
const jsonIndex = args.indexOf("--json");
const jsonFile = jsonIndex === -1 ? undefined : args[jsonIndex + 1];
const positional = jsonIndex === -1 ? args : args.toSpliced(jsonIndex, 2);
const [base, upstream, fork, merged = "HEAD"] = positional;
if (!base || !upstream || !fork) {
  process.stderr.write(
    "usage: node scripts/upstream-preservation-check.ts BASE UPSTREAM FORK [MERGED] [--json FILE]\n",
  );
  process.exit(2);
}

const git = (...gitArgs: string[]) =>
  NodeChildProcess.execFileSync("git", gitArgs, {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });

function lineCounts(rev: string, path: string): Map<string, number> | null {
  let text: string;
  try {
    text = NodeChildProcess.execFileSync("git", ["show", `${rev}:${path}`], {
      encoding: "utf8",
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const counts = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length < TRIVIAL_LENGTH || TRIVIAL.has(line)) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

const changedSince = (rev: string) =>
  git("diff", "--name-only", "--no-renames", base, rev).split("\n").filter(Boolean);
const files = [...new Set([...changedSince(upstream), ...changedSince(fork)])]
  .filter((file) => !SKIP.some((skip) => file.includes(skip)))
  .sort();

type Issue = { readonly kind: "missing" | "not-removed"; readonly line: string };
type Entry = {
  readonly file: string;
  readonly note?: string;
  readonly upstream: Issue[];
  readonly fork: Issue[];
};
const report: Entry[] = [];
const same = (a: Map<string, number> | null, b: Map<string, number> | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.size === b.size &&
    [...a].every(([line, count]) => b.get(line) === count));

for (const file of files) {
  const b = lineCounts(base, file);
  const u = lineCounts(upstream, file);
  const k = lineCounts(fork, file);
  const m = lineCounts(merged, file);
  if (m === null) {
    const sides = [
      ...(u !== null && !same(u, b) ? ["upstream"] : []),
      ...(k !== null && !same(k, b) ? ["fork"] : []),
    ];
    if (sides.length) {
      report.push({
        file,
        note: `missing from the merged tree but changed by ${sides.join(" and ")}`,
        upstream: [],
        fork: [],
      });
    }
    continue;
  }
  const empty = new Map<string, number>();
  const bc = b ?? empty;
  const uc = u ?? empty;
  const kc = k ?? empty;
  const entry: Entry = { file, upstream: [], fork: [] };
  for (const line of new Set([...bc.keys(), ...uc.keys(), ...kc.keys(), ...m.keys()])) {
    const at = (counts: Map<string, number>) => counts.get(line) ?? 0;
    const du = at(uc) - at(bc);
    const dk = at(kc) - at(bc);
    const delta = at(m) - Math.max(0, at(bc) + du + dk);
    if (delta < 0) {
      if (du > 0) entry.upstream.push({ kind: "missing", line });
      if (dk > 0) entry.fork.push({ kind: "missing", line });
    } else if (delta > 0) {
      if (du < 0) entry.upstream.push({ kind: "not-removed", line });
      if (dk < 0) entry.fork.push({ kind: "not-removed", line });
    }
  }
  if (entry.upstream.length || entry.fork.length) report.push(entry);
}

if (jsonFile) NodeFS.writeFileSync(jsonFile, JSON.stringify(report, null, 1));
const out: string[] = [];
for (const entry of report) {
  out.push(entry.note ? `${entry.file}: ${entry.note}` : `${entry.file}:`);
  for (const side of ["upstream", "fork"] as const) {
    for (const issue of entry[side]) out.push(`  ${side} ${issue.kind}: ${issue.line}`);
  }
}
const count = (side: "upstream" | "fork") =>
  report.reduce((total, entry) => total + entry[side].length, 0);
out.push(
  `\n${report.length} files to review: ${count("upstream")} upstream lines, ${count("fork")} fork lines.\n`,
);
process.stdout.write(out.join("\n"));
