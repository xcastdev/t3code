import { EnvironmentId, ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ThreadServerRows } from "./ThreadServersPanel";

const servers = Array.from(
  { length: 10 },
  (_, index) =>
    ({
      pid: index,
      port: 3000 + index,
      url: `http://localhost:${3000 + index}`,
      terminal: null,
      processName: "node",
    }) as DiscoveredLocalServer,
);

const rows = (threadId: string) => (
  <ul>
    <ThreadServerRows
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make(threadId)}
      servers={servers}
    />
  </ul>
);

it("pages servers four at a time, collapses back, and resets on thread switch", async () => {
  await using screen = await render(rows("a"));
  const count = (selector: string) => screen.container.querySelectorAll(selector).length;
  const serverRows = () =>
    Array.from(screen.container.querySelectorAll("span")).filter((span) =>
      /^localhost:\d+$/.test(span.textContent ?? ""),
    ).length;
  const expectRows = (expected: number) => vi.waitFor(() => expect(serverRows()).toBe(expected));

  await expectRows(4);
  await page.getByRole("button", { name: "Show 4 more" }).click();
  await expectRows(8);
  expect(count("[data-thread-details-server-overflow] li")).toBe(4);
  await page.getByRole("button", { name: "Show 2 more" }).click();
  await expectRows(10);
  await page.getByRole("button", { name: "Show less" }).click();
  await expectRows(4);

  await page.getByRole("button", { name: "Show 4 more" }).click();
  await expectRows(8);
  await screen.rerender(rows("b"));
  await expectRows(4);
  await screen.rerender(rows("a"));
  await expectRows(4);
});
