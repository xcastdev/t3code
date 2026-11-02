import { LoaderCircleIcon, SquareIcon, Trash2Icon } from "lucide-react";
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
  readonly stop?: RowAction;
  readonly remove?: RowAction;
}) {
  const actions = [
    props.stop ? { ...props.stop, icon: "stop" as const } : null,
    props.remove ? { ...props.remove, icon: "remove" as const } : null,
  ].filter((action) => action !== null);
  const text = (
    // The end padding keeps text clear of the action buttons.
    <span
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-0.5 text-left",
        actions.length === 1 && "pe-6",
        actions.length === 2 && "pe-12",
      )}
    >
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
      {actions.length > 0 ? (
        <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
          {actions.map((action) => (
            <RowActionButton key={action.icon} action={action} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

interface RowAction {
  readonly label: string;
  readonly tooltip: string;
  readonly onAction: () => Promise<void>;
}

function RowActionButton(props: {
  readonly action: RowAction & { readonly icon: "stop" | "remove" };
}) {
  const [pending, setPending] = useState(false);
  const { action } = props;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ThreadDetailsControl
            size="icon-xs"
            variant="ghost"
            part="icon"
            tone="destructive"
            aria-label={action.label}
            disabled={pending}
            onClick={() => {
              setPending(true);
              void action.onAction().finally(() => setPending(false));
            }}
          />
        }
      >
        {pending ? (
          <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
        ) : action.icon === "stop" ? (
          <SquareIcon aria-hidden className="size-3 fill-current" />
        ) : (
          <Trash2Icon aria-hidden className="size-3" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="left">{action.tooltip}</TooltipPopup>
    </Tooltip>
  );
}
