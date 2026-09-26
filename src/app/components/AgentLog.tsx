import { useEffect, useRef, type ReactNode } from "react";
import type { Step } from "../../shared/types";
import { AGENT_META } from "../agentMeta";
import { elapsed, truncateUrl } from "../format";

function statusIcon(status: Step["status"]): ReactNode {
  switch (status) {
    case "running":
      return <span className="spinner" />;
    case "ok":
      return "✓";
    case "fail":
      return "✕";
    case "info":
      return "•";
    default:
      return null;
  }
}

function statusText(status: Step["status"]): string {
  switch (status) {
    case "running":
      return "running";
    case "ok":
      return "ok";
    case "fail":
      return "failed";
    case "info":
      return "info";
    default:
      return status;
  }
}

function StepRow({ step }: { step: Step }) {
  const meta = AGENT_META[step.agent];
  return (
    <li className="step-row">
      <span className="step-row__time">{elapsed(step.at)}</span>
      <span className="step-row__badge" style={{ backgroundColor: meta?.color }}>
        {meta?.name ?? step.agent}
      </span>
      <span className="step-row__icon" aria-hidden="true">
        {statusIcon(step.status)}
      </span>
      <span className="step-row__body">
        <span className="step-row__label">
          <span className="sr-only">{statusText(step.status)}: </span>
          {step.label}
          {step.url && (
            <a
              className="step-row__url"
              href={step.url}
              target="_blank"
              rel="noreferrer"
              title={step.url}
            >
              {truncateUrl(step.url)}
            </a>
          )}
        </span>
        {step.detail && <span className="step-row__detail">{step.detail}</span>}
      </span>
    </li>
  );
}

/** Auto-scrolls to the newest step while running, unless the user has scrolled up. */
export function AgentLog({ steps, running }: { steps: Step[]; running: boolean }) {
  const containerRef = useRef<HTMLOListElement>(null);
  const stickToBottomRef = useRef(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 24;
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !running || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [steps, running]);

  if (steps.length === 0) {
    return <p className="agent-log__empty">Waiting for the first step…</p>;
  }

  return (
    <ol className="agent-log" aria-live="polite" ref={containerRef} onScroll={handleScroll}>
      {steps.map((step) => (
        <StepRow key={step.id} step={step} />
      ))}
    </ol>
  );
}
