// @effect-diagnostics nodeBuiltinImport:off -- Disposable Node-side Chromium trust fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vite-plus/test";
import { createRouteProof, environmentId } from "../../test/relayRouteProof/fixture.ts";

it("binds hosted and same-origin browser credentials to dedicated TLS origins", async () => {
  await using proof = await createRouteProof();
  const nss = NodePath.join(proof.directory, ".pki", "nssdb");
  NodeFS.mkdirSync(nss, { recursive: true });
  NodeChildProcess.execFileSync("certutil", ["-N", "--empty-password", "-d", `sql:${nss}`]);
  NodeChildProcess.execFileSync("certutil", [
    "-A",
    "-d",
    `sql:${nss}`,
    "-n",
    "T3 disposable route proof CA",
    "-t",
    "C,,",
    "-i",
    proof.caPath,
  ]);
  const browser = await chromium.launch({
    env: { ...process.env, HOME: proof.directory },
  });
  try {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    const { alpha, beta } = proof;
    await proof.connectOutbound();
    await page.goto(`${alpha.origin}/seed`);
    expect(
      await page.evaluate(() => ({
        dark: matchMedia("(prefers-color-scheme: dark)").matches,
        background: getComputedStyle(document.body).backgroundColor,
      })),
    ).toEqual({ dark: true, background: "rgb(17, 17, 17)" });

    await page.goto(`${beta.origin}/hosted`);
    await page.goto(`${alpha.origin}/first`);
    expect(proof.observed.find(({ path }) => path === "/first")?.cookie).toBe(
      "__Host-route-proof=cookie-a",
    );
    expect(await page.evaluate(() => document.cookie)).toBe("");

    const local = await page.evaluate(async () => {
      const response = await fetch("/ticket", { method: "POST" });
      const ticket = await response.text();
      const socket = new WebSocket(`wss://${location.host}/ws?ticket=${ticket}`);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("Same-origin upgrade refused"));
      });
      socket.close();
      const forward = await fetch("/outbound");
      const upload = await fetch("/attachment", { method: "POST", body: "attachment bytes" });
      const read = await fetch("/attachment");
      const abort = new AbortController();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("attachment"));
        },
      });
      const interrupted = fetch("/interrupt", {
        method: "POST",
        body,
        duplex: "half",
        signal: abort.signal,
      } as RequestInit & { duplex: "half" }).then(
        () => "unexpected resolution",
        (error: DOMException) => (error.name === "AbortError" ? "unknown" : error.name),
      );
      await fetch("/upload-started");
      abort.abort();
      return {
        ticketStatus: response.status,
        forward: await forward.text(),
        uploadStatus: upload.status,
        read: await read.text(),
        interrupted: await interrupted,
      };
    });
    expect(local).toEqual({
      ticketStatus: 200,
      forward: "outbound environment",
      uploadStatus: 201,
      read: "attachment bytes",
      interrupted: "unknown",
    });
    expect(await proof.uploadEnded).toBe("aborted");
    expect(proof.commits).toBe(1);
    expect(await page.evaluate(async () => (await fetch("/attachment")).text())).toBe(
      "attachment bytes",
    );

    proof.disconnectOutbound();
    expect(
      await page.evaluate(async () => ({
        forwarded: (await fetch("/outbound")).status,
        cachedOrigin: (await fetch("/attachment")).status,
      })),
    ).toEqual({ forwarded: 503, cachedOrigin: 200 });
    await proof.connectOutbound();

    await page.goto(`${beta.origin}/hosted`);
    const hosted = await page.evaluate(async (origin) => {
      const options: RequestInit = {
        headers: { authorization: "Bearer session-a" },
        credentials: "omit",
        redirect: "error",
      };
      const rejected = (path: string) =>
        fetch(origin + path, options).then(
          () => false,
          () => true,
        );
      const open = (path: string, ticket: string) =>
        new Promise<boolean>((resolve) => {
          const socket = new WebSocket(
            origin.replace("https:", "wss:") + path + "?ticket=" + ticket,
          );
          socket.onopen = () => {
            socket.close();
            resolve(true);
          };
          socket.onerror = () => resolve(false);
        });
      const issue = async () =>
        (await fetch(origin + "/ticket", { ...options, method: "POST" })).text();
      const ticket = await issue();
      return {
        allowed: await open("/ws", ticket),
        replay: await open("/ws", ticket),
        reconnect: await open("/ws", await issue()),
        upgradeRedirect: await open("/ws-redirect", await issue()),
        corsDenied: await rejected("/deny"),
        fetchRedirect: await rejected("/redirect"),
        readAttachment: await (await fetch(origin + "/attachment", options)).text(),
      };
    }, alpha.origin);
    expect(hosted).toEqual({
      allowed: true,
      replay: false,
      reconnect: true,
      upgradeRedirect: false,
      corsDenied: true,
      fetchRedirect: true,
      readAttachment: "attachment bytes",
    });
    expect(
      proof.observed.filter(({ path }) => path === "/deny").map(({ method }) => method),
    ).toEqual(["OPTIONS"]);
    expect(
      proof.observed
        .filter(
          ({ path, authorization }) => path === "/ticket" && authorization === "Bearer session-a",
        )
        .map(({ environment, cookie }) => [environment, cookie]),
    ).toEqual([
      ["a", undefined],
      ["a", undefined],
      ["a", undefined],
    ]);
    const upgrades = proof.observed.filter(({ method }) => method === "UPGRADE");
    expect(upgrades).toEqual([
      {
        environment: "a",
        method: "UPGRADE",
        path: "/ws?ticket=ticket-a-1",
        cookie: "__Host-route-proof=cookie-a",
      },
      { environment: "a", method: "UPGRADE", path: "/ws?ticket=ticket-a-2" },
      { environment: "a", method: "UPGRADE", path: "/ws?ticket=ticket-a-2" },
      { environment: "a", method: "UPGRADE", path: "/ws?ticket=ticket-a-3" },
      { environment: "a", method: "UPGRADE", path: "/ws-redirect?ticket=ticket-a-4" },
    ]);

    expect(proof.assignBinding(environmentId)).toBe(true);
    expect(proof.assignBinding("replacement")).toBe(false);
    proof.removeBinding();
    expect(proof.assignBinding("replacement")).toBe(false);
    expect(proof.assignBinding(environmentId)).toBe(false);
    const requestsBeforeRemoval = proof.observed.length;
    expect((await page.goto(`${alpha.origin}/first`))?.status()).toBe(410);
    expect(
      proof.observed.slice(requestsBeforeRemoval).filter(({ environment }) => environment === "a"),
    ).toEqual([]);
    expect(
      proof.observed
        .filter(({ environment }) => environment === "b")
        .every(
          ({ authorization, cookie, path, method }) =>
            authorization === undefined &&
            cookie === undefined &&
            path !== "/receive" &&
            method !== "UPGRADE",
        ),
    ).toBe(true);
  } finally {
    await browser.close();
  }
});
