// Inline SVG icons from the studio design reference (prooftrace-studio.html).
// Verdicts and evidence states always pair an icon with text, never colour alone.
import type { Verdict } from "../../shared/types";

export function TickMark() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="currentColor" />
      <path d="M5.8 10.4l2.7 2.7 5.7-5.9" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function VerdictIcon({ verdict }: { verdict?: Verdict }) {
  switch (verdict) {
    case "BACKED":
      return (
        <svg viewBox="0 0 40 40" aria-hidden="true">
          <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" strokeWidth="2.6" />
          <path d="M12 20.5l5.5 5.5L28.5 14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "VAGUE":
      return (
        <svg viewBox="0 0 40 40" aria-hidden="true">
          <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" strokeWidth="2.6" />
          <path d="M12 17c3-3 5 3 8 0s5-3 8 0M12 24c3-3 5 3 8 0s5-3 8 0" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      );
    case "NOT_PUBLICLY_VERIFIABLE":
      return (
        <svg viewBox="0 0 40 40" aria-hidden="true">
          <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" strokeWidth="2.6" strokeDasharray="5 4" />
          <path d="M14 18h12v9H14zM16.5 18v-2.5a3.5 3.5 0 017 0V18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 40 40" aria-hidden="true">
          <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" strokeWidth="2.6" strokeDasharray="2 5" />
          <path d="M14 20h12" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      );
  }
}

export type EvidenceState = "found" | "partial" | "not_found";

export function EvidenceIcon({ state }: { state: EvidenceState }) {
  if (state === "found") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M6 10.3l2.8 2.8L14.2 7.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (state === "partial") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M10 1.5a8.5 8.5 0 010 17z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 3" />
    </svg>
  );
}
