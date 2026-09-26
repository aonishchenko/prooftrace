// Deterministic verdict rules. Pure and side-effect free: no model calls, no I/O. See
// docs/ARCHITECTURE.md §4.
import type { Verdict } from "../shared/types";
import type { Evidence } from "../shared/types";
import type { ExtractedClaim, RuleResult } from "../shared/internal";

/** Broad, unbounded sustainability terms (EN + PT) that do not by themselves establish a checkable
 * claim. Presence of a number or a named standard (see NAMED_STANDARDS below) overrides this list —
 * a term like "natural" next to a stated percentage is not vague. */
export const VAGUE_TERMS: string[] = [
  "sustainable",
  "sustentável",
  "eco-friendly",
  "eco friendly",
  "green",
  "verde",
  "ethical",
  "ethically",
  "ético",
  "ética",
  "eticamente",
  "responsible",
  "responsibly",
  "responsável",
  "natural",
  "clean",
  "conscious",
  "consciente",
  "planet-friendly",
  "planet friendly",
  "amigo do ambiente",
];

// Named certification/standard bodies whose mention bounds an otherwise-vague term.
const NAMED_STANDARDS: string[] = [
  "fairtrade",
  "fair trade",
  "comércio justo",
  "rspo",
  "fsc",
  "forest stewardship council",
  "cosmos",
  "ecocert",
  "leaping bunny",
  "cruelty free international",
  "vegan society",
  "iso 16128",
  "ecobeautyscore",
];

/** Strip diacritics from one UTF-16 code unit, preserving string length (1:1 index alignment). */
function foldChar(ch: string): string {
  const decomposed = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return decomposed.length === 1 ? decomposed : ch;
}

function fold(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += foldChar(s[i]);
  return out.toLowerCase();
}

function containsAny(text: string, terms: string[]): boolean {
  const folded = fold(text);
  return terms.some((term) => folded.includes(fold(term)));
}

function hasNumber(text: string): boolean {
  return /\d/.test(text);
}

/** True when `text` uses a VAGUE_TERM with no bounding number or named standard nearby. */
function isUnboundedVagueText(text: string): boolean {
  if (!containsAny(text, VAGUE_TERMS)) return false;
  if (hasNumber(text)) return false;
  if (containsAny(text, NAMED_STANDARDS)) return false;
  return true;
}

/**
 * Decide a claim's verdict from its evidence. Checks run in this order:
 * "Claim is specific", "Evidence found", "Independent source", "Scope matches", "All required items met".
 *
 * - VAGUE: claim.type is "generic", or claim.type is "sourcing" and its text uses an unbounded
 *   VAGUE_TERM (no number, no named standard).
 * - BACKED: not vague, AND at least one independent, fully-supporting, in-scope piece of evidence,
 *   AND every required item is satisfied by some independent evidence with support "full" or
 *   "partial", AND the caller-supplied `gaps` list is empty (both signals must agree).
 * - otherwise: NOT_PUBLICLY_VERIFIABLE.
 */
export function decideVerdict(claim: ExtractedClaim, required: string[], evidence: Evidence[], gaps: string[]): RuleResult {
  const isVague = claim.type === "generic" || (claim.type === "sourcing" && isUnboundedVagueText(claim.text));

  const hasIndependentEvidence = evidence.some((e) => e.independent);
  const hasStrongAnchor = evidence.some((e) => e.independent && e.supports === "full" && e.scopeMatch);
  const hasIndependentScopeMatch = evidence.some((e) => e.independent && e.scopeMatch);

  const requiredSatisfied = (item: string) =>
    evidence.some(
      (e) => e.independent && (e.supports === "full" || e.supports === "partial") && e.satisfies.includes(item),
    );
  const allRequiredMetByEvidence = required.every(requiredSatisfied);
  const allRequiredMet = allRequiredMetByEvidence && gaps.length === 0;

  const checks: RuleResult["checks"] = [
    { name: "Claim is specific", pass: !isVague },
    { name: "Evidence found", pass: evidence.length > 0 },
    { name: "Independent source", pass: hasIndependentEvidence },
    { name: "Scope matches", pass: hasIndependentScopeMatch },
    { name: "All required items met", pass: allRequiredMet },
  ];

  let verdict: Verdict;
  if (isVague) {
    verdict = "VAGUE";
  } else if (hasStrongAnchor && allRequiredMet) {
    verdict = "BACKED";
  } else {
    verdict = "NOT_PUBLICLY_VERIFIABLE";
  }

  return { verdict, checks };
}
