import { describe, expect, it } from "vite-plus/test";

import {
  caFiles,
  certificateInfo,
  type CertFs,
  type CertRunner,
  clientEnv,
  combinedBundle,
  discoverNssDbs,
  NSS_NICKNAME,
  nssInstall,
  nssStatus,
  nssUninstall,
  type RunResult,
  systemTrustCommands,
} from "./certs.ts";

const HOME = "/home/u";
const CONFDIR = "/data/mitmproxy";
const CA_PEM = `${CONFDIR}/mitmproxy-ca-cert.pem`;
const CHROMIUM = `${HOME}/.pki/nssdb`;
const FIREFOX = `${HOME}/.mozilla/firefox/abc.default-release`;
const FIREFOX_XDG = `${HOME}/.config/mozilla/firefox/xdg.default`;
const SNAP = `${HOME}/snap/firefox/common/.mozilla/firefox/snp.default`;
// A self-signed CN=mitmproxy cert; its SHA-1 thumbprint is CA_SHA1.
const CA_CERT = `-----BEGIN CERTIFICATE-----
MIIBfjCCASWgAwIBAgIUcNM4m2infzMj77CkjmgUmRiAZOUwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbWl0bXByb3h5MCAXDTI2MTEwMzIxMTA1NVoYDzIxMjYxMDEw
MjExMDU1WjAUMRIwEAYDVQQDDAltaXRtcHJveHkwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAS02TcZ/X4fSBO4PcVLY7I2Su8Uvrpp3H2aMfh+XPBga+xo8bQ8sYnV
+1m0NUI3rTCebfaA3omy0GyQUdB8YqdUo1MwUTAdBgNVHQ4EFgQU5iVz4vFFehP6
SObqlHaWtOPnZzMwHwYDVR0jBBgwFoAU5iVz4vFFehP6SObqlHaWtOPnZzMwDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiBDPGQ04GTAsn49I++9CTwx
1b8wdGzEteoN4rGwzPu5fAIgRnCS0M5n5eo7QW4/Tot6QtVqAJnzpGBxB5MUY/HD
SPc=
-----END CERTIFICATE-----
`;
const CA_SHA1 = "0EA942CDBED796D33378F806E70FF4A5E3C17E47";

