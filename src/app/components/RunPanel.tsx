import type { Investigation } from "../../shared/types";
import { truncateUrl } from "../format";
import { AgentLog } from "./AgentLog";
import { Report } from "./Report";
import { StatusBar } from "./StatusBar";

interface RunPanelProps {
  investigation: Investigation | null;
  connectionError?: string | null;
  onRetryConnection?: () => void;
}

/** Two-column work area: live agent log on the left, result card on the right. */
export function RunPanel({ investigation, connectionError, onRetryConnection }: RunPanelProps) {
  if (connectionError) {
    return (
      <div className="work">
        <div className="connection-error" role="alert">
          <p>{connectionError}</p>
          {onRetryConnection && (
            <button type="button" className="textlink" onClick={onRetryConnection}>
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!investigation) {
    return (
      <div className="work">
        <p className="wait">Connecting to the agents…</p>
      </div>
    );
  }

  const finished = investigation.status !== "running" && investigation.status !== "idle";

  return (
    <div className="work">
      <section aria-label="Agent log" className="work__log">
        <p className="lbl">Page</p>
        <p className="serif claimq">
          <a href={investigation.input.url} target="_blank" rel="noreferrer" title={investigation.input.url}>
            {truncateUrl(investigation.input.url.replace(/^https?:\/\//, ""), 48)}
          </a>
        </p>
        <StatusBar investigation={investigation} />
        <p className="lbl log-title">Agent log</p>
        <AgentLog steps={investigation.steps} running={investigation.status === "running"} />
      </section>
      <section className="result" aria-live="polite">
        {finished ? (
          <Report investigation={investigation} />
        ) : (
          <p className="wait">Looking for the proof… The report appears here when the agents finish.</p>
        )}
      </section>
    </div>
  );
}
