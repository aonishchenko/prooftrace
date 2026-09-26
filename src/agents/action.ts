// Action writer: Kimi drafts a narrower rewrite, a next action, and (when gaps exist) a draft
// evidence-request email — strictly from the rule result and fetched evidence, never invented.
// See docs/ARCHITECTURE.md §1 step "Decide/action" and §4.
import { z } from "zod";
import type { Evidence } from "../shared/types";
import type { ActionResult, ExtractedClaim, RuleResult } from "../shared/internal";
import { callJson } from "./models";

const ActionRawSchema = z.object({
  rewrite: z.string().optional(),
  nextAction: z.string(),
  evidenceRequest: z.string().optional(),
});

const SYSTEM_PROMPT = [
  "You write the outcome of a completed ProofTrace fact-check for one sustainability claim.",
  "Write ONLY from the verdict, checks, required items, evidence and gaps you are given. Never invent a fact, a source, or a reason the brand might be lying.",
  "When public evidence is missing, say exactly that it was 'not found in public sources checked' — never say a claim is false or that the brand is dishonest.",
  "If the verdict is VAGUE or NOT_PUBLICLY_VERIFIABLE, write `rewrite`: a narrower version of the claim that IS supported by the given evidence (or, if no evidence supports any narrower version, omit it). The rewrite must be written in the SAME language as the original claim text — do not translate it.",
  "If the verdict is BACKED, omit `rewrite`.",
  "Always write `nextAction`: one sentence, in English, stating what ProofTrace or a reader should do next (e.g. accept the claim as verified for its stated scope, request missing data, or avoid repeating the broad wording).",
  "Only when there are unmet required items (gaps), write `evidenceRequest`: a short, polite draft email in English asking the brand for exactly the missing items. Label it clearly as a draft that is never sent automatically. If there are no gaps, omit `evidenceRequest`.",
  "Respond only with the required JSON.",
].join("\n");

function summarizeEvidence(evidence: Evidence[]): string {
  if (evidence.length === 0) return "(none)";
  return evidence
    .map((e, i) =>
      [
        `${i + 1}. url: ${e.url}`,
        `   issuer: ${e.issuer}`,
        `   quote: "${e.quote}"`,
        `   independent: ${e.independent}, supports: ${e.supports}, scopeMatch: ${e.scopeMatch}`,
        `   satisfies: ${e.satisfies.join(", ") || "(none)"}`,
      ].join("\n"),
    )
    .join("\n");
}

function buildUserPrompt(
  claim: ExtractedClaim,
  rule: RuleResult,
  required: string[],
  evidence: Evidence[],
  gaps: string[],
): string {
  const lines = [
    `Claim type: ${claim.type}`,
    `Claim text (verbatim${claim.language ? `, language: ${claim.language}` : ""}): "${claim.text}"`,
  ];
  if (claim.brand) lines.push(`Brand: ${claim.brand}`);
  lines.push(
    "",
    `Verdict: ${rule.verdict}`,
    "Checks:",
    ...rule.checks.map((c) => `- ${c.name}: ${c.pass ? "pass" : "fail"}`),
    "",
    "Required items:",
    ...(required.length ? required.map((r, i) => `${i + 1}. ${r}`) : ["(none)"]),
    "",
    "Evidence found:",
    summarizeEvidence(evidence),
    "",
    "Gaps (required items with no supporting evidence found in this search):",
    ...(gaps.length ? gaps.map((g) => `- ${g}`) : ["(none)"]),
  );
  return lines.join("\n");
}

/**
 * Draft the action for a claim's outcome. `rewrite` is only kept for VAGUE/NOT_PUBLICLY_VERIFIABLE
 * verdicts; `evidenceRequest` is only kept when `gaps` is non-empty. Both are enforced in code even
 * if the model returns them anyway, so the contract never depends on the model following instructions.
 */
export async function writeAction(
  env: Env,
  claim: ExtractedClaim,
  rule: RuleResult,
  required: string[],
  evidence: Evidence[],
  gaps: string[],
): Promise<ActionResult> {
  const raw = await callJson(env, "action", {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(claim, rule, required, evidence, gaps),
    schema: ActionRawSchema,
    schemaName: "action_result",
  });

  const result: ActionResult = {
    nextAction: raw.nextAction.trim(),
  };

  if (rule.verdict !== "BACKED" && raw.rewrite?.trim()) {
    result.rewrite = raw.rewrite.trim();
  }
  if (gaps.length > 0 && raw.evidenceRequest?.trim()) {
    result.evidenceRequest = raw.evidenceRequest.trim();
  }

  return result;
}
