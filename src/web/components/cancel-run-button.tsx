import { useEffect, useRef, useState } from "react";
import { Square } from "lucide-react";
import { Button } from "@/web/components/ui/button";
import { useCancelRun } from "@/web/hooks";
import { cn } from "@/web/lib/utils";

const ARMED_TIMEOUT_MS = 4_000;

/**
 * The cancel affordance (D33's watching story needs an off switch, and the
 * phase 3 `POST /api/runs/:id/cancel` endpoint finally gets a client). Two
 * clicks to confirm — the first arms the button, a short window follows to
 * confirm or let it disarm — because an accidental cancel of a real run is a
 * cost the run's owner pays for. Mono, achromatic; only the armed state text
 * changes.
 */
export function CancelRunButton({
  runId,
  className,
}: {
  readonly runId: string;
  readonly className?: string;
}) {
  const cancelMutation = useCancelRun();
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (!armed) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setArmed(false), ARMED_TIMEOUT_MS);
  }, [armed]);

  return (
    <span className={cn("inline-flex flex-col items-start gap-1", className)}>
      <Button
        variant={armed ? "default" : "outline"}
        size="sm"
        data-testid={armed ? "confirm-cancel" : "cancel-run"}
        aria-pressed={armed}
        disabled={cancelMutation.isPending}
        onClick={(event) => {
          event.stopPropagation();
          if (!armed) {
            setArmed(true);
            return;
          }
          clearTimeout(timer.current);
          setArmed(false);
          cancelMutation.mutate(runId, { onSettled: () => setArmed(false) });
        }}
        className="font-mono text-[11px]"
      >
        <Square className={cn(armed && "fill-current")} />
        {armed ? "confirm cancel" : "cancel"}
      </Button>
      {cancelMutation.isError ? (
        <span
          data-testid="cancel-error"
          role="alert"
          className="font-mono text-[11px] break-words text-status-blocked"
        >
          cancel failed:{" "}
          {cancelMutation.error instanceof Error
            ? cancelMutation.error.message
            : String(cancelMutation.error)}
        </span>
      ) : null}
    </span>
  );
}
