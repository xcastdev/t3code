import type { Icon, IconProps } from "@tabler/icons-react-native/types";
import { forwardRef } from "react";
import Svg, { Path } from "react-native-svg";

// The tab PNGs (assets/icons/agent*.png, the iOS icon bundle) and t3_agents.xml draw these paths too.
const PATHS = [
  "M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1 -3 3h-10a3 3 0 0 1 -3 -3v-6a3 3 0 0 1 3 -3",
  "M12 8v-4",
  "M9 13v1",
  "M15 13v1",
];

/** The Agents tab's robot head, on Tabler's outline grid like the tab icons beside it. */
export const IconRobotHead: Icon = forwardRef<Svg, IconProps>(
  ({ color = "currentColor", size = 24, strokeWidth = 2, title: _title, ...rest }, ref) => (
    <Svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {PATHS.map((d) => (
        <Path key={d} d={d} />
      ))}
    </Svg>
  ),
);
IconRobotHead.displayName = "IconRobotHead";
