import { PROJECT_TEAM_PRESETS, type ProjectTeamAvatar } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { WorkAvatarEditor } from "./WorkAvatarEditor";
import { memberAvatarIdentity } from "./workTeamView";

function Editor({ initial = null }: { initial?: ProjectTeamAvatar | null }) {
  const [avatar, setAvatar] = useState(initial);
  return (
    <WorkAvatarEditor
      identity={memberAvatarIdentity("implementer", "Otto")}
      preset={PROJECT_TEAM_PRESETS.implementer.avatar}
      name="Otto"
      avatar={avatar}
      recorded={initial}
      others={[]}
      onChange={setAvatar}
    />
  );
}

it("keeps color and mood overrides when switching modes and can revert to initials", async () => {
  await using screen = await render(<Editor />);
  await userEvent.click(screen.getByRole("button", { name: "Face", exact: true }));
  await expect
    .element(screen.getByRole("img", { name: "Otto's avatar: focused, sand face" }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Smile", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Paper", exact: true }));
  await expect
    .element(screen.getByRole("img", { name: "Otto's avatar: smile, paper face" }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Initials", exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "Generate another face", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Face", exact: true }));
  await expect
    .element(screen.getByRole("img", { name: "Otto's avatar: smile, paper face" }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Revert avatar", exact: true }));
  await expect
    .element(screen.getByRole("img", { name: "Otto's avatar: initials O" }))
    .toBeVisible();
});

it("turns preview off with the avatar's motion preference", async () => {
  await using screen = await render(<Editor initial={PROJECT_TEAM_PRESETS.implementer.avatar} />);
  await expect.element(screen.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
  await userEvent.click(screen.getByRole("switch", { name: "Animate", exact: true }));
  await expect.element(screen.getByRole("button", { name: "Preview", exact: true })).toBeDisabled();
  await expect
    .element(screen.getByText("Motion is off for this avatar.", { exact: true }))
    .toBeVisible();
});
