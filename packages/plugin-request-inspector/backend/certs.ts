// @effect-diagnostics nodeBuiltinImport:off - The inspector backend packs to one builtin-only CommonJS file with no Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const NSS_NICKNAME = "T3 Request Inspector CA";
const TRUST_FILE_NAME = "t3-request-inspector";

const SYSTEM_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/cert.pem",
] as const;

export interface CertFs {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string, encoding: "utf8") => string;
  readonly writeFileSync: (path: string, data: string) => void;
  readonly renameSync: (from: string, to: string) => void;
  readonly unlinkSync: (path: string) => void;
  readonly mkdirSync: (path: string, options: { recursive: true }) => void;
  readonly readdirSync: (path: string) => ReadonlyArray<string>;
}

export const nodeCertFs: CertFs = {
  existsSync: (path) => NodeFS.existsSync(path),
  readFileSync: (path, encoding) => NodeFS.readFileSync(path, encoding),
  writeFileSync: (path, data) => NodeFS.writeFileSync(path, data),
  renameSync: (from, to) => NodeFS.renameSync(from, to),
  unlinkSync: (path) => NodeFS.rmSync(path, { force: true }),
  mkdirSync: (path, options) => {
    NodeFS.mkdirSync(path, options);
  },
  readdirSync: (path) => NodeFS.readdirSync(path),
};

export interface RunResult {
  /** Exit code, or null when the process did not exit normally. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The command is not on PATH. */
  readonly notFound?: boolean;
}

export type CertRunner = (command: string, args: ReadonlyArray<string>) => Promise<RunResult>;

export const nodeCertRunner: CertRunner = (command, args) =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error?.code === "ENOENT") {
          resolve({ code: null, stdout: "", stderr: "", notFound: true });
          return;
        }
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ code, stdout, stderr });
      },
    );
  });

export interface CaFiles {
  /** All three public cert files exist. mitmproxy writes them on its first start. */
  readonly exists: boolean;
  readonly files: { readonly pem: string; readonly cer: string; readonly p12: string };
}

/** The public CA files in mitmproxy's confdir. The private key file is never listed. */
export function caFiles(confdir: string, fs: CertFs = nodeCertFs): CaFiles {
  const files = {
    pem: NodePath.join(confdir, "mitmproxy-ca-cert.pem"),
    cer: NodePath.join(confdir, "mitmproxy-ca-cert.cer"),
    p12: NodePath.join(confdir, "mitmproxy-ca-cert.p12"),
  };
  return {
    exists: fs.existsSync(files.pem) && fs.existsSync(files.cer) && fs.existsSync(files.p12),
    files,
  };
}

/**
 * Writes the first system bundle found plus the CA to `exports/ca-bundle.pem`. Without a
 * system bundle it returns undefined: a CA-only `SSL_CERT_FILE` would break every other host.
 */
