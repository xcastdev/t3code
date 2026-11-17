const RING_RADIUS = 10;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** A small gauge with its percentage in the middle, for collapsed panel summaries. */
export function ThreadDetailsRing(props: {
  readonly percent: number;
  readonly color: string;
  readonly label: string;
}) {
  return (
    <span
      role="img"
      aria-label={props.label}
      className="relative grid size-6 shrink-0 place-items-center"
    >
      <svg viewBox="0 0 24 24" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2.5"
          className="stroke-muted"
        />
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          stroke={props.color}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - props.percent / 100)}
        />
      </svg>
      <span className="text-4xs leading-none font-semibold text-foreground/85">
        {props.percent}
      </span>
    </span>
  );
}
