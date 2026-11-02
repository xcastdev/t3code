import { ChevronDownIcon, FolderPlusIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarInput, SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type SidebarView = "projects" | "agents";

const SIDEBAR_VIEW_LABELS: Record<SidebarView, string> = {
  projects: "Projects",
  agents: "Agents",
};

export interface SidebarThreadHeaderProps {
  searchFieldRef?: RefObject<HTMLDivElement | null>;
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;
  hasProjects: boolean;
  projectScope: ReactNode;
  onNewProject: () => void;
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  showNewThreadInProjectHint: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
  /** Replaces New thread while the Agents view is open. */
  agentActions?: ReactNode;
}

export function SidebarThreadHeader({
  searchFieldRef,
  view,
  onViewChange,
  hasProjects,
  projectScope,
  onNewProject,
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  showNewThreadInProjectHint,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
  agentActions,
}: SidebarThreadHeaderProps) {
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchOpen = searchExpanded || searchQuery.length > 0;
  const closeSearch = () => {
    onClearSearch();
    setSearchExpanded(false);
  };
  const resultsVisible = isSearching && searchResultCount > 0;
  // Shrinking results can remove the active option; never leave aria-activedescendant pointing at it.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  const newThreadLabel = newThreadShortcutLabel
    ? `New thread (${newThreadShortcutLabel})`
    : "New thread";
  const searchLabel = view === "agents" ? "Search agents" : "Search threads";

  return (
    <div ref={searchFieldRef} className="flex items-center gap-1">
      {searchOpen ? (
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-sidebar-row-hover px-2 py-1.5 text-sm font-medium text-sidebar-foreground ring-1 ring-inset ring-ring/70">
          <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
          <SidebarInput
            ref={searchInputRef}
            nativeInput
            autoFocus
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && searchQuery.length === 0) {
                event.preventDefault();
                setSearchExpanded(false);
                return;
              }
              onSearchKeyDown(event);
            }}
            onBlur={() => {
              if (searchQuery.length === 0) setSearchExpanded(false);
            }}
            placeholder={view === "agents" ? "Search agents" : "Search"}
            aria-label={searchLabel}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={resultsVisible}
            aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
            aria-activedescendant={
              activeResultExists
                ? `sidebar-thread-search-result-${activeSearchResultIndex}`
                : undefined
            }
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-muted"
            className="shrink-0"
            aria-label="Close search"
            onPointerDown={(event) => event.preventDefault()}
            onClick={closeSearch}
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1">
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  className="flex h-8 min-w-0 items-center gap-1 rounded-md px-2 text-sm font-semibold text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/70 data-popup-open:bg-sidebar-row-hover"
                  aria-label={`Sidebar view: ${SIDEBAR_VIEW_LABELS[view]}`}
                />
              }
            >
              <span className="truncate">{SIDEBAR_VIEW_LABELS[view]}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 text-(--sidebar-icon-color)" />
            </MenuTrigger>
            <MenuPopup align="start" className="min-w-40">
              <MenuRadioGroup
                value={view}
                onValueChange={(next) => {
                  if (next === "projects" || next === "agents") onViewChange(next);
                }}
              >
                <MenuRadioItem value="projects" closeOnClick>
                  {SIDEBAR_VIEW_LABELS.projects}
                </MenuRadioItem>
                <MenuRadioItem value="agents" closeOnClick>
                  {SIDEBAR_VIEW_LABELS.agents}
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        </div>
      )}
      <div className="flex shrink-0 items-center">
        {searchOpen ? null : (
          <SidebarHeaderIconButton label={searchLabel} onClick={() => setSearchExpanded(true)}>
            <SearchIcon />
          </SidebarHeaderIconButton>
        )}
        {view === "projects" && hasProjects ? (
          <>
            {projectScope}
            <SidebarHeaderIconButton label="Add project" onClick={onNewProject}>
              <FolderPlusIcon />
            </SidebarHeaderIconButton>
          </>
        ) : null}
        {view === "agents" && agentActions !== undefined ? (
          agentActions
        ) : (
          <SidebarHeaderIconButton
            label={view === "agents" ? "New agent" : "New thread"}
            tooltip={
              view === "agents" ? (
                "New agent"
              ) : showNewThreadInProjectHint ? (
                <span className="flex flex-col gap-0.5">
                  <span>{newThreadLabel}</span>
                  <span className="text-muted-foreground">
                    New thread in current project: Shift+click
                    {newThreadInProjectShortcutLabel ? ` (${newThreadInProjectShortcutLabel})` : ""}
                  </span>
                </span>
              ) : (
                newThreadLabel
              )
            }
            disabled={view === "projects" && newThreadDisabled}
            onClick={onNewThread}
          >
            <SquarePenIcon />
          </SidebarHeaderIconButton>
        )}
      </div>
    </div>
  );
}

export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
