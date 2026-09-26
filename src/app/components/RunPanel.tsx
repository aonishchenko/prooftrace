import type { Investigation } from "../../shared/types";
import { AgentLog } from "./AgentLog";
import { Report } from "./Report";
import { StatusBar } from "./StatusBar";

interface RunPanelProps {
  investigation: Investigation | null;
  connectionError?: string | null;
  onRetryConnection?: () => void;
}

/** Presentational shell: status bar, live agent log, and final report. */
export function RunPanel({ investigation, connectionError, onRetryConnection }: RunPanelProps) {
  if (connectionError) {
    return (
      <div className="run-panel">
        <div className="connection-error" role="alert">
          <p>{connectionError}</p>
          {onRetryConnection && (
            <button type="button" className="button button--secondary" onClick={onRetryConnection}>
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!investigation) {
    return <p className="run-panel__connecting">Connecting…</p>;
  }

  return (
    <div className="run-panel">
      <StatusBar investigation={investigation} />
      <AgentLog steps={investigation.steps} running={investigation.status === "running"} />
      <Report investigation={investigation} />
    </div>
  );
}
