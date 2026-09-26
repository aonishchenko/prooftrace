// Pure evidence-reconciliation logic for the specialist Durable Objects, extracted out of
// specialist-base.ts so it can be unit tested in plain Node: specialist-base.ts extends the
// Cloudflare Agents SDK's `Agent` class, whose module graph reaches into a `cloudflare:workers`
// virtual module that only exists inside a workerd runtime (see vitest.config.ts — unit tests run in
// plain Node). This module has no such import and is safe to load anywhere.
import type { Evidence } from "../shared/types";
import type { Assessment, SourceExcerpt, SpecialistId } from "../shared/internal";
import { findExact } from "./quotes";
import { unmetRequired } from "./rules";

/** Shape of one piece of evidence as the model reports it, before verification/reconciliation. */
export interface RawAssessedEvidenceItem {
  url: string;
  quote: string;
  supports: "full" | "partial" | "none";
  scopeMatch: boolean;
  independent: boolean;
  /** Exact required-item text, a case/whitespace-insensitive near match of it, or a 1-based index
   * (as a number or a numeric string) — see `resolveSatisfies`. */
  satisfies: Array<string | number>;
}

export interface RawAssessment {
  evidence: RawAssessedEvidenceItem[];
  gaps: string[];
}

/** A required-item list a specialist falls back to when the model's plan() returns none at all
 * (rules.ts never lets an empty `required` list reach BACKED, but a specialist should still give the
 * Coordinator something concrete to search for and show). */
export const DEFAULT_REQUIRED: Record<SpecialistId, string[]> = {
  certification: [
    "Certifier register listing naming the brand",
    "Certification scope covering the claim (brand, product line, or region)",
  ],
  quantitative: ["Baseline used for the stated figure", "Underlying data or method needed to reproduce the number"],
  sourcing: [
    "Named standard or certification bounding the sourcing claim",
    "Share of ingredients or materials actually covered",
  ],
};

/** Minimum length ProofTrace will show as evidence. A shorter "quote" is either a fragment with no
 * standalone meaning or a model paraphrase that happened to line up with a few words of real text. */
const MIN_QUOTE_CHARS = 25;
const MIN_QUOTE_WORDS = 4;

export function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const trimmed = v.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function isQuoteLongEnough(quote: string): boolean {
  const trimmed = quote.trim();
  if (trimmed.length < MIN_QUOTE_CHARS) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length >= MIN_QUOTE_WORDS;
}

function normalizeForMatch(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Map a model's raw `satisfies` entries to the exact `required` strings they refer to. A model may
 * report a required item as its exact text, a case/whitespace-insensitive near match of that text, or
 * its 1-based index (as a number, or a numeric string like "1"). Anything that resolves to none of
 * `required` is dropped rather than guessed at.
 */
export function resolveSatisfies(rawSatisfies: Array<string | number>, required: string[]): string[] {
  const byNormalizedText = new Map(required.map((r) => [normalizeForMatch(r), r]));
  const out: string[] = [];

  for (const entry of rawSatisfies) {
    if (typeof entry === "number") {
      const idx = Math.trunc(entry) - 1;
      if (idx >= 0 && idx < required.length) out.push(required[idx]);
      continue;
    }

    const trimmed = entry.trim();
    if (/^\d+$/.test(trimmed)) {
      const idx = Number(trimmed) - 1;
      if (idx >= 0 && idx < required.length) {
        out.push(required[idx]);
        continue;
      }
    }

    const match = byNormalizedText.get(normalizeForMatch(trimmed));
    if (match) out.push(match);
  }

  return dedupeStrings(out);
}

/** Keep only model-reported evidence that is actually grounded in the given sources and long enough
 * to be a real quote, then compute gaps deterministically with the same predicate rules.ts uses for
 * the verdict, so gaps and verdict always agree. Never trusts a model's url or quote without
 * verifying it here. Pure (no I/O) so it can be unit tested directly. */
export function reconcileAssessment(raw: RawAssessment, required: string[], sources: SourceExcerpt[]): Assessment {
  const sourceByUrl = new Map(sources.map((s) => [s.url, s]));
  const evidence: Evidence[] = [];

  for (const item of raw.evidence) {
    const source = sourceByUrl.get(item.url);
    if (!source) continue; // url must be one of the sources we actually gave it

    let matchedQuote: string | null = null;
    for (const passage of source.passages) {
      const found = findExact(passage, item.quote);
      if (found) {
        matchedQuote = found;
        break;
      }
    }
    if (!matchedQuote) continue; // drop evidence whose quote isn't verifiable in a given passage
    if (!isQuoteLongEnough(matchedQuote)) continue; // drop fragments too short to stand as a real quote
    if (item.supports === "none") continue; // a source with no support is a checked source, not evidence

    const satisfies = resolveSatisfies(item.satisfies, required);

    evidence.push({
      url: source.url,
      issuer: source.issuer,
      quote: matchedQuote,
      retrievedAt: source.retrievedAt,
      cached: source.cached,
      independent: source.selfDeclared ? false : item.independent,
      supports: item.supports,
      scopeMatch: item.scopeMatch,
      satisfies,
    });
  }

  const unmet = unmetRequired(required, evidence);
  let gaps = unmet;

  // A NOT_PUBLICLY_VERIFIABLE claim must show at least one gap. `unmet` already covers every case
  // where a required item lacks satisfying evidence; the only remaining way to reach
  // NOT_PUBLICLY_VERIFIABLE with an empty gap list is when there is no independent evidence at all
  // (which fails the "Independent source" check) — name that explicitly instead of showing nothing.
  if (gaps.length === 0 && !evidence.some((e) => e.independent)) {
    gaps = ["No independent source found in the pages checked"];
  }

  return { evidence, gaps };
}
