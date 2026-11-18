import Svg, { Circle } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedCircle = withUniwind(Circle);

/** Static gauge; it redraws only when the reported value changes. */
export function ContextRing(props: {
  readonly percent: number;
  readonly size: number;
  readonly stroke: number;
  /** A provider's own color; otherwise the gauge warns as it fills. */
  readonly color?: string | null;
  readonly dangerAt?: number;
}) {
  const radius = (props.size - props.stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = props.size / 2;
  const used = Math.min(Math.max(props.percent, 0), 100) / 100;
  const arc = {
    cx: center,
    cy: center,
    r: radius,
    strokeWidth: props.stroke,
    strokeDasharray: `${circumference} ${circumference}`,
    strokeDashoffset: circumference * (1 - used),
    strokeLinecap: "round",
    fill: "none",
    transform: `rotate(-90 ${center} ${center})`,
  } as const;
  return (
    <Svg width={props.size} height={props.size} accessibilityElementsHidden>
      <ThemedCircle
        cx={center}
        cy={center}
        r={radius}
        // A translucent foreground track reads on light and dark cards alike.
        colorClassName="accent-foreground-muted"
        stroke="currentColor"
        strokeOpacity={0.28}
        strokeWidth={props.stroke}
        fill="none"
      />
      {props.color ? (
        <Circle {...arc} stroke={props.color} />
      ) : (
        <ThemedCircle
          {...arc}
          colorClassName={
            props.dangerAt !== undefined && props.percent > props.dangerAt
              ? "accent-danger-foreground"
              : props.dangerAt === undefined && props.percent >= 80
                ? "accent-warning-foreground"
                : "accent-icon-muted"
          }
          stroke="currentColor"
        />
      )}
    </Svg>
  );
}
