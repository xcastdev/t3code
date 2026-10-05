import type { NotificationResponse } from "expo-notifications";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

import {
  extractAgentNotificationDeepLink,
  routeAgentNotificationResponseOnce,
} from "./notificationPayload";

function responseWithData(data: Record<string, unknown>, identifier = "notification-1") {
  return {
    notification: {
      request: {
        identifier,
        content: {
          data,
        },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("consumeLastAgentNotificationResponse", () => {
  it("reports which initial-response operation failed", async () => {
    const cause = new Error("notification lookup unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.reject(cause),
      clearLastResponse: () => Promise.resolve(),
      handleResponse: vi.fn(),
    });

    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NotificationNavigationError",
        operation: "read",
      }),
    );
  });

  it("routes a response before reporting a clear failure", async () => {
    const cause = new Error("notification clear unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({}, "notification-clear") as NotificationResponse;
    const handleResponse = vi.fn();

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse: () => Promise.reject(cause),
      handleResponse,
    });

    expect(handleResponse).toHaveBeenCalledWith(response);
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NotificationNavigationError",
        operation: "clear",
        notificationId: "notification-clear",
      }),
    );
  });

  it("reports routing failures before clearing the response", async () => {
    const cause = new Error("notification routing unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({}, "notification-route") as NotificationResponse;
    const clearLastResponse = vi.fn(() => Promise.resolve());

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse,
      handleResponse: () => {
        throw cause;
      },
    });

    expect(clearLastResponse).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NotificationNavigationError",
        operation: "route",
        notificationId: "notification-route",
      }),
    );
  });
});

describe("extractAgentNotificationDeepLink", () => {
  it("uses explicit deep links from APNs payload data", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/threads/env/thread",
          environmentId: "ignored",
          threadId: "ignored",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("normalizes explicit thread deep links from APNs payload data", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/threads/env%201/thread%2F2",
        }),
      ),
    ).toBe("/threads/env%201/thread%2F2");
  });

  it("falls back to the thread route from environment and thread ids", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          environmentId: "env 1",
          threadId: "thread/2",
        }),
      ),
    ).toBe("/threads/env%201/thread%2F2");
  });

  it("falls back to ids when explicit deep link is not an agent thread route", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/",
          environmentId: "env",
          threadId: "thread",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("ignores malformed or external links", () => {
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "https://example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/settings" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "//example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/threads/env/thread?x=1" })),
    ).toBeNull();
    expect(extractAgentNotificationDeepLink({})).toBeNull();
  });
});

describe("routeAgentNotificationResponseOnce", () => {
  it("does not navigate twice when the initial and listener responses refer to one notification", () => {
    const handledResponseIds = new Set<string>();
    const navigations: Array<string> = [];
    const response = responseWithData({
      environmentId: "env",
      threadId: "thread",
    });

    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate: (deepLink) => navigations.push(deepLink),
    });
    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate: (deepLink) => navigations.push(deepLink),
    });

    expect(navigations).toEqual(["/threads/env/thread"]);
  });
});

