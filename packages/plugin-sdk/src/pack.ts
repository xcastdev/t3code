// @effect-diagnostics nodeBuiltinImport:off - A build tool for plugin authors, outside any Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import type { PluginManifest } from "@t3tools/contracts";
import { decodePluginManifest } from "@t3tools/shared/pluginManifest";
import * as Result from "effect/Result";
import * as esbuild from "esbuild";
import JSZip from "jszip";

const MANIFEST_FILE = "t3-plugin.json";
const BACKEND_SOURCE = "backend/index.ts";
const MAX_PANEL_HTML_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const REFUSED_WARNINGS = new Set([
  "unsupported-require-call",
  "unsupported-dynamic-import",
  "direct-eval",
]);
const REFERENCE_PATTERN = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const ABSOLUTE_REFERENCE = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;

const fileExists = (path: string) =>
  NodeFSP.stat(path).then(
    (stat) => stat.isFile(),
    () => false,
  );

const buildFailureText = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "errors" in error) {
    const errors = (error as esbuild.BuildFailure).errors;
    if (errors.length > 0) return errors.map((message) => message.text).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
};

async function buildOrThrow(
  label: string,
  options: esbuild.BuildOptions & { write: false; metafile: true },
) {
  try {
    return await esbuild.build({ ...options, logLevel: "silent" });
  } catch (error) {
    throw new Error(`Could not bundle ${label}: ${buildFailureText(error)}`, { cause: error });
  }
}

async function readManifest(dir: string): Promise<{ text: string; manifest: PluginManifest }> {
  const text = await NodeFSP.readFile(NodePath.join(dir, MANIFEST_FILE), "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${MANIFEST_FILE} is not valid JSON.`, { cause: error });
  }
  const decoded = decodePluginManifest(json);
  if (Result.isFailure(decoded)) throw new Error(decoded.failure);
  return { text, manifest: decoded.success };
}

async function packPanel(dir: string, entry: string): Promise<string> {
  let html = await NodeFSP.readFile(NodePath.join(dir, entry), "utf8");
  for (const match of html.matchAll(REFERENCE_PATTERN)) {
    const reference = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (reference !== "" && !ABSOLUTE_REFERENCE.test(reference)) {
      throw new Error(
        `${entry} has a relative reference "${reference}". Panels must be self-contained; import code from the panel's .ts file instead.`,
      );
    }
  }

  const source = NodePath.join(dir, entry.replace(/\.html$/, ".ts"));
  if (await fileExists(source)) {
    const result = await buildOrThrow(entry, {
      entryPoints: [source],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify: true,
      write: false,
      metafile: true,
    });
    const code = (result.outputFiles[0]?.text ?? "").replaceAll("</script", "<\\/script");
    const script = `<script>${code}</script>`;
    const bodyEnd = html.toLowerCase().lastIndexOf("</body>");
    html =
      bodyEnd === -1
        ? `${html}${script}`
        : `${html.slice(0, bodyEnd)}${script}${html.slice(bodyEnd)}`;
  }

  if (Buffer.byteLength(html) > MAX_PANEL_HTML_BYTES) {
    throw new Error(`${entry} is larger than ${MAX_PANEL_HTML_BYTES} bytes after inlining.`);
  }
  return html;
}