function fakeFs(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const writes: Array<string> = [];
  const fs: CertFs = {
    existsSync: (path) => files.has(path),
    readFileSync: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT ${path}`);
      return value;
    },
    writeFileSync: (path, data) => {
      writes.push(path);
      files.set(path, data);
    },
    renameSync: (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, value);
    },
    unlinkSync: (path) => {
      files.delete(path);
    },
    mkdirSync: () => {},
    readdirSync: (dir) => {
      const names = new Set<string>();
      for (const path of files.keys()) {
        if (path.startsWith(`${dir}/`)) names.add(path.slice(dir.length + 1).split("/")[0]!);
      }
      if (names.size === 0) throw new Error(`ENOENT ${dir}`);
      return [...names];
    },
  };
  return { fs, files, writes };
}

const mitmConfdir = {
  [`${CONFDIR}/mitmproxy-ca.pem`]: "PRIVATE KEY",
  [`${CONFDIR}/mitmproxy-ca.p12`]: "PRIVATE P12",
  [CA_PEM]: "CA PEM",
  [`${CONFDIR}/mitmproxy-ca-cert.cer`]: "CA CER",
  [`${CONFDIR}/mitmproxy-ca-cert.p12`]: "CA P12",
};

const browserDbs = {
  [`${CHROMIUM}/cert9.db`]: "",
  [`${FIREFOX}/cert9.db`]: "",
  [`${HOME}/.mozilla/firefox/profiles.ini`]: "",
  [`${HOME}/.mozilla/firefox/no-db.profile/prefs.js`]: "",
  [`${FIREFOX_XDG}/cert9.db`]: "",
  [`${SNAP}/cert9.db`]: "",
};

/** certutil where `installedIn` dbs hold the CA; `-A` and `-D` update that set. */
function fakeCertutil(options: {
  missing?: boolean;
  installedIn?: Array<string>;
  failAdd?: boolean;
}) {
  const calls: Array<ReadonlyArray<string>> = [];
  const installed = new Set(options.installedIn ?? []);
  const ok: RunResult = { code: 0, stdout: "", stderr: "" };
  const run: CertRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (options.missing) return { code: null, stdout: "", stderr: "", notFound: true };
    const db = args[args.indexOf("-d") + 1]?.replace(/^sql:/, "") ?? "";
    switch (args[0]) {
      case "-L":
        return installed.has(db) ? ok : { code: 255, stdout: "", stderr: "not found" };
      case "-A":
        if (options.failAdd) return { code: 255, stdout: "", stderr: "SEC_ERROR_READ_ONLY" };
        installed.add(db);
        return ok;
      case "-D":
        installed.delete(db);
        return ok;
      default:
        return { code: 1, stdout: "usage", stderr: "" };
    }
  };
  return { run, calls, installed };
}

describe("caFiles", () => {
  it("lists only the public cert files and reports whether mitmproxy wrote them", () => {
    const present = caFiles(CONFDIR, fakeFs(mitmConfdir).fs);
    expect(present).toEqual({
      exists: true,
      files: {
        pem: CA_PEM,
        cer: `${CONFDIR}/mitmproxy-ca-cert.cer`,
        p12: `${CONFDIR}/mitmproxy-ca-cert.p12`,
      },
    });
    expect(JSON.stringify(present)).not.toMatch(/mitmproxy-ca\.(pem|p12)/);
    expect(caFiles(CONFDIR, fakeFs({}).fs).exists).toBe(false);
  });
});

describe("combinedBundle", () => {
  it.each([
    ["Debian", "/etc/ssl/certs/ca-certificates.crt"],
    ["Fedora", "/etc/pki/tls/certs/ca-bundle.crt"],
    ["macOS", "/etc/ssl/cert.pem"],
  ])("appends the CA to the %s system bundle", (_name, systemPath) => {
    const { fs, files } = fakeFs({ ...mitmConfdir, [systemPath]: "SYSTEM\n" });
    expect(combinedBundle("/data", CA_PEM, fs)).toBe("/data/exports/ca-bundle.pem");
    expect(files.get("/data/exports/ca-bundle.pem")).toBe("SYSTEM\nCA PEM\n");
  });

  it("replaces the bundle through a temp file, and only when its content changed", () => {
    const { fs, files, writes } = fakeFs({
      ...mitmConfdir,
      "/etc/ssl/cert.pem": "SYSTEM",
    });
    combinedBundle("/data", CA_PEM, fs);
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toBe("/data/exports/ca-bundle.pem");
    expect([...files.keys()].filter((path) => path.startsWith("/data/exports/"))).toEqual([
      "/data/exports/ca-bundle.pem",
    ]);
    combinedBundle("/data", CA_PEM, fs);
    expect(writes).toHaveLength(1);
    files.set("/etc/ssl/cert.pem", "UPDATED");
    combinedBundle("/data", CA_PEM, fs);
    expect(writes).toHaveLength(2);
    expect(files.get("/data/exports/ca-bundle.pem")).toBe("UPDATED\nCA PEM\n");

    files.set("/etc/ssl/cert.pem", "FAILS");
    const failing: CertFs = {
      ...fs,
      renameSync: () => {
        throw new Error("EPERM");
      },
    };
    expect(() => combinedBundle("/data", CA_PEM, failing)).toThrow("EPERM");
    expect([...files.keys()].filter((path) => path.startsWith("/data/exports/"))).toEqual([
      "/data/exports/ca-bundle.pem",
    ]);
  });

  it("prefers the first bundle and writes nothing without one", () => {
    const both = fakeFs({
      ...mitmConfdir,
      "/etc/ssl/certs/ca-certificates.crt": "DEBIAN",
      "/etc/ssl/cert.pem": "OTHER",
    });
    combinedBundle("/data", CA_PEM, both.fs);
    expect(both.files.get("/data/exports/ca-bundle.pem")).toBe("DEBIAN\nCA PEM\n");

    const none = fakeFs(mitmConfdir);
    expect(combinedBundle("/data", CA_PEM, none.fs)).toBeUndefined();
    expect(none.files.has("/data/exports/ca-bundle.pem")).toBe(false);
  });
});

describe("systemTrustCommands", () => {
  it("gives install and remove commands per OS with quoted paths", () => {
    const pem = "/home/o'k/ca.pem";
    expect(systemTrustCommands(pem, "C:\\T3 Data\\ca.cer", CA_SHA1)).toEqual([
      {
        os: "linux",
        variant: "Debian / Ubuntu",
        install: [
          `sudo cp '/home/o'\\''k/ca.pem' /usr/local/share/ca-certificates/t3-request-inspector.crt`,
          "sudo update-ca-certificates",
        ],
        remove: [
          "sudo rm -f /usr/local/share/ca-certificates/t3-request-inspector.crt",
          "sudo update-ca-certificates --fresh",
        ],
      },
      {
        os: "linux",
        variant: "Fedora / RHEL",
        install: [
          `sudo cp '/home/o'\\''k/ca.pem' /etc/pki/ca-trust/source/anchors/t3-request-inspector.pem`,
          "sudo update-ca-trust",
        ],
        remove: [
          "sudo rm -f /etc/pki/ca-trust/source/anchors/t3-request-inspector.pem",
          "sudo update-ca-trust",
        ],
      },
      {
        os: "linux",
        variant: "Arch",
        install: [`sudo trust anchor --store '/home/o'\\''k/ca.pem'`],
        remove: [`sudo trust anchor --remove '/home/o'\\''k/ca.pem'`],
      },
      {
        os: "darwin",
        variant: "macOS",
        install: [
          `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain '/home/o'\\''k/ca.pem'`,
        ],
        remove: [
          `sudo security remove-trusted-cert -d '/home/o'\\''k/ca.pem'`,
          `sudo security delete-certificate -Z ${CA_SHA1} /Library/Keychains/System.keychain`,
        ],
      },
      {
        os: "win32",
        variant: "Windows (elevated prompt)",
        install: [`certutil -addstore -f Root "C:\\T3 Data\\ca.cer"`],
        remove: [`certutil -delstore Root ${CA_SHA1}`],
      },
    ]);
  });
});