export function combinedBundle(
  dataDir: string,
  caPemPath: string,
  fs: CertFs = nodeCertFs,
): string | undefined {
  const system = SYSTEM_BUNDLES.find((path) => fs.existsSync(path));
  if (system === undefined || !fs.existsSync(caPemPath)) return undefined;
  const systemPem = fs.readFileSync(system, "utf8");
  const caPem = fs.readFileSync(caPemPath, "utf8");
  const exportsDir = NodePath.join(dataDir, "exports");
  const target = NodePath.join(exportsDir, "ca-bundle.pem");
  const bundle = `${systemPem.trimEnd()}\n${caPem.trimEnd()}\n`;
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === bundle) return target;
  fs.mkdirSync(exportsDir, { recursive: true });
  // A shell may be reading the bundle through SSL_CERT_FILE; a rename swaps it whole.
  const temp = `${target}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, bundle);
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    fs.unlinkSync(temp);
    throw error;
  }
  return target;
}

export type TrustOs = "linux" | "darwin" | "win32";

export interface SystemTrustCommands {
  readonly os: TrustOs;
  readonly variant: string;
  readonly install: ReadonlyArray<string>;
  readonly remove: ReadonlyArray<string>;
}

const sh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const cmd = (value: string) => `"${value}"`;

/** The CA's SHA-1 thumbprint as uppercase hex, or undefined when `pem` is not a certificate. */
export function caThumbprint(pem: string): string | undefined {
  try {
    return new NodeCrypto.X509Certificate(pem).fingerprint.replaceAll(":", "");
  } catch {
    return undefined;
  }
}

/**
 * Commands for the user to run with root or an elevated prompt; the plugin never runs them.
 * Removal names this CA by its SHA-1 thumbprint, since every mitmproxy CA shares one name.
 */
export function systemTrustCommands(
  pemPath: string,
  cerPath: string,
  sha1: string,
): ReadonlyArray<SystemTrustCommands> {
  const pem = sh(pemPath);
  const debianTarget = `/usr/local/share/ca-certificates/${TRUST_FILE_NAME}.crt`;
  const fedoraTarget = `/etc/pki/ca-trust/source/anchors/${TRUST_FILE_NAME}.pem`;
  return [
    {
      os: "linux",
      variant: "Debian / Ubuntu",
      install: [`sudo cp ${pem} ${debianTarget}`, "sudo update-ca-certificates"],
      remove: [`sudo rm -f ${debianTarget}`, "sudo update-ca-certificates --fresh"],
    },
    {
      os: "linux",
      variant: "Fedora / RHEL",
      install: [`sudo cp ${pem} ${fedoraTarget}`, "sudo update-ca-trust"],
      remove: [`sudo rm -f ${fedoraTarget}`, "sudo update-ca-trust"],
    },
    {
      os: "linux",
      variant: "Arch",
      install: [`sudo trust anchor --store ${pem}`],
      remove: [`sudo trust anchor --remove ${pem}`],
    },
    {
      os: "darwin",
      variant: "macOS",
      install: [
        `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${pem}`,
      ],
      remove: [
        `sudo security remove-trusted-cert -d ${pem}`,
        `sudo security delete-certificate -Z ${sha1} /Library/Keychains/System.keychain`,
      ],
    },
    {
      os: "win32",
      variant: "Windows (elevated prompt)",
      install: [`certutil -addstore -f Root ${cmd(cerPath)}`],
      remove: [`certutil -delstore Root ${sha1}`],
    },
  ];
}

/** Per-runtime trust env. Node gets the CA alone because it appends to its built-in roots. */
export function clientEnv(
  caPath: string,
  bundlePath: string | undefined,
  proxyUrl: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = { NODE_EXTRA_CA_CERTS: caPath };
  if (bundlePath !== undefined) {
    for (const name of [
      "SSL_CERT_FILE",
      "REQUESTS_CA_BUNDLE",
      "CURL_CA_BUNDLE",
      "PIP_CERT",
      "GIT_SSL_CAINFO",
      "AWS_CA_BUNDLE",
      "DENO_CERT",
    ]) {
      env[name] = bundlePath;
    }
  }
  if (proxyUrl !== undefined) {
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.ALL_PROXY = proxyUrl;
  }
  return env;
}

export type NssDbKind = "chromium" | "firefox" | "firefox-snap";

export interface NssDb {
  /** The database directory; certutil receives it as `sql:<path>`. */
  readonly path: string;
  readonly kind: NssDbKind;
}

function listDir(fs: CertFs, path: string): ReadonlyArray<string> {
  try {
    return fs.readdirSync(path);
  } catch {
    return [];
  }
}

/** Chrome/Chromium's shared db and every Firefox profile that holds `cert9.db`. */
export function discoverNssDbs(home: string, fs: CertFs = nodeCertFs): ReadonlyArray<NssDb> {
  const dbs: Array<NssDb> = [];
  const chromium = NodePath.join(home, ".pki", "nssdb");
  if (fs.existsSync(NodePath.join(chromium, "cert9.db")))
    dbs.push({ path: chromium, kind: "chromium" });
  const firefoxRoots: ReadonlyArray<readonly [string, NssDbKind]> = [
    [NodePath.join(home, ".mozilla", "firefox"), "firefox"],
    // Firefox 147+ creates new profiles under XDG_CONFIG_HOME.
    [NodePath.join(home, ".config", "mozilla", "firefox"), "firefox"],
    [NodePath.join(home, "snap", "firefox", "common", ".mozilla", "firefox"), "firefox-snap"],
  ];
  for (const [root, kind] of firefoxRoots) {
    for (const entry of [...listDir(fs, root)].toSorted()) {
      const profile = NodePath.join(root, entry);
      if (fs.existsSync(NodePath.join(profile, "cert9.db"))) dbs.push({ path: profile, kind });
    }
  }
  return dbs;
}

export type NssFailure = "nss-unsupported" | "certutil-missing";

export class NssError extends Error {
  readonly reason: NssFailure;
  constructor(reason: NssFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface NssDeps {
  readonly fs?: CertFs;
  readonly run?: CertRunner;
  readonly platform: NodeJS.Platform;
  readonly home: string;
}

export interface NssStatus {
  readonly certutil: boolean;
  readonly dbs: ReadonlyArray<NssDb & { readonly installed: boolean }>;
}

export interface NssResult {
  readonly path: string;
  readonly ok: boolean;
  readonly detail?: string;
}

async function hasCertutil(run: CertRunner): Promise<boolean> {
  return !(await run("certutil", ["-H"])).notFound;
}

async function isInstalled(run: CertRunner, db: string): Promise<boolean> {
  const result = await run("certutil", ["-L", "-d", `sql:${db}`, "-n", NSS_NICKNAME]);
  return result.code === 0;
}

function failureDetail(result: RunResult): string {
  return (result.stderr.trim() || result.stdout.trim() || `certutil exited ${result.code}`).slice(
    0,
    500,
  );
}

/** Non-Linux reports no certutil and no dbs; the NSS operations refuse there. */
export async function nssStatus(deps: NssDeps): Promise<NssStatus> {
  const { fs = nodeCertFs, run = nodeCertRunner, platform } = deps;
  if (platform !== "linux") return { certutil: false, dbs: [] };
  const dbs = discoverNssDbs(deps.home, fs);
  if (!(await hasCertutil(run))) {
    return { certutil: false, dbs: dbs.map((db) => ({ ...db, installed: false })) };
  }
  const installed = await Promise.all(dbs.map((db) => isInstalled(run, db.path)));
  return { certutil: true, dbs: dbs.map((db, index) => ({ ...db, installed: installed[index]! })) };
}

async function nssPrepare(deps: NssDeps, requested: ReadonlyArray<string> | undefined) {
  const { fs = nodeCertFs, run = nodeCertRunner, platform } = deps;
  if (platform !== "linux") {
    throw new NssError(
      "nss-unsupported",
      "Browser certificate databases are managed on Linux only.",
    );
  }
  if (!(await hasCertutil(run))) {
    throw new NssError("certutil-missing", "certutil is not on PATH (install NSS tools).");
  }
  const discovered = new Set(discoverNssDbs(deps.home, fs).map((db) => db.path));
  // Only discovered dbs are touched, so a caller cannot point certutil at an arbitrary path.
  const targets = requested ?? [...discovered];
  return { run, targets, discovered };
}

/** Adds the CA to each db, replacing an earlier copy so a regenerated CA takes effect. */
export async function nssInstall(
  deps: NssDeps,
  caPemPath: string,
  dbs?: ReadonlyArray<string>,
): Promise<ReadonlyArray<NssResult>> {
  const { run, targets, discovered } = await nssPrepare(deps, dbs);
  const results: Array<NssResult> = [];
  for (const path of targets) {
    if (!discovered.has(path)) {
      results.push({ path, ok: false, detail: "Not a discovered NSS database." });
      continue;
    }
    if (await isInstalled(run, path)) {
      await run("certutil", ["-D", "-d", `sql:${path}`, "-n", NSS_NICKNAME]);
    }
    const added = await run("certutil", [
      "-A",
      "-d",
      `sql:${path}`,
      "-t",
      "C,,",
      "-n",
      NSS_NICKNAME,
      "-i",
      caPemPath,
    ]);
    results.push(
      added.code === 0 ? { path, ok: true } : { path, ok: false, detail: failureDetail(added) },
    );
  }
  return results;
}

/** Removing from a db that does not hold the CA succeeds. */
export async function nssUninstall(
  deps: NssDeps,
  dbs?: ReadonlyArray<string>,
): Promise<ReadonlyArray<NssResult>> {
  const { run, targets, discovered } = await nssPrepare(deps, dbs);
  const results: Array<NssResult> = [];
  for (const path of targets) {
    if (!discovered.has(path)) {
      results.push({ path, ok: false, detail: "Not a discovered NSS database." });
      continue;
    }
    if (!(await isInstalled(run, path))) {
      results.push({ path, ok: true });
      continue;
    }
    const removed = await run("certutil", ["-D", "-d", `sql:${path}`, "-n", NSS_NICKNAME]);
    results.push(
      removed.code === 0 ? { path, ok: true } : { path, ok: false, detail: failureDetail(removed) },
    );
  }
  return results;
}

export interface CertificateInfo extends CaFiles {
  readonly combinedBundle?: string;
  readonly systemTrust: ReadonlyArray<SystemTrustCommands>;
  readonly env: Record<string, string>;
  readonly nss: NssStatus;
}

/**
 * The `certificate_info` result. Call it after the CA exists; creating a missing CA (one
 * transient mitmdump start) is the caller's job. System trust lists only this host's OS.
 */
export async function certificateInfo(
  options: { readonly confdir: string; readonly dataDir: string; readonly proxyUrl?: string },
  deps: NssDeps,
): Promise<CertificateInfo> {
  const { fs = nodeCertFs, platform } = deps;
  const ca = caFiles(options.confdir, fs);
  const nss = await nssStatus(deps);
  if (!ca.exists) {
    return {
      ...ca,
      systemTrust: [],
      env: clientEnv(ca.files.pem, undefined, options.proxyUrl),
      nss,
    };
  }
  const bundle = combinedBundle(options.dataDir, ca.files.pem, fs);
  const sha1 = caThumbprint(fs.readFileSync(ca.files.pem, "utf8"));
  const systemTrust =
    sha1 === undefined
      ? []
      : systemTrustCommands(ca.files.pem, ca.files.cer, sha1).filter(
          (entry) => entry.os === platform,
        );
  return {
    ...ca,
    ...(bundle === undefined ? {} : { combinedBundle: bundle }),
    systemTrust,
    env: clientEnv(ca.files.pem, bundle, options.proxyUrl),
    nss,
  };
}
