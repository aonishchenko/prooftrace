// Internal contracts between Worker modules. Each module is owned by one builder; code only against these types.
import type { AgentId, CheckedUrlStatus, ClaimType, Evidence, Verdict } from "./types";

// ---------- Evidence Scout (src/agents/evidence-scout.ts) ----------

export interface PageLink {
  url: string; // absolute
  text: string; // anchor text, trimmed, may be ""
}

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  httpStatus: number;
  method: "fetch" | "browser" | "cache";
  title: string;
  /** Readable text (markdown or stripped HTML), whitespace-normalised, capped at MAX_PAGE_CHARS. */
  text: string;
  links: PageLink[];
  fetchedAt: string; // ISO UTC of the original retrieval
  cached: boolean;
  contentHash: string; // sha-256 hex of text
  /** Registrable-ish hostname of finalUrl, e.g. "garnier.pt", "crueltyfreeinternational.org". */
  issuer: string;
}

export type FetchOutcome =
  | { ok: true; page: FetchedPage }
  | { ok: false; url: string; status: Exclude<CheckedUrlStatus, "fetched">; reason: string };

export interface SearchHit {
  url: string;
  title: string;
  snippet: string; // unverified, never evidence
  source: "search" | "official" | "link";
}

/** Emitted for every search or fetch attempt so the Coordinator can trace it and D1 can audit it. */
export interface ScoutAttempt {
  kind: "search" | "fetch";
  target: string; // query or URL
  status: "ok" | "blocked" | "timeout" | "skipped" | "error" | "unavailable";
  reason?: string;
  method?: FetchedPage["method"];
  resultCount?: number;
  ms: number;
}

export interface EvidenceScout {
  /** Validates the URL (SSRF rules), tries Worker fetch, falls back to Browser Run markdown + links. */
  fetchPage(url: string, opts?: { allowCache?: boolean; timeoutMs?: number }): Promise<FetchOutcome>;
  /** Web search for candidate URLs. `available=false` when no search provider is configured. */
  searchWeb(query: string): Promise<{ available: boolean; hits: SearchHit[] }>;
  /** Candidate URLs from the D1 official_sources directory for a claim (e.g. certifier listing for a brand). */
  officialCandidates(claim: { text: string; type: ClaimType }, brand: string | undefined): Promise<SearchHit[]>;
  /** Same-site links on a page ranked by how likely they hold sustainability claims or evidence. */
  rankLinks(page: FetchedPage, keywords: string[], limit: number): PageLink[];
}

export interface ScoutOptions {
  investigationId: string;
  onAttempt: (a: ScoutAttempt) => void;
}

// ---------- Models & agent logic (src/agents/models.ts, extractor.ts, rules.ts, action.ts, specialists) ----------

export interface ExtractedClaim {
  claimId: string;
  text: string; // exact substring of page.text (verified in code)
  type: ClaimType;
  brand?: string; // brand the claim is about, if stated
  language?: string; // ISO 639-1 of the claim text, e.g. "pt"
}

/** A trimmed view of a fetched page passed to a specialist for judgement. */
export interface SourceExcerpt {
  url: string;
  issuer: string;
  title: string;
  retrievedAt: string;
  cached: boolean;
  /** True when the source is published by the claim's own brand or its parent group (never independent). Set by the Coordinator. */
  selfDeclared: boolean;
  /** Passages from the page text, each an exact substring of it. */
  passages: string[];
}

export interface EvidencePlan {
  required: string[]; // 2-5 concrete items
  queries: string[]; // 1-3 web search queries
  preferredIssuers: string[]; // domains or organisation names worth opening first
}

export interface EvidenceDraft extends Omit<Evidence, "retrievedAt" | "cached"> {}

export interface Assessment {
  evidence: Evidence[]; // quotes already verified against SourceExcerpt passages
  gaps: string[];
  incomplete?: boolean; // model fallback: fetched pages were not fully assessed
}

/** RPC surface of each specialist Durable Object (Certification, Quantitative, Sourcing). */
/**
 * Errors thrown inside a Durable Object lose their subclass and fields across RPC, so specialists return
 * failures as values. `userMessage` is safe to show in the UI.
 */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; userMessage: string };

/**
 * `deadlineMs` is an absolute epoch-ms time. Model calls must finish (including retries/fallback) before it;
 * when too little time is left the specialist returns { ok:false } instead of starting a call.
 */
export interface SpecialistRpc {
  plan(claim: ExtractedClaim, pageUrl: string, deadlineMs: number): Promise<RpcResult<EvidencePlan>>;
  assess(
    claim: ExtractedClaim,
    required: string[],
    sources: SourceExcerpt[],
    deadlineMs: number,
  ): Promise<RpcResult<Assessment>>;
}

export interface RuleResult {
  verdict: Verdict;
  checks: { name: string; pass: boolean }[];
}

export interface ActionResult {
  rewrite?: string;
  nextAction: string;
  evidenceRequest?: string;
}

export type SpecialistId = Extract<AgentId, "certification" | "quantitative" | "sourcing">;