describe("clientEnv", () => {
  it("points Node at the CA alone and other runtimes at the bundle", () => {
    expect(clientEnv("/ca.pem", "/bundle.pem", "http://127.0.0.1:8080")).toEqual({
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      SSL_CERT_FILE: "/bundle.pem",
      REQUESTS_CA_BUNDLE: "/bundle.pem",
      CURL_CA_BUNDLE: "/bundle.pem",
      PIP_CERT: "/bundle.pem",
      GIT_SSL_CAINFO: "/bundle.pem",
      AWS_CA_BUNDLE: "/bundle.pem",
      DENO_CERT: "/bundle.pem",
      HTTP_PROXY: "http://127.0.0.1:8080",
      HTTPS_PROXY: "http://127.0.0.1:8080",
      ALL_PROXY: "http://127.0.0.1:8080",
    });
    expect(clientEnv("/ca.pem", undefined, undefined)).toEqual({ NODE_EXTRA_CA_CERTS: "/ca.pem" });
  });
});

describe("NSS", () => {
  it("discovers Chromium and every Firefox profile with cert9.db, snap included", () => {
    expect(discoverNssDbs(HOME, fakeFs(browserDbs).fs)).toEqual([
      { path: CHROMIUM, kind: "chromium" },
      { path: FIREFOX, kind: "firefox" },
      { path: FIREFOX_XDG, kind: "firefox" },
      { path: SNAP, kind: "firefox-snap" },
    ]);
    expect(discoverNssDbs(HOME, fakeFs({}).fs)).toEqual([]);
  });

  it("reports status per db, and certutil: false when it is missing", async () => {
    const { fs } = fakeFs(browserDbs);
    const present = fakeCertutil({ installedIn: [FIREFOX] });
    expect(await nssStatus({ fs, run: present.run, platform: "linux", home: HOME })).toEqual({
      certutil: true,
      dbs: [
        { path: CHROMIUM, kind: "chromium", installed: false },
        { path: FIREFOX, kind: "firefox", installed: true },
        { path: FIREFOX_XDG, kind: "firefox", installed: false },
        { path: SNAP, kind: "firefox-snap", installed: false },
      ],
    });
    const missing = fakeCertutil({ missing: true });
    const status = await nssStatus({ fs, run: missing.run, platform: "linux", home: HOME });
    expect(status.certutil).toBe(false);
    expect(status.dbs.every((db) => !db.installed)).toBe(true);
  });

  it("installs with the exact argv and replaces an earlier copy", async () => {
    const { fs } = fakeFs(browserDbs);
    const certutil = fakeCertutil({ installedIn: [FIREFOX] });
    const deps = { fs, run: certutil.run, platform: "linux" as const, home: HOME };
    const results = await nssInstall(deps, CA_PEM, [CHROMIUM, FIREFOX, "/etc/evil"]);
    expect(results).toEqual([
      { path: CHROMIUM, ok: true },
      { path: FIREFOX, ok: true },
      { path: "/etc/evil", ok: false, detail: "Not a discovered NSS database." },
    ]);
    const add = (db: string) => [
      "certutil",
      "-A",
      "-d",
      `sql:${db}`,
      "-t",
      "C,,",
      "-n",
      NSS_NICKNAME,
      "-i",
      CA_PEM,
    ];
    expect(certutil.calls.filter((call) => call[1] === "-A" || call[1] === "-D")).toEqual([
      add(CHROMIUM),
      ["certutil", "-D", "-d", `sql:${FIREFOX}`, "-n", NSS_NICKNAME],
      add(FIREFOX),
    ]);
    expect(certutil.calls.some((call) => call.includes("sql:/etc/evil"))).toBe(false);
  });

  it("defaults to every discovered db and reports certutil failures", async () => {
    const { fs } = fakeFs(browserDbs);
    const certutil = fakeCertutil({ failAdd: true });
    const results = await nssInstall(
      { fs, run: certutil.run, platform: "linux", home: HOME },
      CA_PEM,
    );
    expect(results.map((result) => result.path)).toEqual([CHROMIUM, FIREFOX, FIREFOX_XDG, SNAP]);
    expect(results[0]).toEqual({ path: CHROMIUM, ok: false, detail: "SEC_ERROR_READ_ONLY" });
  });

  it("uninstalls with certutil -D only where the CA is present", async () => {
    const { fs } = fakeFs(browserDbs);
    const certutil = fakeCertutil({ installedIn: [SNAP] });
    const deps = { fs, run: certutil.run, platform: "linux" as const, home: HOME };
    expect(await nssUninstall(deps, [SNAP, CHROMIUM])).toEqual([
      { path: SNAP, ok: true },
      { path: CHROMIUM, ok: true },
    ]);
    expect(certutil.calls.filter((call) => call[1] === "-D")).toEqual([
      ["certutil", "-D", "-d", `sql:${SNAP}`, "-n", NSS_NICKNAME],
    ]);
    expect(certutil.installed.size).toBe(0);
  });

  it.each([
    ["darwin", "nss-unsupported"],
    ["win32", "nss-unsupported"],
  ] as const)("refuses NSS changes on %s", async (platform, reason) => {
    const { fs } = fakeFs(browserDbs);
    const certutil = fakeCertutil({});
    const deps = { fs, run: certutil.run, platform, home: HOME };
    await expect(nssInstall(deps, CA_PEM)).rejects.toMatchObject({ reason });
    await expect(nssUninstall(deps)).rejects.toMatchObject({ reason });
    expect(await nssStatus(deps)).toEqual({ certutil: false, dbs: [] });
    expect(certutil.calls).toEqual([]);
  });

  it("refuses NSS changes when certutil is missing", async () => {
    const { fs } = fakeFs(browserDbs);
    const deps = {
      fs,
      run: fakeCertutil({ missing: true }).run,
      platform: "linux" as const,
      home: HOME,
    };
    await expect(nssInstall(deps, CA_PEM)).rejects.toMatchObject({ reason: "certutil-missing" });
  });
});

