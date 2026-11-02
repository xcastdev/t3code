import { cva, type VariantProps } from "class-variance-authority";

const attentionDotVariants = cva("pointer-events-none rounded-full bg-destructive", {
  variants: {
    size: {
      default: "size-2",
      sm: "size-1.5",
    },
    placement: {
      /** Pinned to the top-right corner of a `relative` icon button. */
      corner: "absolute -top-0.5 -right-0.5 ring-2 ring-background",
      /** Inside the top-right corner of a `relative` container, clear of its edge. */
      inset: "absolute top-1 right-1",
      inline: "relative inline-block shrink-0",
    },
  },
  defaultVariants: { size: "default", placement: "corner" },
});

/**
 * A red dot for something waiting on the user. Each new `pulse` value pings it three times;
 * between arrivals it holds still. `continuous` (an opt-in setting) keeps it pinging.
 */
export function AttentionDot({
  pulse,
  continuous = false,
  size,
  placement,
}: VariantProps<typeof attentionDotVariants> & {
  readonly pulse: number;
  readonly continuous?: boolean;
}) {
  return (
    <span aria-hidden className={attentionDotVariants({ size, placement })}>
      {continuous ? (
        <span className="absolute inset-0 rounded-full bg-destructive opacity-0 motion-safe:animate-attention-ping-loop" />
      ) : pulse > 0 ? (
        <span
          key={pulse}
          className="absolute inset-0 rounded-full bg-destructive opacity-0 motion-safe:animate-attention-ping"
        />
      ) : null}
    </span>
  );
}
