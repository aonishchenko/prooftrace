// Contract between the page and the Coordinator agent. The page renders only from `Investigation`.
// See docs/ARCHITECTURE.md §3.

export type Verdict = "BACKED" | "VAGUE" | "NOT_PUBLICLY_VERIFIABLE";
export type RunMode = "live" | "replay";
export type AgentId =
  | "coordinator"
  | "scout"
  | "extractor"
  | "certification"
  | "quantitative"
  | "sourcing"
  | "verdict";
export type ClaimType = "certification" | "quantitative" | "sourcing" | "generic";

export interface Investigation {
  id: string;
  input: { url: string; mode: RunMode };
  status: "idle" | "running" | "done" | "incomplete" | "error";
  steps: Step[];
  claims: ClaimResult[];
  selectedClaimId?: string;
  /** Why the run is incomplete or failed. User-readable only, never raw provider output. */
  error?: string;
  /** "full" when a web search API was available, "limited" when only links and official sources were used. */
  searchMode?: "full" | "limited";
  startedAt?: string; // ISO UTC
  finishedAt?: string; // ISO UTC
}

export interface Step {
  id: string;
  agent: AgentId;
  kind: "fetch" | "extract" | "require" | "search" | "open" | "match" | "gap" | "verdict" | "action" | "info";
  label: string;
  /** Evidence summary or short rationale. Never hidden chain-of-thought. */
  detail?: string;
  status: "running" | "ok" | "fail" | "info";
  url?: string;
  claimId?: string;
  at: number; // ms since run start
}

export interface Evidence {
  url: string;
  issuer: string;
  /** Verified substring of a fetched source page. */
  quote: string;
  retrievedAt: string; // ISO UTC
  cached: boolean;
  independent: boolean;
  supports: "full" | "partial" | "none";
  scopeMatch: boolean;
  /** Which `required` items this evidence satisfies (exact strings from ClaimResult.required). */
  satisfies: string[];
}

export type CheckedUrlStatus = "fetched" | "blocked" | "timeout" | "skipped";

export interface ClaimResult {
  claimId: string;
  /** Exact substring of the page it was found on. */
  text: string;
  sourceUrl: string;
  type: ClaimType;
  required: string[];
  evidence: Evidence[];
  gaps: string[];
  checkedUrls: { url: string; status: CheckedUrlStatus; reason?: string }[];
  checks?: { name: string; pass: boolean }[];
  /** Absent when the investigation is incomplete for this claim. */
  verdict?: Verdict;
  rewrite?: string;
  nextAction?: string;
  /** Draft only, never sent. */
  evidenceRequest?: string;
}

/** Input to Coordinator.investigate(). */
export interface InvestigateInput {
  url: string;
  mode?: RunMode;
}
