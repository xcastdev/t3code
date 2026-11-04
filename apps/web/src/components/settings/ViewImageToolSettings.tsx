import { VISION_MODEL_DRIVERS } from "@t3tools/contracts";

import {
  type DelegatedModelToolConfig,
  DelegatedModelToolSection,
} from "./DelegatedModelToolSection";

const VIEW_IMAGE_TOOL_CONFIG: DelegatedModelToolConfig = {
  sectionId: "image-viewing",
  title: "Image viewing",
  enabledKey: "viewImageToolEnabled",
  modelKey: "visionModelSelection",
  drivers: VISION_MODEL_DRIVERS,
  unsupportedDriverReason: "Only Codex and OpenCode models can look at images.",
  toggleSearchId: "view-image-tool",
  toggleLabel: "View image tool",
  toggleDescription:
    "Give agents a tool that asks a vision model to describe an image file in their workspace, for models that can't see images. New agent sessions get it.",
  modelSearchId: "vision-model",
  modelLabel: "Vision model",
  modelDescription:
    "The model that looks at the image. Codex and OpenCode models only. Agents don't get the tool until you choose one.",
  noProviderMessage: "Add a Codex or OpenCode provider to choose a vision model.",
  noEnvironmentMessage: "Connect an environment to choose its vision model.",
  patchEnabled: (enabled) => ({ viewImageToolEnabled: enabled }),
  patchModel: (selection) => ({ visionModelSelection: selection }),
};

export function ViewImageToolSection() {
  return <DelegatedModelToolSection config={VIEW_IMAGE_TOOL_CONFIG} />;
}
