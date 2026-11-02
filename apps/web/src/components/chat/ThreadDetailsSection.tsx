import * as Schema from "effect/Schema";
import { ChevronRightIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";

const COLLAPSED_SECTIONS_KEY = "t3code:thread-details:collapsed-sections";
const CollapsedSections = Schema.Array(Schema.String);
const NO_COLLAPSED_SECTIONS: ReadonlyArray<string> = [];

export function ThreadDetailsSection({
  headingId,
  title,
  actions,
  collapsedSummary,
  separated = true,
  showHeading = true,
  children,
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  headingId: string;
  title: string;
  actions?: ReactNode;
  /** Replaces `actions` while collapsed: the one figure worth seeing without opening it. */
  collapsedSummary?: ReactNode;
  separated?: boolean;
  showHeading?: boolean;
}) {
  // Keyed by heading id, so a section stays collapsed across threads and reloads.
  const [collapsedSections, setCollapsedSections] = useLocalStorage(
    COLLAPSED_SECTIONS_KEY,
    NO_COLLAPSED_SECTIONS,
    CollapsedSections,
  );
  const collapsed = showHeading && collapsedSections.includes(headingId);
  const contentId = `${headingId}-content`;
  return (
    <section
      {...props}
      aria-labelledby={showHeading ? headingId : undefined}
      aria-label={showHeading ? undefined : title}
      className={cn(
        "px-2 pt-2",
        collapsed ? "pb-1" : "pb-2.5",
        separated && "border-t border-border/65",
      )}
    >
      <div
        className={cn(
          "mb-1 flex min-h-8 min-w-0 items-center justify-between gap-2 ps-1 pe-2.5",
          !showHeading && "hidden",
        )}
      >
        <h3 id={headingId} className="m-0 flex min-w-0">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={contentId}
            onClick={() =>
              setCollapsedSections((current) =>
                current.includes(headingId)
                  ? current.filter((id) => id !== headingId)
                  : [...current, headingId],
              )
            }
            className="group/section-toggle flex min-w-0 items-center gap-0.5 rounded-md py-0.5 ps-1.5 pe-1 text-2xs font-medium text-muted-foreground outline-none select-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span className="min-w-0 truncate">{title}</span>
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 opacity-0 transition-[rotate,opacity] duration-150 group-hover/section-toggle:opacity-100 group-focus-visible/section-toggle:opacity-100",
                collapsed ? "opacity-100" : "rotate-90",
              )}
            />
          </button>
        </h3>
        {(collapsed ? (collapsedSummary ?? actions) : actions) ? (
          <div className="flex min-w-0 shrink-0 items-center gap-1">
            {collapsed ? (collapsedSummary ?? actions) : actions}
          </div>
        ) : null}
      </div>
      {collapsed ? null : <div id={contentId}>{children}</div>}
    </section>
  );
}

export function ThreadDetailsSummary(props: { readonly children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 truncate text-2xs text-muted-foreground tabular-nums">
      {props.children}
    </span>
  );
}
