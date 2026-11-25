import { agentFace, type AgentAvatarShape } from "@t3tools/client-runtime/project-work";
import { PROJECT_TEAM_PRESETS, type ProjectTeamAvatar } from "@t3tools/contracts";
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  interpolate,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";
import { withUniwind } from "uniwind";
import { AppText } from "../../components/ui/AppText";
import { projectMonogram } from "@t3tools/shared/projectMonogram";
import { projectAutoMonogram, projectIconColorClassNames } from "../../lib/projectIcon";
import type { TeamRole } from "@t3tools/client-runtime/project-work-logic";

const ThemedSvg = withUniwind(Svg);
const AnimatedG = Animated.createAnimatedComponent(G);
const shapeKey = (s: AgentAvatarShape) =>
  s.kind === "path" ? s.d : s.kind === "circle" ? `circle:${s.cx}:${s.cy}` : `rect:${s.x}:${s.y}`;
function FaceShape({ shape }: { shape: AgentAvatarShape }) {
  if (shape.kind === "rect")
    return (
      <Rect
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
      <Circle
        cx={shape.cx}
        cy={shape.cy}
        r={shape.r}
        fill={shape.fill}
        stroke={shape.stroke}
        strokeWidth={shape.strokeWidth}
      />
    );
  return (
    <Path d={shape.d} fill={shape.fill} stroke={shape.stroke} strokeWidth={shape.strokeWidth} />
  );
}

export function WorkAgentAvatar({
  role,
  name,
  avatar,
  size = 40,
  preview = 0,
}: {
  /** A team role's preset colors; without one the name picks them, as for projects. */
  role?: TeamRole;
  name: string;
  avatar: ProjectTeamAvatar | null | undefined;
  size?: number;
  preview?: number;
}) {
  const progress = useSharedValue(0);
  const reduced = useReducedMotion();
  const motion = avatar?.motion === true;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Preview requests drive a native animation that must cancel on unmount.
  useEffect(() => {
    progress.set(0);
    if (preview > 0 && motion && !reduced) progress.set(withTiming(1, { duration: 900 }));
    return () => cancelAnimation(progress);
  }, [motion, preview, progress, reduced]);
  const pose = useAnimatedProps(() => ({
    transform: `rotate(${interpolate(progress.value, [0, 0.25, 0.55, 1], [0, 6, -3, 0])} 20 32)`,
  }));
  const eyes = useAnimatedProps(() => ({
    transform: `translate(20 20) scale(1 ${interpolate(progress.value, [0, 0.4, 0.45, 0.52, 0.65, 1], [1, 1, 0.1, 0.1, 1, 1])}) translate(-20 -20)`,
  }));
  const preset = role === undefined ? null : PROJECT_TEAM_PRESETS[role];
  const nameGlyph = projectAutoMonogram(name);
  const colors = projectIconColorClassNames(
    preset?.color ?? (nameGlyph?.kind === "monogram" ? nameGlyph.color : "blue"),
  );
  const monogram =
    preset === null
      ? projectMonogram(name)
      : !name.trim() || name === role
        ? preset.roleMonogram
        : name === preset.name
          ? preset.monogram
          : projectMonogram(name);
  const face = avatar ? agentFace(avatar) : null;
  return (
    <View
      accessible={false}
      className={colors.background}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.25,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {face ? (
        <ThemedSvg
          width={size}
          height={size}
          viewBox="0 0 40 40"
          colorClassName={colors.tint}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <AnimatedG animatedProps={pose}>
            {face.accessory.map((shape) => (
              <FaceShape key={shapeKey(shape)} shape={shape} />
            ))}
            {face.head.map((shape) => (
              <FaceShape key={shapeKey(shape)} shape={shape} />
            ))}
            <AnimatedG animatedProps={eyes}>
              {face.eyes.map((shape) => (
                <FaceShape key={shapeKey(shape)} shape={shape} />
              ))}
            </AnimatedG>
            {face.mouth.map((shape) => (
              <FaceShape key={shapeKey(shape)} shape={shape} />
            ))}
          </AnimatedG>
        </ThemedSvg>
      ) : (
        <AppText
          allowFontScaling={false}
          className={`font-mono ${colors.text}`}
          style={{ fontSize: size * 0.44, fontWeight: "700" }}
        >
          {monogram}
        </AppText>
      )}
    </View>
  );
}
