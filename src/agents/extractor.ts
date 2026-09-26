// Claim extraction: Kimi K2.6 finds sustainability claims on a fetched page; code verifies every
// quote against the actual page text before it is trusted. See docs/ARCHITECTURE.md §1 step "Extract
// claims" and §2.
import { z } from "zod";
import type { ExtractedClaim, FetchedPage } from "../shared/internal";
import { callJson } from "./models";
import { findExact, selectPassages } from "./quotes";

const MAX_PROMPT_CHARS = 40_000;
const DEFAULT_MAX_CLAIMS = 5;

// English + Portuguese keywords used only to pick relevant passages when a page is too long to
// send in full; the model itself still receives verbatim text, never a translation or summary.
const SUSTAINABILITY_KEYWORDS = [
  "sustainable", "sustentável", "sustentavel", "sustentabilidade",
  "eco-friendly", "eco", "green", "verde",
  "ethical", "ethically", "ético", "ética", "eticamente",
  "responsible", "responsibly", "responsável",
  "natural", "clean", "conscious", "consciente",
  "planet-friendly", "amigo do ambiente", "amigo do planeta",
  "recycled", "reciclado", "reciclada", "recyclable", "reciclável",
  "refill", "recarga", "recarregável",
  "carbon", "carbono", "footprint", "pegada",
  "vegan", "vegano", "vegana",
  "cruelty free", "cruelty-free", "crueldade", "testado em animais", "tested on animals",
  "certified", "certificado", "certificação", "certification",
  "fair trade", "fairtrade", "comércio justo",
  "organic", "orgânico", "biológico",
  "biodegradable", "biodegradável",
  "origem natural", "natural origin", "iso 16128",
  "impacto ambiental", "environmental impact",
];

const ExtractedClaimTypeSchema = z.enum(["certification", "quantitative", "sourcing", "generic"]);

const RawClaimSchema = z.object({
  claims: z
    .array(
      z.object({
        text: z.string(),
        type: ExtractedClaimTypeSchema,
        brand: z.string().optional(),
        language: z.string().optional(),
      }),
    )
    .max(20),
});

const TYPE_PRIORITY: Record<string, number> = {
  certification: 0,
  quantitative: 1,
  sourcing: 2,
  generic: 3,
};

// The model sometimes returns navigation labels or product names as "generic" claims. Requiring
// an actual sustainability assertion keeps those labels from preventing linked-page discovery.
export function isSubstantiveClaim(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const sustainabilityTerm = /sustent|environment|ambient|ecol[oó]g|green|recycl|recicl|reutiliz|refill|recarga|carbon|pegada|vegan|vegano|vegana|vega\*|cruelty|crueldade|animais|animal.test|certific|biodegrad|org[aâ]nic|biol[oó]gic|origem natural|natural origin|fonte renov[aá]vel|renewable|ethical|[ée]tic|respons[aá]vel|eco.?beauty.?score/i;
  if (!sustainabilityTerm.test(text)) return false;
  if (words.length >= 4) return true;
  return words.length >= 2 && /\d+\s*%/.test(text);
}

/** Catch exact, measurable sustainability lines missed by the model (including attached footnotes). */
export function numericClaimCandidates(pageText: string): string[] {
  return pageText.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 20 && line.length <= 300 && /\d+\s*%/.test(line) && isSubstantiveClaim(line))
    .slice(0, 8);
}

/** Exact-text safety net when hosted extraction is unavailable or exceeds its stage budget. */
export function fallbackExtractClaims(page: FetchedPage, max = DEFAULT_MAX_CLAIMS): ExtractedClaim[] {
  const brand = page.title.split(/\s+[|–—-]\s+/).at(-1)?.trim();
  const numeric = numericClaimCandidates(page.text).map((text) => ({ text, type: "quantitative" as const }));
  const generic = page.text.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 60 && line.length <= 300 && !/\d+\s*%/.test(line))
    .filter((line) => isSubstantiveClaim(line) && /\b(?:acreditamos|compromet|reduz|reduzir|melhor|sustent[aá]vel|environmental|ecol[oó]gic|recicl|renewable)\b/i.test(line))
    .slice(0, 2)
    .map((text) => ({ text, type: "generic" as const }));
  return [...numeric, ...generic].slice(0, max).map((claim, index) => ({
    claimId: `c${index + 1}`,
    ...claim,
    brand: brand && brand.length <= 40 ? brand : undefined,
  }));
}

