import { LoaderCircleIcon, SquareIcon } from "lucide-react";
import { type MouseEvent, type ReactNode, useState } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS } from "./threadDetailsPanelStyles";

/** One row in a thread's Processes: what runs, what kind it is, and how to open or stop it. */
export function ThreadProcessRow(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly open?: {
    readonly tooltip: string;
    readonly disabled?: boolean;
    readonly onOpen: (event: MouseEvent<HTMLElement>) => void;
  };
  readonly stop?: {
    readonly label: string;
    readonly tooltip: string;
    readonly onStop: () => Promise<void>;
  };
}) {
  const [stopping, setStopping] = useState(false);
  const stop = props.stop;
  const text = (
    // The end padding keeps text clear of the stop button.
    <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5 text-left", stop && "pe-6")}>
      <span className="truncate text-sm font-medium leading-4 text-foreground/85">
        {props.title}
      </span>
      <span className="truncate text-2xs font-normal leading-4 text-muted-foreground">
        {props.detail}
      </span>
    </span>
  );
  return (
    <li className="group relative flex items-center rounded-lg">
      {props.open ? (
        <Tooltip>
          <TooltipTrigger
            delay={200}
            render={
              <ThreadDetailsControl
                size="sm"
                variant="ghost"
                part="row"
                multiline
                disabled={props.open.disabled ?? false}
                onClick={props.open.onOpen}
                onAuxClick={props.open.onOpen}
              />
            }
          >
            {props.icon}
            {text}
          </TooltipTrigger>
          <TooltipPopup side="left">{props.open.tooltip}</TooltipPopup>
        </Tooltip>
      ) : (
        <div
          className={cn(
            "flex min-h-8 w-full items-center rounded-lg py-0.75",
            THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
          )}
        >
          {props.icon}
          {text}
        </div>
      )}
      {stop ? (
        <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  tone="destructive"
                  aria-label={stop.label}
                  disabled={stopping}
                  onClick={() => {
                    setStopping(true);
                    void stop.onStop().finally(() => setStopping(false));
                  }}
                />
              }
            >
              {stopping ? (
                <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
              ) : (
                <SquareIcon aria-hidden className="size-3 fill-current" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="left">{stop.tooltip}</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </li>
  );
}