describe("certificateInfo", () => {
  it("assembles the certificate_info result for this host, removing the CA by its own thumbprint", async () => {
    const { fs } = fakeFs({ ...mitmConfdir, [CA_PEM]: CA_CERT, "/etc/ssl/cert.pem": "SYSTEM" });
    const certutil = fakeCertutil({});
    const info = await certificateInfo(
      { confdir: CONFDIR, dataDir: "/data", proxyUrl: "http://127.0.0.1:8080" },
      { fs, run: certutil.run, platform: "darwin", home: HOME },
    );
    expect(info.exists).toBe(true);
    expect(info.combinedBundle).toBe("/data/exports/ca-bundle.pem");
    expect(info.systemTrust.map((entry) => entry.variant)).toEqual(["macOS"]);
    expect(info.systemTrust[0]?.remove).toContain(
      `sudo security delete-certificate -Z ${CA_SHA1} /Library/Keychains/System.keychain`,
    );
    expect(info.env.SSL_CERT_FILE).toBe("/data/exports/ca-bundle.pem");
    expect(info.nss).toEqual({ certutil: false, dbs: [] });
  });

  it("reports exists: false and writes no bundle before mitmproxy made the CA", async () => {
    const { fs, files } = fakeFs({ "/etc/ssl/cert.pem": "SYSTEM" });
    const info = await certificateInfo(
      { confdir: CONFDIR, dataDir: "/data" },
      { fs, run: fakeCertutil({}).run, platform: "linux", home: HOME },
    );
    expect(info).toMatchObject({ exists: false, systemTrust: [] });
    expect(info.combinedBundle).toBeUndefined();
    expect(files.has("/data/exports/ca-bundle.pem")).toBe(false);
  });
});
