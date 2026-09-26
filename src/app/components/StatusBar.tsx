import { useEffect, useState } from "react";
import type { Investigation } from "../../shared/types";
import { secondsSince } from "../format";

/** Must match the Coordinator's run cap; drives the progress line. */
const RUN_CAP_SECONDS = 120;

function statusLabel(status: Investigation["status"]): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "running":
      return "Investigating…";
    case "done":
      return "Done";
    case "incomplete":
      return "Incomplete";
    case "error":
      return "Error";
    default:
      return status;
  }
}

/** Ticks every 500ms while the investigation is running, otherwise stays still. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function StatusBar({ investigation }: { investigation: Investigation }) {
  const running = investigation.status === "running";
  const now = useNow(running);
  const startedMs = investigation.startedAt ? new Date(investigation.startedAt).getTime() : now;
  const endMs = running
    ? now
    : investigation.finishedAt
      ? new Date(investigation.finishedAt).getTime()
      : now;
  const seconds = secondsSince(startedMs, endMs);
  const progress = running ? Math.min(100, (seconds / RUN_CAP_SECONDS) * 100) : 100;

  return (
    <div className="status-bar" role="status">
      <div className="meta">
        <span className={`status-bar__state status-bar__state--${investigation.status}`}>
          {statusLabel(investigation.status)}
        </span>
        <span>{seconds}s</span>
        {investigation.searchMode === "limited" && (
          <span>Limited search: links on the page and known official sources only</span>
        )}
      </div>
      <div className="prog" aria-hidden="true">
        <i style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}
