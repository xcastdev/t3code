import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PluginReferenceContextRecord, PluginResolvedReference } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { PuzzleIcon } from "lucide-react";
import { useState } from "react";

import { pluginEnvironment } from "~/state/plugins";
import { useAtomCommand } from "~/state/use-atom-command";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { UnresolvedChip } from "../contextChipParts";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

type Resolved =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "resolved"; readonly value: PluginResolvedReference }
  | { readonly status: "failed"; readonly message: string };

function usePluginInstalledInEnvironment(record: PluginReferenceContextRecord): boolean {
  const registry = useAtomValue(
    pluginEnvironment.registry({ environmentId: record.environmentId, input: {} }),
  );
  if (AsyncResult.isFailure(registry)) return false;
  if (!AsyncResult.isSuccess(registry)) return true;
  return registry.value.installed.some(
    (install) => install.pluginId === record.pluginId && install.enabled,
  );
}

/**
 * A plugin reference in the composer and in sent messages. It shows the stored snapshot and
 * asks the plugin for the live detail only when the user opens it.
 */
export function PluginReferenceChip(props: {
  readonly record: PluginReferenceContextRecord;
  readonly copyMarkdown?: string;
}) {
  const { record } = props;
  const installed = usePluginInstalledInEnvironment(record);
  const resolveReference = useAtomCommand(pluginEnvironment.resolveReference, {
    reportFailure: false,
  });
  const [resolved, setResolved] = useState<Resolved>({ status: "idle" });
  if (!installed) {
    return (
      <UnresolvedChip
        label={record.label}
        tooltip={`Plugin unavailable. ${record.pluginName} is not installed in this chat's environment.`}
        {...(props.copyMarkdown === undefined ? {} : { copyMarkdown: props.copyMarkdown })}
      />
    );
  }
  const expand = () => {
    if (resolved.status === "loading" || resolved.status === "resolved") return;
    setResolved({ status: "loading" });
    void resolveReference({
      environmentId: record.environmentId,
      input: { pluginId: record.pluginId, locator: record.locator },
    }).then((result) =>
      setResolved(
        result._tag === "Success"
          ? { status: "resolved", value: result.value }
          : { status: "failed", message: String(squashAtomCommandFailure(result)) },
      ),
    );
  };
  const accessibleLabel = `${record.pluginName}, ${record.label}`;
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) expand();
      }}
    >
      <PopoverTrigger
        render={
          <ContextChip
            render={<button type="button" />}
            aria-label={`${accessibleLabel}. Show details`}
            data-markdown-copy={props.copyMarkdown}
          />
        }
      >
        <PuzzleIcon />
        <ContextChipLabel>{record.label}</ContextChipLabel>
      </PopoverTrigger>
      <PopoverPopup side="top" width="lg" padding="compact">
        <PopoverTitle>
          {resolved.status === "resolved" ? resolved.value.title : accessibleLabel}
        </PopoverTitle>
        {resolved.status === "failed" ? (
          <p className="mt-1 text-destructive-foreground text-xs">{resolved.message}</p>
        ) : null}
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-2 font-mono text-3xs">
          {resolved.status === "resolved" ? resolved.value.detail : record.snapshot}
        </pre>
        {resolved.status !== "resolved" && record.snapshotTruncated ? (
          <p className="mt-1 text-muted-foreground text-3xs">Snapshot truncated.</p>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
