import { agentFace, type AgentAvatarShape } from "@t3tools/client-runtime/project-work";
import type { ProjectIconColor, ProjectTeamAvatar } from "@t3tools/contracts";
import { ProjectMonogram } from "../ProjectMonogram";
import { projectIconColorClassName } from "../../projectIconColors";
import { cn } from "../../lib/utils";
import type { WorkMemberView } from "./workTeamView";
import "./agentAvatar.css";

const shapeKey = (shape: AgentAvatarShape) =>
  shape.kind === "path"
    ? shape.d
    : shape.kind === "circle"
      ? `circle:${shape.cx}:${shape.cy}`
      : `rect:${shape.x}:${shape.y}`;

function FaceShape({ shape }: { shape: AgentAvatarShape }) {
  if (shape.kind === "rect")
    return (
      <rect
        x={shape.x}
        y={shape.y}
        width={shape.width}
        height={shape.height}
        rx={shape.rx}
        fill={shape.fill}
      />
    );
  if (shape.kind === "circle")
    return (
      <circle
        cx={shape.cx}
        cy={shape.cy}
        r={shape.r}
        fill={shape.fill}
        stroke={shape.stroke}
        strokeWidth={shape.strokeWidth}
      />
    );
  return (
    <path d={shape.d} fill={shape.fill} stroke={shape.stroke} strokeWidth={shape.strokeWidth} />
  );
}

export function WorkMemberAvatar({
  member,
  large = false,
  size,
  play = false,
  preview = 0,
}: {
  member: {
    monogram: string;
    color: ProjectIconColor;
    avatar?: ProjectTeamAvatar | null | undefined;
  };
  large?: boolean;
  size?: "icon" | "row" | "card" | "preview" | undefined;
  play?: boolean;
  preview?: number;
}) {
  const dimensions =
    size === "preview"
      ? "size-12 sm:size-16"
      : size === "card" || large
        ? "size-10"
        : size === "icon"
          ? "size-5"
          : "size-7";
  if (!member.avatar)
    return <ProjectMonogram text={member.monogram} color={member.color} className={dimensions} />;
  const face = agentFace(member.avatar);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[25%] bg-current/10",
        dimensions,
        projectIconColorClassName(member.color),
      )}
      data-agent-avatar=""
      data-motion={member.avatar.motion}
      data-interactive={play}
      data-preview={preview > 0}
    >
      <svg
        key={`${member.avatar.seed}:${preview}`}
        viewBox="0 0 40 40"
        className="size-full"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <g data-part="pose">
          {face.accessory.map((shape) => (
            <FaceShape key={shapeKey(shape)} shape={shape} />
          ))}
          <g data-part="head">
            {face.head.map((shape) => (
              <FaceShape key={shapeKey(shape)} shape={shape} />
            ))}
          </g>
          <g data-part="eyes">
            {face.eyes.map((shape) => (
              <FaceShape key={shapeKey(shape)} shape={shape} />
            ))}
          </g>
          {face.mouth.map((shape) => (
            <FaceShape key={shapeKey(shape)} shape={shape} />
          ))}
        </g>
      </svg>
    </span>
  );
}

export function WorkMemberName({ member }: { member: WorkMemberView | undefined }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium">
      {member ? <WorkMemberAvatar member={member} /> : null}
      <span className="truncate">{member?.name ?? "A team member"}</span>
    </span>
  );
}
