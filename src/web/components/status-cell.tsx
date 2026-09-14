import { cn } from "@/web/lib/utils";
import { isPulsing, statusLabel, type DisplayStatus } from "@/web/lib/status";

/**
 * The shared status mark: a dot plus an uppercase mono label. Sits on the
 * `data-status` hook so `styles.css` is the single place colour is assigned
 * (`docs/design/design.md`: status-only colour). `pulse` is for in-flight
 * work — running runs and running steps.
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
    <span data-status={status} className={cn("status-cell", className)}>
      <i className={cn("status-dot", isPulsing(status) && "status-pulse")} aria-hidden="true" />
      <span className="status-label">{label ?? statusLabel(status)}</span>
    </span>
  );
}
