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
  "Ignore pure product-efficacy or cosmetic-effect claims (for example \"hydrates for 48h\", \"reduces the appearance of dark spots\"), prices, and site navigation text.",
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
 */
export async function extractClaims(env: Env, page: FetchedPage, opts?: { max?: number }): Promise<ExtractedClaim[]> {
  const max = opts?.max ?? DEFAULT_MAX_CLAIMS;

  const raw = await callJson(env, "extractor", {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(page),
    schema: RawClaimSchema,
    schemaName: "extracted_claims",
  });

  const seen = new Set<string>();
  const verified: ExtractedClaim[] = [];

  for (const claim of raw.claims) {
    const actual = findExact(page.text, claim.text);
    if (!actual) continue;

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

  verified.sort((a, b) => (TYPE_PRIORITY[a.type] ?? 4) - (TYPE_PRIORITY[b.type] ?? 4));

  return verified.slice(0, max).map((claim, index) => ({ ...claim, claimId: `c${index + 1}` }));
}
