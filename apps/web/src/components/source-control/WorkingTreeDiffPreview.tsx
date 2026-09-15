import { cn } from "~/lib/utils";

export function WorkingTreeDiffPreview({ diff }: { readonly diff: string }) {
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-background p-2 font-mono text-[11px] leading-relaxed">
      {diff.split("\n").map((line, index) => (
        <span
          className={cn(
            "block",
            line.startsWith("+") &&
              !line.startsWith("+++") &&
              "bg-diff-addition/15 text-diff-addition",
            line.startsWith("-") &&
              !line.startsWith("---") &&
              "bg-diff-deletion/15 text-diff-deletion",
            line.startsWith("@@") && "text-muted-foreground",
          )}
          key={`${index}-${line}`}
        >
          {line || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