describe("project work notification hints", () => {
  function workData(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      environmentId: "work-env",
      threadId: "obsolete-thread",
      deepLink: "/threads/foreign-env/obsolete-thread",
      projectWork: {
        projectId: "work-project",
        taskId: "work-task",
        state: "blocked",
        reason: "approval-required",
        revision: 7,
      },
      ...overrides,
    };
  }

  it("opens the durable task instead of an obsolete provider thread", () => {
    expect(extractAgentNotificationDeepLink(responseWithData(workData()))).toBe(
      "/work/work-env/work-project/tasks/work-task",
    );
  });

  it("encodes each owner and task segment without changing identity", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData(
          workData({
            environmentId: "env/remote %雪",
            projectWork: {
              projectId: "project/?#%",
              taskId: "task/with space💡",
              state: "ready",
              revision: 0,
            },
          }),
        ),
      ),
    ).toBe(
      "/work/env%2Fremote%20%25%E9%9B%AA/project%2F%3F%23%25/tasks/task%2Fwith%20space%F0%9F%92%A1",
    );
  });

  it("uses metadata ownership even when an explicit work link names another target", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData(
          workData({ deepLink: "/work/foreign-env/foreign-project/tasks/foreign-task" }),
        ),
      ),
    ).toBe("/work/work-env/work-project/tasks/work-task");
  });

  it("requires no provider thread or embedded deep link for a task hint", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData(workData({ threadId: undefined, deepLink: undefined })),
      ),
    ).toBe("/work/work-env/work-project/tasks/work-task");
  });

  it.each([0, Number.MAX_SAFE_INTEGER])("accepts the bounded revision %s as a hint", (revision) => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData(
          workData({
            projectWork: { projectId: "project", taskId: "task", state: "completed", revision },
          }),
        ),
      ),
    ).toBe("/work/work-env/project/tasks/task");
  });

  it.each([
    ["absent version", { schemaVersion: undefined }],
    ["future version", { schemaVersion: 2 }],
    ["string version", { schemaVersion: "1" }],
    ["absent environment", { environmentId: undefined }],
    ["empty environment", { environmentId: "" }],
    ["whitespace environment", { environmentId: "  " }],
    ["padded environment", { environmentId: " work-env " }],
    ["non-string environment", { environmentId: 1 }],
    ["oversized environment", { environmentId: "e".repeat(257) }],
    ["malformed environment unicode", { environmentId: "env\ud800" }],
    ["null context", { projectWork: null }],
    ["undefined context", { projectWork: undefined }],
    ["array context", { projectWork: [] }],
    ["string context", { projectWork: "work-task" }],
    ["empty context", { projectWork: {} }],
  ])("rejects %s without falling back to the obsolete thread", (_name, overrides) => {
    expect(extractAgentNotificationDeepLink(responseWithData(workData(overrides)))).toBeNull();
  });

  it.each([
    ["missing project", { projectId: undefined }],
    ["empty project", { projectId: "" }],
    ["padded project", { projectId: " work-project " }],
    ["non-string project", { projectId: 1 }],
    ["oversized project", { projectId: "p".repeat(257) }],
    ["malformed project unicode", { projectId: "project\ud800" }],
    ["missing task", { taskId: undefined }],
    ["empty task", { taskId: "" }],
    ["whitespace task", { taskId: "  " }],
    ["padded task", { taskId: " work-task " }],
    ["non-string task", { taskId: 1 }],
    ["oversized task", { taskId: "t".repeat(257) }],
    ["malformed task unicode", { taskId: "task\ud800" }],
    ["missing state", { state: undefined }],
    ["future state", { state: "future-state" }],
    ["non-string state", { state: 1 }],
    ["future reason", { reason: "future-reason" }],
    ["null reason", { reason: null }],
    ["non-string reason", { reason: 1 }],
    ["missing revision", { revision: undefined }],
    ["negative revision", { revision: -1 }],
    ["fractional revision", { revision: 1.5 }],
    ["unsafe revision", { revision: Number.MAX_SAFE_INTEGER + 1 }],
    ["infinite revision", { revision: Infinity }],
    ["NaN revision", { revision: NaN }],
    ["string revision", { revision: "7" }],
  ])("rejects %s in work context without following any embedded link", (_name, overrides) => {
    const data = workData();
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({ ...data, projectWork: { ...data.projectWork, ...overrides } }),
      ),
    ).toBeNull();
  });

  it("accepts identities at the bound without truncation", () => {
    const environmentId = "e".repeat(256);
    const projectId = "p".repeat(256);
    const taskId = "t".repeat(256);
    expect(
      extractAgentNotificationDeepLink(
        responseWithData(
          workData({
            environmentId,
            projectWork: { projectId, taskId, state: "ready", revision: 1 },
          }),
        ),
      ),
    ).toBe(`/work/${environmentId}/${projectId}/tasks/${taskId}`);
  });

  it("does not trust a bare work deep link as durable context", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({ deepLink: "/work/env/project/tasks/task" }),
      ),
    ).toBeNull();
  });

  it("routes duplicate initial and listener delivery to the exact task only once", async () => {
    const handledResponseIds = new Set<string>();
    const navigations: Array<string> = [];
    const initial = responseWithData(workData(), "work-notification");
    const handleResponse = (response: unknown) =>
      routeAgentNotificationResponseOnce({
        handledResponseIds,
        response,
        navigate: (link) => navigations.push(link),
      });
    const clearLastResponse = vi.fn(() => Promise.resolve());
    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(initial as NotificationResponse),
      clearLastResponse,
      handleResponse,
    });
    handleResponse(
      responseWithData(workData({ threadId: "replacement-thread" }), "work-notification"),
    );
    expect(navigations).toEqual(["/work/work-env/work-project/tasks/work-task"]);
    expect(clearLastResponse).toHaveBeenCalledOnce();
  });

  it("routes separately identified notifications to their respective environments and projects", () => {
    const handledResponseIds = new Set<string>();
    const navigations: Array<string> = [];
    for (const [identifier, environmentId, projectId] of [
      ["one", "env-one", "project-one"],
      ["two", "env-two", "project-two"],
    ]) {
      routeAgentNotificationResponseOnce({
        handledResponseIds,
        response: responseWithData(
          workData({
            environmentId,
            projectWork: { projectId, taskId: "same-task", state: "ready", revision: 1 },
          }),
          identifier,
        ),
        navigate: (link) => navigations.push(link),
      });
    }
    expect(navigations).toEqual([
      "/work/env-one/project-one/tasks/same-task",
      "/work/env-two/project-two/tasks/same-task",
    ]);
  });

  it("does not navigate on duplicate invalid work hints or poison a separate thread notification", () => {
    const handledResponseIds = new Set<string>();
    const navigations: Array<string> = [];
    const invalid = responseWithData(workData({ projectWork: null }), "invalid-work");
    for (const response of [
      invalid,
      invalid,
      responseWithData({ environmentId: "legacy-env", threadId: "legacy-thread" }, "legacy"),
    ]) {
      routeAgentNotificationResponseOnce({
        handledResponseIds,
        response,
        navigate: (link) => navigations.push(link),
      });
    }
    expect(navigations).toEqual(["/threads/legacy-env/legacy-thread"]);
    expect([...handledResponseIds]).toEqual(["invalid-work", "legacy"]);
  });
});
