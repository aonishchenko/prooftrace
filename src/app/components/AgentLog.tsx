import { useEffect, useRef } from "react";
import type { Step } from "../../shared/types";
import { AGENT_META } from "../agentMeta";
import { elapsed, truncateUrl } from "../format";

function dotContent(step: Step, index: number): string {
  switch (step.status) {
    case "ok":
      return "✓";
    case "fail":
      return "✕";
    case "info":
      return "•";
    default:
      return String(index + 1);
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

function StepRow({ step, index }: { step: Step; index: number }) {
  const meta = AGENT_META[step.agent];
  return (
    <li className={`step step--${step.status}`}>
      <span className="dot" aria-hidden="true">
        {dotContent(step, index)}
      </span>
      <div className="step__body">
        <div className="src">
          <span className="src__agent" style={{ color: meta?.color }}>
            {meta?.name ?? step.agent}
          </span>
          <span className="src__time">{elapsed(step.at)}</span>
        </div>
        <div className="t">
          <span className="sr-only">{statusText(step.status)}: </span>
          {step.label}
        </div>
        {step.detail && <div className="d">{step.detail}</div>}
        {step.url && (
          <a className="step__url" href={step.url} target="_blank" rel="noreferrer" title={step.url}>
            {truncateUrl(step.url.replace(/^https?:\/\//, ""))}
          </a>
        )}
      </div>
    </li>
  );
}

/** Live timeline of agent steps. Auto-scrolls to the newest step while running, unless the user scrolled up. */
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
    return <p className="wait">Waiting for the first step…</p>;
  }

  return (
    <ol className="steps" aria-live="polite" ref={containerRef} onScroll={handleScroll}>
      {steps.map((step, index) => (
        <StepRow key={step.id} step={step} index={index} />
      ))}
    </ol>
  );
}
