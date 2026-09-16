import { cn } from "@/web/lib/utils";
import { isPulsing, statusLabel, type DisplayStatus } from "@/web/lib/status";

/**
 * The shared status mark: a dot plus an uppercase mono label. Sits on the
 * `data-status` hook so `styles.css` assigns `--status` per semantic value
 * (`docs/design/design.md`: status-only colour) and the dot/label consume it
 * via `bg-(--status)`/`text-(--status)`. `pulse` is for in-flight work —
 * running runs and running steps.
 */
export function StatusCell({
  status,
  label,
  className,
}: {
  readonly status: DisplayStatus;
  readonly label?: string;
  readonly className?: string;
}) {
  return (
    <span data-status={status} className={cn("inline-flex items-center gap-[7px]", className)}>
      <i
        className={cn(
          "size-[7px] flex-none rounded-full bg-(--status)",
          isPulsing(status) && "motion-reduce:animate-none animate-status-pulse",
        )}
        aria-hidden="true"
      />
      <span className="text-[11px] font-semibold tracking-[0.02em] whitespace-nowrap uppercase text-(--status)">
        {label ?? statusLabel(status)}
      </span>
    </span>
  );
}
