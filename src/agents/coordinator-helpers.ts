// Pure, side-effect-free helpers for the Coordinator pipeline: time-budget racing, self-declared
// source detection and the incomplete-vs-done verdict gate (see docs/ARCHITECTURE.md §4). Kept in
// their own module (no import of "agents") so they can be unit tested with plain Node/vitest without
// pulling in the Durable Object runtime. See src/agents/__tests__/coordinator-helpers.test.ts.
import type { Verdict } from "../shared/types";

// ---------- Time budget ----------

export type BudgetOutcome<T> = { ok: true; value: T } | { ok: false; timedOut: true; label: string };

/**
 * Races `promise` against the remaining time until `deadlineMs` (an absolute epoch-ms time).
 * Resolves `{ ok: false, timedOut: true, label }` if the deadline passes first (including when it has
 * already passed) — never rejects for a timeout. If `promise` rejects before the deadline, that
 * rejection is propagated as-is so callers keep their existing try/catch handling. `promise` itself is
 * never cancelled (JS cannot cancel an in-flight fetch/model call); on timeout its eventual settlement
 * is simply ignored by the caller.
 */
export function withBudget<T>(
  promise: Promise<T>,
  deadlineMs: number,
  label: string,
  now: () => number = Date.now,
): Promise<BudgetOutcome<T>> {
  const remaining = deadlineMs - now();
  if (remaining <= 0) {
    return Promise.resolve({ ok: false, timedOut: true, label });
  }
  return new Promise<BudgetOutcome<T>>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, timedOut: true, label });
    }, remaining);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------- Self-declared source detection ----------

/** Strip accents, lowercase, and remove everything but letters/digits — for comparing brand names to
 * hostnames regardless of punctuation, diacritics or casing (e.g. "Yves Saint Laurent" -> "yvessaintlaurent"). */
export function normalizeBrand(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Brand (normalized via `normalizeBrand`) -> domain patterns whose statements about that brand are
 * never independent evidence. A pattern ending in ".*" matches that label under any TLD/suffix (and
 * any subdomain of it); a plain pattern matches that exact domain or a subdomain of it. */
export const BRAND_DOMAINS: Record<string, string[]> = {
  garnier: ["garnier.*", "lorealparis.*", "loreal.com"],
  yvessaintlaurent: ["yslbeauty.*", "loreal.com"],
  ysl: ["yslbeauty.*", "loreal.com"],
  lush: ["lush.com"],
  weleda: ["weleda.*"],
};

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, "");
}

/** True when `domain` matches `pattern` — an exact/subdomain match for a plain pattern, or a
 * same-label-any-suffix match (including subdomains) for a "label.*" pattern. */
