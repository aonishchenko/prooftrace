import { useEffect, useState } from "react";
import type { Investigation } from "../../shared/types";
import { secondsSince } from "../format";

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

  return (
    <div className="status-bar" role="status">
      <span className="status-bar__elapsed">{seconds}s</span>
      <span className="status-bar__text">{statusLabel(investigation.status)}</span>
      {investigation.searchMode === "limited" && (
        <span className="status-bar__note">
          Limited search: links on the page and known official sources only
        </span>
      )}
    </div>
  );
}
