// Deterministic verdict rules. Pure and side-effect free: no model calls, no I/O. See
// docs/ARCHITECTURE.md §4.
import type { Verdict } from "../shared/types";
import type { Evidence } from "../shared/types";
import type { ExtractedClaim, RuleResult } from "../shared/internal";

/** Broad, unbounded sustainability terms (EN + PT) that do not by themselves establish a checkable
 * claim. Presence of a bounding quantity or a named standard (see NAMED_STANDARDS below) overrides
 * this list — a term like "natural" next to a stated percentage is not vague. Matched whole-word
 * only (accent-folded), so "ética" does not match inside "cosmética", "green" does not match inside
 * "greenhouse", and "clean" does not match inside "cleanser". */
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

// Units that turn an adjacent number into a real, bounding quantity rather than a bare digit.
const QUANTITY_WORD_UNITS: string[] = [
  "ml",
  "mL",
  "l",
  "L",
  "kg",
  "g",
  "cl",
  "cm",
  "mm",
  "km",
  "oz",
  "litros",
  "litro",
  "litres",
  "litre",
  "gramas",
  "grama",
  "grams",
  "gram",
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case- and accent-insensitive search for any of `terms` inside `text`. Uses lookaround
 * instead of `\b` because `\b` treats accented letters as non-word characters, which would wrongly
 * open a word boundary in the middle of an accented word; folding first and matching on ASCII avoids
 * that entirely. The boundary only excludes adjacent LETTERS (not digits or punctuation), so a term
 * immediately followed by a footnote-style marker (a trailing "*" or a glued digit like "natural1")
 * still counts as that whole word — only another letter (as in "greenhouse" or "cosmética") blocks it. */
function containsWholeWordAny(text: string, terms: string[]): boolean {
  const folded = fold(text);
  return terms.some((term) => {
    const foldedTerm = fold(term);
    if (!foldedTerm) return false;
    const pattern = `(?<![a-z])${escapeRegExp(foldedTerm)}(?![a-z])`;
    return new RegExp(pattern, "i").test(folded);
  });
}

/**
 * True when `text` contains a real bounding quantity: a number attached to a percent sign or a unit
 * (e.g. "97%", "58%*", "50 ml", "50ml"). A bare digit run with no unit/percent — including a
 * footnote-style marker glued to a word (e.g. a trailing "*" or a superscript-like digit) — does not
 * count, so a footnote reference is never mistaken for "the claim has a number".
 */
function hasQuantity(text: string): boolean {
  if (/\d+(?:[.,]\d+)?\s*%/.test(text)) return true;
  const unitPattern = new RegExp(`\\d+(?:[.,]\\d+)?\\s*(?:${QUANTITY_WORD_UNITS.map(escapeRegExp).join("|")})(?![a-zA-Z])`);
  return unitPattern.test(text);
}

/** True when a real quantity or a named standard bounds the claim text, regardless of claim type. */
function isBounded(text: string): boolean {
  return hasQuantity(text) || containsWholeWordAny(text, NAMED_STANDARDS);
}

/**
 * True when the claim uses broad, unbounded sustainability wording with nothing to check it against.
 * - A "generic" claim (by definition a broad term with no certifier, number or sourcing detail) is
 *   vague unless its text turns out to carry a real quantity or a named standard.
 * - Any other claim type is vague only when its text uses an unbounded VAGUE_TERM (whole-word,
 *   accent-folded) with no bounding quantity or named standard.
 */
function isClaimVague(claim: ExtractedClaim): boolean {
  if (isBounded(claim.text)) return false;
  if (claim.type === "generic") return true;
  return containsWholeWordAny(claim.text, VAGUE_TERMS);
}

/**
 * True only when `e` is independent, in scope, AND fully supports the claim. Partial support may be
 * shown to the user, but it never counts toward satisfying a required item for BACKED — this is the
 * one predicate rules.ts and specialist-base.ts both use, so gaps and verdict always agree.
 */
export function satisfiesRequirement(e: Evidence): boolean {
  return e.independent && e.scopeMatch && e.supports === "full";
}

/** Required items with no evidence that satisfies them (see `satisfiesRequirement`). */
export function unmetRequired(required: string[], evidence: Evidence[]): string[] {
  return required.filter((item) => !evidence.some((e) => satisfiesRequirement(e) && e.satisfies.includes(item)));
}

/**
 * Decide a claim's verdict from its evidence. Checks run in this order:
 * "Claim is specific", "Evidence found", "Independent source", "Scope matches", "All required items met".
 *
 * - VAGUE: see `isClaimVague`.
 * - BACKED: not vague, AND `required` is non-empty (an empty required list can never be BACKED — there
 *   is nothing to have verified), AND every required item is satisfied per `satisfiesRequirement`, AND
 *   the caller-supplied `gaps` list is empty (both signals must agree).
 * - otherwise: NOT_PUBLICLY_VERIFIABLE.
 */
export function decideVerdict(claim: ExtractedClaim, required: string[], evidence: Evidence[], gaps: string[]): RuleResult {
  const isVague = isClaimVague(claim);

  const hasIndependentEvidence = evidence.some((e) => e.independent);
  const hasStrongAnchor = evidence.some((e) => satisfiesRequirement(e));
  const hasIndependentScopeMatch = evidence.some((e) => e.independent && e.scopeMatch);

  const unmet = unmetRequired(required, evidence);
  const allRequiredMetByEvidence = required.length > 0 && unmet.length === 0;
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
  } else if (required.length > 0 && hasStrongAnchor && allRequiredMet) {
    verdict = "BACKED";
  } else {
    verdict = "NOT_PUBLICLY_VERIFIABLE";
  }

  return { verdict, checks };
}