function buildPromptText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const passages = selectPassages(text, SUSTAINABILITY_KEYWORDS, { max: 30, window: 2500 });
  let combined = passages.join("\n---\n");
  if (combined.length > maxChars) combined = combined.slice(0, maxChars);

  // Sparse or no keyword coverage: fall back to a plain leading slice within budget rather than
  // sending the model a handful of short, possibly irrelevant windows.
  if (combined.length < maxChars * 0.5) {
    combined = text.slice(0, maxChars);
  }
  return combined;
}

const SYSTEM_PROMPT = [
  "You extract sustainability claims from the text of one fetched web page for ProofTrace, a claim-verification tool.",
  "Find claims about: environmental impact, animal welfare or cruelty-free status, vegan status, ingredient or material sourcing/ethics, recycled or recyclable packaging, natural-origin percentage or composition, refill programs, carbon/footprint claims, and broad terms such as \"sustainable\" or \"eco-friendly\".",
  "Ignore pure product-efficacy or cosmetic-effect claims (for example \"hydrates for 48h\", \"reduces the appearance of dark spots\"), prices, product names, slogans, section headings, and site navigation text.",
  "Prioritize specific, measurable sustainability assertions (especially percentages), followed by concrete certifications and sourcing statements. Quote the full assertion, not an isolated program name or heading.",
  "Quote each claim EXACTLY as it appears on the page: no translation, no paraphrase, no fixing spelling or spacing. Use the shortest self-contained sentence or phrase that carries the claim, including any attached footnote marker (for example a trailing \"*\" or number).",
  "The page text may be written in Portuguese or another non-English language. Read and quote it as written; do not translate it. Report the claim's language as an ISO 639-1 code (e.g. \"en\", \"pt\") when identifiable.",
  "Classify each claim's type: \"certification\" when it names a certifier, approval or label; \"quantitative\" when it states a percentage or number about environmental impact or composition; \"sourcing\" when it describes where or how ingredients/materials are sourced (e.g. \"ethically sourced\"); \"generic\" for a broad, unbounded sustainability term with no certifier, number, or sourcing detail.",
  "Report the brand the claim is about if it is identifiable from the page.",
  "Return every distinct sustainability claim you find, in the order they appear on the page. If there are none, return an empty list. Respond only with the required JSON.",
].join("\n");

function buildUserPrompt(page: FetchedPage): string {
  const promptText = buildPromptText(page.text, MAX_PROMPT_CHARS);
  return [`URL: ${page.finalUrl}`, `Title: ${page.title}`, "", "Page text:", promptText].join("\n");
}

/**
 * Extract sustainability claims from a fetched page. Every returned claim's `text` is a verified
 * exact substring of `page.text`; claims whose quote cannot be found verbatim are dropped. Returns
 * `[]` when no sustainability claims are found (not an error).
 *
 * Runs in the Coordinator, so a `ModelError` (e.g. "Not enough time left for the extractor model.")
 * is allowed to throw — the Coordinator already treats claim extraction failures as catchable.
 */
export async function extractClaims(
  env: Env,
  page: FetchedPage,
  opts?: { max?: number; deadlineMs?: number },
): Promise<ExtractedClaim[]> {
  const max = opts?.max ?? DEFAULT_MAX_CLAIMS;

  const raw = await callJson(env, "extractor", {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(page),
    schema: RawClaimSchema,
    schemaName: "extracted_claims",
    deadlineMs: opts?.deadlineMs,
    overrides: { timeoutMs: 30000 },
  });

  const seen = new Set<string>();
  const verified: ExtractedClaim[] = [];

  for (const claim of raw.claims) {
    const actual = findExact(page.text, claim.text);
    if (!actual) continue;
    if (!isSubstantiveClaim(actual)) continue;

    const dedupeKey = actual.trim();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    verified.push({
      claimId: "", // assigned after final ordering
      text: actual,
      type: claim.type,
      brand: claim.brand?.trim() || undefined,
      language: claim.language?.trim() || undefined,
    });
  }

  for (const text of numericClaimCandidates(page.text)) {
    if (seen.has(text)) continue;
    seen.add(text);
    verified.push({ claimId: "", text, type: "quantitative", brand: raw.claims[0]?.brand?.trim() || undefined });
  }

  verified.sort((a, b) => (TYPE_PRIORITY[a.type] ?? 4) - (TYPE_PRIORITY[b.type] ?? 4));

  return verified.slice(0, max).map((claim, index) => ({ ...claim, claimId: `c${index + 1}` }));
}
