// Shared behaviour for the three specialist Durable Objects (Certification, Quantitative, Sourcing).
// Each concrete specialist supplies only its `role` and specialty `knowledge` text; this base class
// owns prompt shape, the model call, and the code-side reconciliation that turns a model's judgement
// into evidence ProofTrace can trust (never a raw model quote or url without verification).
import { Agent } from "agents";
import { z } from "zod";
import type { Evidence } from "../shared/types";
import type { Assessment, EvidencePlan, ExtractedClaim, SourceExcerpt, SpecialistId, SpecialistRpc } from "../shared/internal";
import { callJson } from "./models";
import { findExact } from "./quotes";

const PlanRawSchema = z.object({
  required: z.array(z.string()),
  queries: z.array(z.string()),
  preferredIssuers: z.array(z.string()).optional(),
});

const AssessRawSchema = z.object({
  evidence: z.array(
    z.object({
      url: z.string(),
      quote: z.string(),
      supports: z.enum(["full", "partial", "none"]),
      scopeMatch: z.boolean(),
      independent: z.boolean(),
      satisfies: z.array(z.string()),
    }),
  ),
  gaps: z.array(z.string()),
});

type AssessRaw = z.infer<typeof AssessRawSchema>;

function dedupeStrings(values: string[]): string[] {
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

function buildPlanUser(claim: ExtractedClaim, pageUrl: string): string {
  const lines = [
    `Claim type: ${claim.type}`,
    `Claim text (verbatim, may not be in English): "${claim.text}"`,
  ];
  if (claim.brand) lines.push(`Brand: ${claim.brand}`);
  if (claim.language) lines.push(`Claim language: ${claim.language}`);
  lines.push(`Found on page: ${pageUrl}`);
  return lines.join("\n");
}

function buildAssessUser(claim: ExtractedClaim, required: string[], sources: SourceExcerpt[]): string {
  const lines = [
    `Claim type: ${claim.type}`,
    `Claim text (verbatim, may not be in English): "${claim.text}"`,
  ];
  if (claim.brand) lines.push(`Brand: ${claim.brand}`);
  if (claim.language) lines.push(`Claim language: ${claim.language}`);
  lines.push("", "Required items (satisfy by exact index or text):");
  required.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  lines.push("", "Fetched sources. Only quote text that appears in a \"passage\" line below, verbatim.");
  sources.forEach((s, i) => {
    lines.push(
      "",
      `Source ${i + 1}`,
      `  url: ${s.url}`,
      `  issuer: ${s.issuer}`,
      `  title: ${s.title}`,
      `  selfDeclared: ${s.selfDeclared} (true = brand's own site or its parent group; never independent)`,
      `  cached: ${s.cached}, retrievedAt: ${s.retrievedAt}`,
    );
    s.passages.forEach((p, j) => lines.push(`  passage ${j + 1}: "${p}"`));
  });
  return lines.join("\n");
}

/** Keep only model-reported evidence that is actually grounded in the given sources, then compute
 * gaps deterministically. Never trusts a model's url or quote without verifying it here. */
function reconcileAssessment(raw: AssessRaw, required: string[], sources: SourceExcerpt[]): Assessment {
  const sourceByUrl = new Map(sources.map((s) => [s.url, s]));
  const requiredSet = new Set(required);
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

    const satisfies = item.satisfies.filter((s) => requiredSet.has(s));

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

  const satisfiedByStrongEvidence = new Set<string>();
  for (const e of evidence) {
    if (e.supports === "full" || e.supports === "partial") {
      for (const s of e.satisfies) satisfiedByStrongEvidence.add(s);
    }
  }
  const unmetRequired = required.filter((r) => !satisfiedByStrongEvidence.has(r));
  const gaps = dedupeStrings([...unmetRequired, ...raw.gaps]);

  return { evidence, gaps };
}

export abstract class SpecialistAgent extends Agent<Env> implements SpecialistRpc {
  protected abstract readonly role: SpecialistId;
  /** Specialty knowledge and stance for this agent, defined as a constant in its own file. */
  protected abstract readonly knowledge: string;

  private planSystemPrompt(): string {
    return [
      "You are a ProofTrace evidence-planning specialist.",
      "Claims may be written in Portuguese or another non-English language; read them as written, do not translate them.",
      "Given one sustainability claim about a brand or product, decide what public evidence would be needed to verify it, and propose focused web search queries to find that evidence.",
      "Return 2-5 concrete, checkable required items — not restatements of the claim itself — and 1-3 search queries in the language most likely to surface primary sources (include the brand name and any named certifier, standard or method). List organisations or domains worth opening first as preferredIssuers.",
      "Write the required items, queries and preferredIssuers in English, even when the claim itself is in another language.",
      "Respond only with the required JSON.",
      "",
      this.knowledge,
    ].join("\n");
  }

  private assessSystemPrompt(): string {
    return [
      "You are a ProofTrace evidence-assessment specialist.",
      "Claims and source passages may be written in Portuguese or another non-English language; read them as written, do not translate them in your quotes.",
      "You are given a claim, the required items it must satisfy, and excerpts from fetched public web pages. Each source is marked selfDeclared when it is the brand's own site or its parent group's site.",
      "For each piece of usable evidence: quote EXACTLY one passage from one source, character for character, with no paraphrase — copy it only from a \"passage\" line you were given. State which source url it came from, which required item(s) (by their exact text) it satisfies, whether it fully, partially, or does not support each item, whether the source is independent of the brand, and whether its scope matches the claim (for example, brand-level approval is not the same scope as approval of every product).",
      "Never invent a quote, url, or certification result, and never treat a selfDeclared source as independent. List required items with no supporting evidence as gaps, written in English.",
      "Respond only with the required JSON.",
      "",
      this.knowledge,
    ].join("\n");
  }

  async plan(claim: ExtractedClaim, pageUrl: string): Promise<EvidencePlan> {
    const raw = await callJson(this.env, this.role, {
      system: this.planSystemPrompt(),
      user: buildPlanUser(claim, pageUrl),
      schema: PlanRawSchema,
      schemaName: "evidence_plan",
    });

    return {
      required: dedupeStrings(raw.required).slice(0, 5),
      queries: dedupeStrings(raw.queries).slice(0, 3),
      preferredIssuers: dedupeStrings(raw.preferredIssuers ?? []),
    };
  }

  async assess(claim: ExtractedClaim, required: string[], sources: SourceExcerpt[]): Promise<Assessment> {
    if (sources.length === 0) {
      return { evidence: [], gaps: [...required] };
    }

    const raw = await callJson(this.env, this.role, {
      system: this.assessSystemPrompt(),
      user: buildAssessUser(claim, required, sources),
      schema: AssessRawSchema,
      schemaName: "evidence_assessment",
    });

    return reconcileAssessment(raw, required, sources);
  }
}
