// Viewed-file controls for the pull request Changes tab: the per-file "Viewed"
// checkbox in each file's header, and the progress and "Hide viewed" row in the toolbar.

import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** The "Viewed" checkbox in a file's header; disabled while the viewed key is unknown. */
export function PullRequestViewedToggle({
  path,
  viewed,
  available,
  onToggle,
}: {
  path: string;
  viewed: boolean;
  available: boolean;
  onToggle: () => void;
}) {
  const toggle = (
    <label
      className={cn(
        "flex shrink-0 items-center gap-1.5 px-1 text-xs text-muted-foreground",
        available ? "cursor-pointer" : "opacity-50",
      )}
    >
      <Checkbox
        checked={viewed}
        disabled={!available}
        onCheckedChange={onToggle}
        aria-label={`Viewed ${path}`}
      />
      Viewed
    </label>
  );
  if (available) return toggle;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex">{toggle}</span>
      </TooltipTrigger>
      <TooltipContent>Viewed state unavailable</TooltipContent>
    </Tooltip>
  );
}

/** The toolbar's viewed count, a thin bar, and the "Hide viewed" toggle. */
export function PullRequestViewedProgress({
  viewedCount,
  totalCount,
  partial,
  available,
  mobile,
  hideViewed,
  onHideViewedChange,
}: {
  viewedCount: number;
  totalCount: number;
  /** The changed-file list is truncated, so the total is a lower bound. */
  partial: boolean;
  available: boolean;
  /** Mobile shows the count only. */
  mobile: boolean;
  hideViewed: boolean;
  onHideViewedChange: (hide: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
      {available && (
        <>
          <span>{`${viewedCount} / ${totalCount} files viewed${partial ? " (partial)" : ""}`}</span>
          {!mobile && (
            <Progress
              aria-label="Files viewed"
              value={totalCount > 0 ? (viewedCount / totalCount) * 100 : 0}
              className="w-16"
            />
          )}
        </>
      )}
      <label className={cn("flex items-center gap-1.5 px-1", !available && "opacity-50")}>
        <Checkbox
          checked={hideViewed}
          disabled={!available}
          onCheckedChange={(checked) => onHideViewedChange(checked === true)}
        />
        Hide viewed
      </label>
    </div>
  );
}
