import * as Schema from "effect/Schema";
import { ChevronRightIcon } from "lucide-react";
import { createContext, type ComponentProps, type ReactNode, useContext } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";

const COLLAPSED_SECTIONS_KEY = "t3code:thread-details:collapsed-sections";
// Sections opened while the card was too short for them; they stay open and the card scrolls.
const EXPANDED_SECTIONS_KEY = "t3code:thread-details:expanded-sections";
const SectionIds = Schema.Array(Schema.String);
const NO_SECTIONS: ReadonlyArray<string> = [];

const AutoCollapseContext = createContext(false);

/** Collapses the sections inside to their headings while the card lacks room for them. */
export function ThreadDetailsAutoCollapse(props: {
  readonly collapsed: boolean;
  readonly children: ReactNode;
}) {
  return (
    <AutoCollapseContext.Provider value={props.collapsed}>
      {props.children}
    </AutoCollapseContext.Provider>
  );
}

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
    NO_SECTIONS,
    SectionIds,
  );
  const [expandedSections, setExpandedSections] = useLocalStorage(
    EXPANDED_SECTIONS_KEY,
    NO_SECTIONS,
    SectionIds,
  );
  const autoCollapsed = useContext(AutoCollapseContext);
  const collapsed =
    showHeading &&
    (collapsedSections.includes(headingId) ||
      (autoCollapsed && !expandedSections.includes(headingId)));
  const toggle = () => {
    const without = (current: ReadonlyArray<string>) => current.filter((id) => id !== headingId);
    if (collapsed) {
      setCollapsedSections(without);
      if (autoCollapsed) setExpandedSections((current) => [...without(current), headingId]);
    } else {
      setCollapsedSections((current) => [...without(current), headingId]);
      setExpandedSections(without);
    }
  };
  const contentId = `${headingId}-content`;
  return (
    <section
      {...props}
      aria-labelledby={showHeading ? headingId : undefined}
      aria-label={showHeading ? undefined : title}
      // A row can still render nothing (a fresh draft quiets Git actions), so an empty section
      // collapses, and a divider only follows a section that has content.
      className={cn(
        "px-2 pt-2 has-[>div:last-child:empty]:hidden",
        collapsed ? "pb-1" : "pb-2.5",
        separated && "border-border/65 [section:not(:has(>div:last-child:empty))~&]:border-t",
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
            onClick={toggle}
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