const MODULE_BUILTINS = new Set(["module", "node:module"]);
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$\\]*`/.source;
const MEMBER_CHAIN = /(?:(?:\?\.|\.)[A-Za-z_$][\w$]*)*/.source;
const MODULE_ESCAPES = new Set(["require", "constructor", "parent", "children"]);
const SNIPPET_CHARS = 48;

const isAllowedBuiltin = (literal: string | undefined): boolean => {
  if (literal === undefined) return false;
  const specifier = literal.startsWith('"')
    ? (JSON.parse(literal) as string)
    : literal.slice(1, -1);
  return NodeModule.isBuiltin(specifier) && !MODULE_BUILTINS.has(specifier);
};

type Root = "require" | "module" | "process";

const loadEscape = (via: string, call: boolean, literal: string | undefined) => {
  if (!call) return `uses ${via} other than as a direct call`;
  if (literal === undefined) return `loads a computed path through ${via}`;
  return isAllowedBuiltin(literal)
    ? undefined
    : `loads ${literal} through ${via}, which is not an allowed Node builtin`;
};

/** Returns why one `root.chain` use reaches a module loader, or undefined when it loads nothing. */
const escapeOf = (
  root: Root,
  isTypeof: boolean,
  chain: ReadonlyArray<string>,
  next: string,
  literal: string | undefined,
): string | undefined => {
  const [first, second] = chain;
  const call = next === "(" || next === "?.(";
  if (next === "[" && first === undefined) return `indexes ${root}`;
  switch (root) {
    case "require":
      if (first === undefined)
        return isTypeof && !call ? undefined : loadEscape("require", call, literal);
      if (first === "resolve") return undefined;
      if (
        (first === "main" || first === "cache") &&
        !chain.some((name) => MODULE_ESCAPES.has(name))
      ) {
        return undefined;
      }
      return `uses require.${chain.join(".")}`;
    case "module":
      if (first === "exports") return undefined;
      if (first === undefined) return call ? "calls module" : undefined;
      return chain.some((name) => MODULE_ESCAPES.has(name))
        ? `uses module.${chain.join(".")}`
        : undefined;
    case "process":
      if (first === "dlopen") return "uses process.dlopen";
      if (first === "getBuiltinModule" && chain.length === 1) {
        return loadEscape("process.getBuiltinModule", call, literal);
      }
      if (first === "mainModule" && second === "require" && chain.length === 2) {
        return loadEscape("process.mainModule.require", call, literal);
      }
      if (first === "mainModule" && chain.some((name) => MODULE_ESCAPES.has(name))) {
        return `uses process.${chain.join(".")}`;
      }
      return undefined;
  }
};

/**
 * Proves the bundled backend loads only Node builtins by checking every member chain rooted at
 * the free `require`, `module` and `process`. esbuild renames those identifiers to a random tag,
 * so strings and comments never match. Aliasing a root (`const p = process`) is not followed.
 */
async function loaderEscapes(code: string): Promise<Array<string>> {
  const tag = `__t3_${NodeCrypto.randomBytes(8).toString("hex")}`;
  const marked = await esbuild.transform(code, {
    loader: "js",
    minifyWhitespace: true,
    minifySyntax: true,
    legalComments: "none",
    define: {
      require: `${tag}_require`,
      module: `${tag}_module`,
      process: `${tag}_process`,
      "globalThis.process": `${tag}_process`,
      "global.process": `${tag}_process`,
    },
  });
  const uses = new RegExp(
    `(typeof )?${tag}_(require|module|process)(${MEMBER_CHAIN})(\\?\\.\\(|\\(|\\[)?(?:(${STRING_LITERAL})\\))?`,
    "g",
  );
  const found = new Map<string, string>();
  for (const match of marked.code.matchAll(uses)) {
    const [text, isTypeof, root, chainText = "", next = "", literal] = match;
    const chain = chainText.split(/\??\./).filter((name) => name !== "");
    const reason = escapeOf(root as Root, isTypeof !== undefined, chain, next, literal);
    if (reason === undefined || found.has(reason)) continue;
    const snippet = marked.code
      .slice(
        Math.max(0, match.index - SNIPPET_CHARS / 2),
        match.index + text.length + SNIPPET_CHARS,
      )
      .replaceAll(`${tag}_`, "")
      .trim();
    found.set(reason, `${reason} (at \`${snippet}\`)`);
  }
  return [...found.values()];
}

async function packBackend(dir: string, entry: string): Promise<string> {
  const source = NodePath.join(dir, BACKEND_SOURCE);
  if (!(await fileExists(source))) {
    throw new Error(`The manifest declares a backend but ${BACKEND_SOURCE} does not exist.`);
  }
  const result = await buildOrThrow(BACKEND_SOURCE, {
    absWorkingDir: dir,
    entryPoints: [source],
    outfile: NodePath.join(dir, entry),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    // Lowers import() to require() so the bundle scan below sees every load.
    supported: { "dynamic-import": false },
    loader: { ".py": "text", ".txt": "text" },
    write: false,
    metafile: true,
  });

  const refused = result.warnings.filter((warning) => REFUSED_WARNINGS.has(warning.id));
  if (refused.length > 0) {
    throw new Error(
      `${BACKEND_SOURCE} cannot be bundled into one file: ${refused
        .map((warning) => `${warning.id}: ${warning.text}`)
        .join("; ")}`,
    );
  }
  const nativeAddon = Object.keys(result.metafile.inputs).find((input) => input.endsWith(".node"));
  if (nativeAddon !== undefined) {
    throw new Error(
      `${BACKEND_SOURCE} imports the native addon ${nativeAddon}. Ship native code as an external prerequisite.`,
    );
  }
  for (const output of Object.values(result.metafile.outputs)) {
    const external = output.imports.find(
      (imported) => imported.external === true && !NodeModule.isBuiltin(imported.path),
    );
    if (external !== undefined) {
      throw new Error(
        `${BACKEND_SOURCE} imports "${external.path}", which is not bundled. A backend may import only Node builtins at runtime.`,
      );
    }
  }
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error(`Bundling ${BACKEND_SOURCE} produced no output.`);
  const escapes = await loaderEscapes(output.text);
  if (escapes.length > 0) {
    throw new Error(
      `${BACKEND_SOURCE} may load only Node builtins, but its bundle ${escapes.join("; ")}.`,
    );
  }
  return output.text;
}

/**
 * Packs the plugin source directory `dir` into a `.t3plugin` archive at `outFile`.
 * The archive holds only the manifest, the self-contained panel HTML, and the bundled backend.
 */
export async function packPlugin(dir: string, outFile: string): Promise<void> {
  const { text, manifest } = await readManifest(dir);
  const zip = new JSZip();
  zip.file(MANIFEST_FILE, text);
  for (const panel of manifest.ui?.panels ?? []) {
    zip.file(panel.entry, await packPanel(dir, panel.entry));
  }
  if (manifest.backend !== undefined) {
    zip.file(manifest.backend.entry, await packBackend(dir, manifest.backend.entry));
  }
  const archive = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`The packed plugin is larger than ${MAX_ARCHIVE_BYTES} bytes.`);
  }
  await NodeFSP.mkdir(NodePath.dirname(outFile), { recursive: true });
  await NodeFSP.writeFile(outFile, archive);
}
