import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { useT3ProjectFileState } from "../hooks/useT3ProjectFileScripts";
import ProjectScriptsControl, { type ProjectScriptActionResult } from "./ProjectScriptsControl";

// The read of t3.json is a cache: a re-read is the only way to see what is on disk now.
const t3File = vi.hoisted(() => ({
  disk: "",
  cached: "",
  listeners: new Set<() => void>(),
}));

vi.mock(import("~/components/files/projectFilesQueryState"), async (importOriginal) => {
  const actual = await importOriginal();
  const { useSyncExternalStore } = await import("react");
  return {
    ...actual,
    useProjectFileQuery: ((_environmentId: unknown, _cwd: string, relativePath: string | null) => {
      const contents = useSyncExternalStore(
        (listener) => {
          t3File.listeners.add(listener);
          return () => t3File.listeners.delete(listener);
        },
        () => t3File.cached,
      );
      const refresh = () => {
        t3File.cached = t3File.disk;
        for (const listener of t3File.listeners) listener();
      };
      const data =
        relativePath === "t3.json" && contents !== ""
          ? { relativePath, contents, byteLength: contents.length, truncated: false }
          : null;
      return {
        data,
        error: null,
        isPending: false,
        readError: null,
        isNotFile: false,
        isFile: data !== null,
        refresh,
      };
    }) as never,
  };
});

function ProjectFileScripts() {
  const environmentId = EnvironmentId.make("test");
  const projectFile = useT3ProjectFileState(environmentId, "/work/plain");
  return (
    <ProjectScriptsControl
      environmentId={environmentId}
      displayMode="panel"
      scripts={[]}
      fileScripts={projectFile.scripts}
      onActionsMenuOpen={projectFile.refresh}
      onAddScript={async () => AsyncResult.success(undefined)}
      onUpdateScript={async () => AsyncResult.success(undefined)}
      onDeleteScript={async () => AsyncResult.success(undefined)}
    />
  );
}

it("lists the t3.json actions on disk when the actions menu opens again after the file changed", async () => {
  const t3Json = (name: string) =>
    JSON.stringify({ scripts: [{ name, command: `npm run dev -- --port ${name.slice(-4)}` }] });
  t3File.disk = t3Json("Dev 4100");
  t3File.cached = t3File.disk;
  await using _screen = await render(<ProjectFileScripts />);

  const chooser = page.getByRole("button", { name: "Choose project action" });
  await chooser.click();
  await expect.element(page.getByRole("menuitem", { name: /Dev 4100/ })).toBeVisible();
  await chooser.click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

  // A setup hook rewrites this checkout's t3.json outside T3 Code.
  t3File.disk = t3Json("Dev 4200");

  await chooser.click();
  await expect.element(page.getByRole("menuitem", { name: /Dev 4200/ })).toBeVisible();
});

it.each(["edit", "dismiss", "newer import fails first"] as const)(
  "keeps a failed import from replacing a newer action after %s",
  async (nextAction) => {
    const older = Promise.withResolvers<ProjectScriptActionResult>();
    const newer = Promise.withResolvers<ProjectScriptActionResult>();
    await using screen = await render(
      <ProjectScriptsControl
        environmentId={EnvironmentId.make("test")}
        displayMode="panel"
        scripts={[
          {
            id: "local-check",
            name: "Local check",
            command: "echo local",
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ]}
        fileScripts={[
          { name: "Shared build", command: "echo build" },
          { name: "Shared lint", command: "echo lint" },
        ]}
        onRunScript={() => {}}
        onAddScript={({ name }) => (name === "Shared build" ? older.promise : newer.promise)}
        onUpdateScript={async () => AsyncResult.success(undefined)}
        onDeleteScript={async () => AsyncResult.success(undefined)}
      />,
    );

    const actions = screen.getByRole("button", { name: "Script actions" });
    const dialog = page.getByRole("dialog");
    const name = dialog.getByRole("textbox", { name: "Name" });
    const failure = AsyncResult.failure<void, unknown>(
      Cause.fail(new Error("Settings write failed")),
    );

    await actions.click();
    await page.getByRole("menuitem", { name: /Shared build/ }).click();
    await actions.click();

    switch (nextAction) {
      case "edit":
        await page.getByRole("button", { name: "Edit Local check" }).click();
        await act(async () => older.resolve(failure));
        expect(name.query()).toHaveProperty("value", "Local check");
        break;
      case "dismiss":
        await page.getByRole("menuitem", { name: "Add project script" }).click();
        await expect.element(dialog).toBeVisible();
        await userEvent.keyboard("{Escape}");
        await expect.element(dialog).not.toBeInTheDocument();
        await act(async () => older.resolve(failure));
        expect(dialog.query() === null).toBe(true);
        break;
      case "newer import fails first":
        await page.getByRole("menuitem", { name: /Shared lint/ }).click();
        await act(async () => newer.resolve(failure));
        await act(async () => older.resolve(failure));
        expect(name.query()).toHaveProperty("value", "Shared lint");
        break;
    }
  },
);