export function domainMatches(domain: string, pattern: string): boolean {
  const d = normalizeDomain(domain);
  const p = pattern.toLowerCase();
  const starIdx = p.indexOf("*");
  if (starIdx === -1) {
    return d === p || d.endsWith(`.${p}`);
  }
  const base = p.slice(0, starIdx).replace(/\.$/, "");
  if (!base) return false;
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^([a-z0-9-]+\\.)*${escapedBase}\\.[a-z0-9.-]+$`, "i");
  return re.test(d);
}

/**
 * True when a source found at `sourceIssuer` cannot count as independent evidence for a claim whose
 * own page is `ownIssuer` and (when identifiable) whose brand is `brand`:
 *  - the source is the claim's own page's domain (or a subdomain of it) — covers the "brand unknown"
 *    fallback too, since that is always a comparison against the claim's own source domain;
 *  - or the source matches a known parent-group/brand domain from `BRAND_DOMAINS` (normalized brand
 *    lookup; strips accents/case/punctuation before comparing).
 */
export function isSelfDeclaredSource(sourceIssuer: string, ownIssuer: string, brand?: string): boolean {
  const source = normalizeDomain(sourceIssuer);
  const own = normalizeDomain(ownIssuer);
  if (source === own || source.endsWith(`.${own}`)) return true;

  if (brand) {
    const patterns = BRAND_DOMAINS[normalizeBrand(brand)];
    if (patterns?.some((p) => domainMatches(source, p))) return true;
  }
  return false;
}

// ---------- Incomplete-vs-done verdict gate (ARCHITECTURE.md §4) ----------

export interface VerdictGateInput {
  ruleVerdict: Verdict;
  /** False when the specialist fell back to an unassessed brand quote after model failure. */
  assessmentComplete?: boolean;
  /** "full" when a web search API was available and confirmed working for this run. */
  searchMode: "full" | "limited";
  /** True when at least one non-self-declared candidate page was successfully fetched for this claim. */
  fetchedIndependentCandidate: boolean;
  /** True when the run's time budget was exhausted before this claim's public evidence search finished. */
  deadlineHit: boolean;
}

export interface VerdictGateResult {
  /** Absent means "leave the claim's verdict undefined" — the investigation stays incomplete for it. */
  verdict: Verdict | undefined;
  /** Present exactly when `verdict` is undefined: a user-readable reason to add to the claim's gaps. */
  gap?: string;
}

/**
 * NOT_PUBLICLY_VERIFIABLE is only a valid outcome after a *completed* bounded search (ARCHITECTURE.md
 * §4). BACKED and VAGUE stand as-is — this gate only ever downgrades a NOT_PUBLICLY_VERIFIABLE rule
 * result to "no verdict yet" when the search behind it wasn't actually completed.
 */
export function gateVerdict(input: VerdictGateInput): VerdictGateResult {
  if (input.ruleVerdict !== "NOT_PUBLICLY_VERIFIABLE") {
    return { verdict: input.ruleVerdict };
  }
  if (input.assessmentComplete === false) {
    return { verdict: undefined, gap: "Fetched sources could not be fully assessed, so verification is incomplete." };
  }
  if (input.searchMode === "limited") {
    return {
      verdict: undefined,
      gap: "Web search is not configured, so the public evidence search was not completed.",
    };
  }
  if (!input.fetchedIndependentCandidate) {
    return { verdict: undefined, gap: "No independent page could be fetched." };
  }
  if (input.deadlineHit) {
    return {
      verdict: undefined,
      gap: "The run reached its time limit before the public evidence search could be completed.",
    };
  }
  return { verdict: "NOT_PUBLICLY_VERIFIABLE" };
}

/** A short, deterministic next action derived only from the verdict — used when there isn't enough
 * time budget left to ask a model to draft one (see `ACTION_RESERVE_MS` in coordinator.ts). */
export function deterministicNextAction(verdict: Verdict | undefined): string {
  switch (verdict) {
    case "BACKED":
      return "Accept the claim as verified for its stated scope.";
    case "VAGUE":
      return "Avoid repeating the broad wording; prefer a narrower, checkable statement.";
    case "NOT_PUBLICLY_VERIFIABLE":
      return "Request the missing evidence from the brand before repeating this claim.";
    default:
      return "This claim could not be checked within the time available; treat it as unverified.";
  }
}

// ---------- Trace-step formatting ----------

export function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** At most the first 4 required items, each truncated to 120 chars, for a step's `detail` field — the
 * full list is always kept separately on `claim.required`. */
export function summarizeRequired(required: string[]): string {
  const shown = required.slice(0, 4).map((r) => truncate(r, 120));
  const more = required.length > 4 ? ` (+${required.length - 4} more)` : "";
  return `${shown.join("; ")}${more}`;
}

// ---------- Duplicate-step guard ----------

export interface StepLike {
  agent: string;
  label: string;
  detail?: string;
  url?: string;
}

/** True when `next` is an exact repeat of `prev` on the fields that matter for the trace (agent, label,
 * detail, url) — used to drop an accidental duplicate push instead of showing the same line twice. */
export function isDuplicateStep(prev: StepLike | undefined, next: StepLike): boolean {
  if (!prev) return false;
  return prev.agent === next.agent && prev.label === next.label && prev.detail === next.detail && prev.url === next.url;
}
