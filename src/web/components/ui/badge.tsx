import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/web/lib/utils";

/**
 * wayful's status pill (`docs/design/design.md`): mono, lowercase, and tinted
 * from the status colour rather than filled with it — 16% fill, 45% border,
 * full-strength text. `neutral` is the achromatic default for anything that
 * is not a status.
 */
const badgeVariants = cva(
  "inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 font-mono text-[11px] leading-none",
  {
    variants: {
      status: {
        neutral: "border-border bg-muted text-muted-foreground",
        complete: "border-status-complete/45 bg-status-complete/15 text-status-complete",
        ready: "border-status-ready/45 bg-status-ready/15 text-status-ready",
        pending: "border-status-pending/45 bg-status-pending/15 text-status-pending",
        blocked: "border-status-blocked/45 bg-status-blocked/15 text-status-blocked",
        cancelled: "border-status-cancelled/45 bg-status-cancelled/15 text-status-cancelled",
      },
    },
    defaultVariants: { status: "neutral" },
  },
);

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, status, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ status }), className)} {...props} />;
}
