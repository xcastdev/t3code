import { describe, expect, it } from "vite-plus/test";

import {
  type CallerContext,
  callerLink,
  type ProxyLink,
  type ProxyRef,
  resolveProxy,
} from "./proxyResolution.ts";

const context: CallerContext = {
  threadId: "t-child",
  projectId: "p1",
  parentThreadId: "t-parent",
  rootThreadId: "t-root",
};
const empty: CallerContext = {
  threadId: null,
  projectId: null,
  parentThreadId: null,
  rootThreadId: null,
};
const proxies: ProxyRef[] = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4", deletedAt: 5 }];

const link = (kind: ProxyLink["kind"], id: string, proxyId: string, linkedAt = 0): ProxyLink => ({
  kind,
  id,
  proxyId,
  linkedAt,
});

describe("resolveProxy", () => {
  it.each([
    {
      name: "explicit beats a link",
      explicit: "2",
      links: [link("thread", "t-child", "1")],
      ctx: context,
      expected: { proxyId: "2", via: "explicit" },
    },
    {
      name: "explicit may name a deleted proxy",
      explicit: "4",
      links: [],
      ctx: empty,
      expected: { proxyId: "4", via: "explicit" },
    },
    {
      name: "an unknown explicit id is not found",
      explicit: "9",
      links: [],
      ctx: context,
      expected: { refusal: "not-found", proxyId: "9" },
    },
    {
      name: "thread beats project",
      explicit: null,
      links: [link("project", "p1", "1"), link("thread", "t-child", "2")],
      ctx: context,
      expected: { proxyId: "2", via: "thread" },
    },
    {
      name: "a thread linked to several proxies defaults to the newest link",
      explicit: undefined,
      links: [link("thread", "t-child", "1", 5), link("thread", "t-child", "2", 9)],
      ctx: context,
      expected: { proxyId: "2", via: "thread" },
    },
    {
      name: "the newest live link wins when the newest link is to a deleted proxy",
      explicit: undefined,
      links: [
        link("project", "p1", "4", 9),
        link("project", "p1", "3", 7),
        link("project", "p1", "1", 2),
      ],
      ctx: context,
      expected: { proxyId: "3", via: "project" },
    },
    {
      name: "project when the thread has no link",
      explicit: undefined,
      links: [link("project", "p1", "3")],
      ctx: context,
      expected: { proxyId: "3", via: "project" },
    },
    {
      name: "a link to a deleted proxy is skipped",
      explicit: undefined,
      links: [link("thread", "t-child", "4"), link("project", "p1", "1")],
      ctx: context,
      expected: { proxyId: "1", via: "project" },
    },
    {
      name: "no default lists the parent-linked proxy first, then the root, then the rest",
      explicit: undefined,
      links: [
        link("thread", "t-root", "1"),
        link("thread", "t-parent", "2", 1),
        link("thread", "t-parent", "3", 2),
      ],
      ctx: context,
      expected: {
        refusal: "no-default-proxy",
        candidates: [
          { proxyId: "3", link: "parentThread" },
          { proxyId: "1", link: "rootThread" },
          { proxyId: "2", link: null },
        ],
      },
    },
    {
      name: "no context lists every live proxy",
      explicit: undefined,
      links: [link("thread", "t-child", "1")],
      ctx: empty,
      expected: {
        refusal: "no-default-proxy",
        candidates: [
          { proxyId: "1", link: null },
          { proxyId: "2", link: null },
          { proxyId: "3", link: null },
        ],
      },
    },
  ])("$name", ({ explicit, links, ctx, expected }) => {
    expect(resolveProxy({ explicit, links, context: ctx, proxies })).toEqual(expected);
  });
});

describe("callerLink", () => {
  const links = [
    link("thread", "t-root", "1"),
    link("thread", "t-parent", "2"),
    link("project", "p1", "2"),
    link("thread", "t-child", "3"),
  ];

  it.each([
    { proxyId: "3", expected: "thread" },
    { proxyId: "2", expected: "project" },
    { proxyId: "1", expected: "rootThread" },
    { proxyId: "4", expected: null },
  ])("$proxyId → $expected", ({ proxyId, expected }) => {
    expect(callerLink(proxyId, links, context)).toBe(expected);
  });

  it("reports parentThread when only the parent links it", () => {
    expect(callerLink("2", [link("thread", "t-parent", "2")], context)).toBe("parentThread");
  });
});
