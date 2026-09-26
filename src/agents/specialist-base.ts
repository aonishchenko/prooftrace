// Shared behaviour for the three specialist Durable Objects (Certification, Quantitative, Sourcing).
// Each concrete specialist supplies only its `role` and specialty `knowledge` text; this base class
// owns prompt shape, the model call, and the code-side reconciliation that turns a model's judgement
// into evidence ProofTrace can trust (never a raw model quote or url without verification).
import { Agent } from "agents";
import { z } from "zod";
import type {
  Assessment,
  EvidencePlan,
  ExtractedClaim,
  RpcResult,
  SourceExcerpt,
  SpecialistId,
  SpecialistRpc,
} from "../shared/internal";
import { ModelError, callJson } from "./models";
import { findExact } from "./quotes";
// Pure evidence-filtering/satisfies-mapping logic lives in specialist-reconcile.ts (not here) so it
// can be unit tested in plain Node — see that file's header comment. Import unit tests should import
// directly from "./specialist-reconcile", not from this file, to avoid pulling in the Cloudflare
// Agents SDK this class extends.
import { DEFAULT_REQUIRED, dedupeStrings, reconcileAssessment } from "./specialist-reconcile";

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
      // A model may report which required item it satisfies as the item's exact text OR its
      // 1-based index (as a number or a numeric string); resolveSatisfies() reconciles both — see
      // specialist-reconcile.ts.
      satisfies: z.array(z.union([z.string(), z.number()])),
    }),
  ),
  gaps: z.array(z.string()),
});

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
  lines.push("", "Required items (report by exact text above, or by number):");
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

export abstract class SpecialistAgent extends Agent<Env> implements SpecialistRpc {
  protected abstract readonly role: SpecialistId;
  /** Specialty knowledge and stance for this agent, defined as a constant in its own file. */
  protected abstract readonly knowledge: string;

  private planSystemPrompt(): string {
    return [
      "You are a ProofTrace evidence-planning specialist.",
      "Claims may be written in Portuguese or another non-English language; read them as written, do not translate them.",
      "Given one sustainability claim about a brand or product, decide what public evidence would be needed to verify it, and propose focused web search queries to find that evidence.",
      "Return 2-4 required items — not restatements of the claim itself. Each item must be a short, concrete noun phrase of AT MOST 15 WORDS (for example \"Certifier listing naming Garnier\" or \"Component weights per packaging part\") — never a paragraph or a full sentence.",
      "Also return 1-3 search queries of AT MOST 10 WORDS EACH, in the language most likely to surface primary sources (include the brand name and any named certifier, standard or method). List organisations or domains worth opening first as preferredIssuers.",
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
      "For each piece of usable evidence: quote EXACTLY one passage of at least four words from one source, character for character, with no paraphrase — copy it only from a \"passage\" line you were given; a short fragment is not usable evidence. State which source url it came from, which required item(s) it satisfies — using the item's EXACT text as given above, or its number — whether it fully, partially, or does not support each item, whether the source is independent of the brand, and whether its scope matches the claim (for example, brand-level approval is not the same scope as approval of every product).",
      "Never invent a quote, url, or certification result, and never treat a selfDeclared source as independent. List required items with no supporting evidence as gaps, written in English.",
      "Respond only with the required JSON.",
      "",
      this.knowledge,
    ].join("\n");
  }

  async plan(claim: ExtractedClaim, pageUrl: string, deadlineMs: number): Promise<RpcResult<EvidencePlan>> {
    try {
      const raw = await callJson(this.env, this.role, {
        system: this.planSystemPrompt(),
        user: buildPlanUser(claim, pageUrl),
        schema: PlanRawSchema,
        schemaName: "evidence_plan",
        deadlineMs,
        overrides: { reasoning: "none", maxTokens: 2200, timeoutMs: 30000 },
      });

      const required = dedupeStrings(raw.required).slice(0, 5);
      const value: EvidencePlan = {
        required: required.length > 0 ? required : DEFAULT_REQUIRED[this.role],
        queries: dedupeStrings(raw.queries).slice(0, 3),
        preferredIssuers: dedupeStrings(raw.preferredIssuers ?? []),
      };
      return { ok: true, value };
    } catch (err) {
      return { ok: false, userMessage: rpcErrorMessage(err, `Could not determine what evidence would substantiate this ${this.role} claim.`) };
    }
  }

  async assess(claim: ExtractedClaim, required: string[], sources: SourceExcerpt[], deadlineMs: number): Promise<RpcResult<Assessment>> {
    try {
      if (sources.length === 0) {
        const gaps = required.length > 0 ? [...required] : ["No independent source found in the pages checked"];
        return { ok: true, value: { evidence: [], gaps } };
      }

      const raw = await callJson(this.env, this.role, {
        system: this.assessSystemPrompt(),
        user: buildAssessUser(claim, required, sources),
        schema: AssessRawSchema,
        schemaName: "evidence_assessment",
        deadlineMs,
        overrides: { reasoning: "none", maxTokens: 3000, timeoutMs: 25000 },
      });

      return { ok: true, value: reconcileAssessment(raw, required, sources) };
    } catch (err) {
      // Keep the investigation useful when both hosted models time out or truncate. The only
      // fallback evidence is the exact claim quoted on its own page; it is never independent and
      // can never satisfy a required item. The verdict gate still withholds an unsupported verdict.
      const ownSource = sources.find((source) => source.selfDeclared && source.passages.some((p) => findExact(p, claim.text)));
      const assessment = reconcileAssessment({
        evidence: ownSource ? [{
          url: ownSource.url,
          quote: claim.text,
          supports: "partial",
          scopeMatch: true,
          independent: false,
          satisfies: [],
        }] : [],
        gaps: [],
      }, required, sources);
      return { ok: true, value: {
        ...assessment,
        gaps: [...assessment.gaps, "Automated evidence assessment was unavailable; the brand statement remains unverified."],
      } };
    }
  }
}

/** Errors thrown inside a Durable Object lose their subclass across RPC (see shared/internal.ts), so
 * `plan`/`assess` never throw — they catch everything and report `{ ok: false, userMessage }` here. */
function rpcErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ModelError) return err.userMessage;
  return fallback;
}
