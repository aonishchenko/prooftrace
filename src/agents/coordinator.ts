// Coordinator Agent — orchestrates one investigation end to end.
// One Durable Object instance per investigation; DO name === investigation id (see docs/ARCHITECTURE.md §3).
//
// Ownership note: this file owns the pipeline only. It imports the Evidence Scout, extractor, rules, action writer,
// model helpers and the three specialist Durable Objects, all written by other builders against the shared
// contracts in src/shared/types.ts and src/shared/internal.ts.

import { Agent, callable, getAgentByName } from "agents";

import type {
  ClaimResult,
  ClaimType,
  Investigation,
  InvestigateInput,
  Step,
} from "../shared/types";
import type {
  Assessment,
  EvidencePlan,
  EvidenceScout,
  ExtractedClaim,
  FetchedPage,
  ScoutAttempt,
  SearchHit,
  SourceExcerpt,
  SpecialistId,
} from "../shared/internal";

import { createEvidenceScout } from "./evidence-scout";
import { issuerOf } from "./text";
import { validatePublicUrl } from "./url-safety";
import { ModelError, modelFor } from "./models";
import { selectPassages } from "./quotes";
import { extractClaims } from "./extractor";
import { decideVerdict } from "./rules";
import { writeAction } from "./action";
import type { CertificationSpecialist } from "./certification";
import type { QuantitativeSpecialist } from "./quantitative";
import type { SourcingSpecialist } from "./sourcing";

const RUN_DEADLINE_MS = 120_000;
const MAX_CANDIDATES_PER_CLAIM = 5;
const MAX_CANDIDATE_CONCURRENCY = 3;
const MAX_CLAIMS_INVESTIGATED = 2;
const MAX_DISCOVERY_QUERIES = 3;
const MAX_DISCOVERY_LINK_FETCHES = 3;

// EN + PT keywords used to hunt for a sustainability-claims page when the input page itself has none.
const DISCOVERY_KEYWORDS = [
  "sustain",
  "sustent",
  "compromisso",
  "commitment",
  "green",
  "eco",
  "cruelty",
  "crueldade",
  "animal",
  "vegan",
  "recicl",
  "recycl",
  "planet",
  "planeta",
  "natural",
  "ingredient",
  "ingrediente",
  "responsab",
  "ethic",
  "etic",
  "refill",
  "recarga",
  "embalag",
  "packag",
  "beauty-score",
  "ecobeautyscore",
  "about",
  "sobre",
];

// Brand -> parent-group domain whose statements about that brand are never independent evidence.
const SELF_DECLARED_GROUPS: Record<string, string> = {
  garnier: "loreal.com",
  ysl: "loreal.com",
  yslbeauty: "loreal.com",
  "saint laurent": "loreal.com",
};

function specialistKind(type: ClaimType): SpecialistId {
  if (type === "certification") return "certification";
  if (type === "quantitative") return "quantitative";
  return "sourcing"; // sourcing & generic share the Sourcing Specialist
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

function normalizeIssuer(issuer: string): string {
  return issuer.toLowerCase().replace(/^www\./, "");
}

function isSelfDeclared(sourceIssuer: string, ownIssuer: string, brand: string | undefined): boolean {
  const issuer = normalizeIssuer(sourceIssuer);
  if (issuer === normalizeIssuer(ownIssuer)) return true;
  if (issuer === "loreal.com") return true;
  if (brand) {
    const lowerBrand = brand.toLowerCase();
    if (issuer.includes(lowerBrand)) return true;
    if (SELF_DECLARED_GROUPS[lowerBrand] === issuer) return true;
  }
  return false;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function uniqueWords(parts: string[]): string[] {
  const words = parts
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9á-úàâãéêíóôõúç-]+/i)
    .filter((w) => w.length > 3);
  return Array.from(new Set(words));
}

function fetchStepLabel(a: ScoutAttempt): string {
  switch (a.status) {
    case "ok":
      return "Fetched page";
    case "blocked":
      return "Page blocked";
    case "timeout":
      return "Page timed out";
    case "skipped":
      return "Page skipped";
    case "unavailable":
      return "Fetch unavailable";
    default:
      return "Fetch failed";
  }
}

function fetchStepDetail(a: ScoutAttempt): string {
  const secs = (a.ms / 1000).toFixed(1);
  switch (a.status) {
    case "ok":
      return `fetched via ${a.method ?? "fetch"} in ${secs} s`;
    case "blocked":
      return `blocked: ${a.reason ?? "access denied"}`;
    case "timeout":
      return `timed out after ${secs} s`;
    case "skipped":
      return `skipped: ${a.reason ?? "not needed"}`;
    case "unavailable":
      return `unavailable: ${a.reason ?? "fetch tool unavailable"}`;
    default:
      return a.reason ?? "fetch error";
  }
}

function searchStepDetail(a: ScoutAttempt): string {
  if (a.status === "unavailable") return "search unavailable — limited search mode";
  if (a.status === "ok") {
    const count = a.resultCount ?? 0;
    return `${count} result${count === 1 ? "" : "s"} in ${(a.ms / 1000).toFixed(1)} s (snippets unverified)`;
  }
  return a.reason ?? a.status;
}

function stepStatusFor(a: ScoutAttempt): Step["status"] {
  if (a.status === "ok") return "ok";
  if (a.status === "unavailable") return "info";
  return "fail";
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function pickClaims(claims: ExtractedClaim[]): ExtractedClaim[] {
  const order: ClaimType[] = ["certification", "quantitative", "sourcing", "generic"];
  const rank = (t: ClaimType) => order.indexOf(t);
  const sorted = [...claims].sort((a, b) => rank(a.type) - rank(b.type));
  const picked: ExtractedClaim[] = [];
  for (const c of sorted) {
    if (picked.length >= MAX_CLAIMS_INVESTIGATED) break;
    if (picked.some((p) => p.type === c.type)) continue;
    picked.push(c);
  }
  for (const c of sorted) {
    if (picked.length >= MAX_CLAIMS_INVESTIGATED) break;
    if (picked.includes(c)) continue;
    picked.push(c);
  }
  return picked;
}

function emptyClaimResult(c: ExtractedClaim, sourceUrl: string): ClaimResult {
  return {
    claimId: c.claimId,
    text: c.text,
    sourceUrl,
    type: c.type,
    required: [],
    evidence: [],
    gaps: [],
    checkedUrls: [],
  };
}

function modelErrorMessage(err: unknown, fallback: string): string {
  return err instanceof ModelError ? err.userMessage : fallback;
}

// env.d.ts augments `Cloudflare.Env` (not the flat generated `Env`) with optional secrets such as
// BRAVE_SEARCH_API_KEY. `Env` is structurally assignable to `Cloudflare.Env` (same required bindings, the extra
// field is optional), so this narrowing cast is sound without `as unknown`.
function hasSearchKeyConfigured(env: Env): boolean {
  return Boolean((env as Cloudflare.Env).BRAVE_SEARCH_API_KEY);
}

export class Coordinator extends Agent<Env, Investigation> {
  initialState: Investigation = {
    id: "",
    input: { url: "", mode: "live" },
    status: "idle",
    steps: [],
    claims: [],
  };

  private runStartMs = 0;

  /**
   * Client/RPC entry point. Idempotent: a second call while running (or after finishing) just returns the
   * current status instead of starting a second pipeline. The pipeline itself is NOT awaited so this call
   * (whether invoked over the WebSocket RPC protocol or as a direct DO RPC call from src/server.ts) returns
   * immediately; keepAliveWhile + ctx.waitUntil keep the Durable Object alive while it runs in the background.
   */
  @callable()
  async start(input: InvestigateInput): Promise<{ id: string; status: string }> {
    const id = this.ctx.id.name ?? this.ctx.id.toString();
    if (this.state.status !== "idle") {
      return { id, status: this.state.status };
    }

    const mode = input.mode ?? "live";
    this.setState({
      ...this.state,
      id,
      input: { url: input.url, mode },
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const pipeline = this.keepAliveWhile(() => this.runPipeline(id, { url: input.url, mode }));
    this.ctx.waitUntil(pipeline);
    return { id, status: "running" };
  }

  /** Plain RPC method used by GET /api/investigations/:id for HTTP polling. */
  async snapshot(): Promise<Investigation> {
    return this.state;
  }

  private pushStep(step: Omit<Step, "id" | "at">): void {
    const entry: Step = { id: crypto.randomUUID(), at: Date.now() - this.runStartMs, ...step };
    this.setState({ ...this.state, steps: [...this.state.steps, entry] });
  }

  private finish(status: "done" | "incomplete" | "error", error?: string): void {
    this.setState({
      ...this.state,
      status,
      error,
      finishedAt: new Date().toISOString(),
    });
  }

  private async getSpecialistStub<T extends Agent<Env>>(
    namespace: DurableObjectNamespace,
    name: string,
  ): Promise<DurableObjectStub<T>> {
    return getAgentByName<Env, T>(namespace as unknown as DurableObjectNamespace<T>, name);
  }

  private specialistStub(type: ClaimType) {
    const kind = specialistKind(type);
    if (kind === "certification") {
      return this.getSpecialistStub<CertificationSpecialist>(this.env.CertificationSpecialist, "main");
    }
    if (kind === "quantitative") {
      return this.getSpecialistStub<QuantitativeSpecialist>(this.env.QuantitativeSpecialist, "main");
    }
    return this.getSpecialistStub<SourcingSpecialist>(this.env.SourcingSpecialist, "main");
  }

  private async runPipeline(id: string, input: InvestigateInput): Promise<void> {
    try {
      await this.executePipeline(id, input);
    } catch (err) {
      console.error("Coordinator pipeline crashed", id, err);
      this.finish("error", "The investigation failed unexpectedly. Please try again.");
    } finally {
      await this.persist().catch((err) => console.error("D1 persist failed", id, err));
    }
  }

  private async executePipeline(id: string, input: InvestigateInput): Promise<void> {
    this.runStartMs = Date.now();
    const deadline = this.runStartMs + RUN_DEADLINE_MS;

    // 1. Validate the input URL.
    const valid = validatePublicUrl(input.url);
    if (!valid.ok) {
      this.pushStep({
        agent: "scout",
        kind: "fetch",
        status: "fail",
        url: input.url,
        label: "Rejected input URL",
        detail: valid.reason,
      });
      this.finish("error", valid.reason);
      return;
    }

    // 2. Evidence Scout + search-mode detection.
    let mainFetchInFlight = false;
    const onAttempt = (a: ScoutAttempt) => {
      if (a.kind === "search") {
        this.pushStep({
          agent: "scout",
          kind: "search",
          status: stepStatusFor(a),
          label: `Searched: ${a.target}`,
          detail: searchStepDetail(a),
        });
        return;
      }
      this.pushStep({
        agent: "scout",
        kind: mainFetchInFlight ? "fetch" : "open",
        status: stepStatusFor(a),
        url: a.target,
        label: fetchStepLabel(a),
        detail: fetchStepDetail(a),
      });
    };
    const scout = createEvidenceScout(this.env, { investigationId: id, onAttempt });

    let searchMode: "full" | "limited" = hasSearchKeyConfigured(this.env) ? "full" : "limited";
    let searchModeConfirmed = false;
    let limitedNoticeGiven = false;
    const announceLimited = () => {
      if (limitedNoticeGiven) return;
      limitedNoticeGiven = true;
      this.pushStep({
        agent: "scout",
        kind: "info",
        status: "info",
        label: "Limited search mode",
        detail:
          "Web search API not configured — using links on the page and known official sources only (limited search).",
      });
    };
    if (searchMode === "limited") announceLimited();
    this.setState({ ...this.state, searchMode });

    const searchWeb = async (query: string): Promise<{ available: boolean; hits: SearchHit[] }> => {
      const res = await scout.searchWeb(query);
      if (!searchModeConfirmed) {
        searchModeConfirmed = true;
        const confirmed: "full" | "limited" = res.available ? "full" : "limited";
        if (confirmed !== searchMode) {
          searchMode = confirmed;
          this.setState({ ...this.state, searchMode });
        }
        if (searchMode === "limited") announceLimited();
      }
      return res;
    };

    // 3. Fetch the input page live. Never substitute a snapshot.
    mainFetchInFlight = true;
    const outcome = await scout.fetchPage(valid.url.toString(), { allowCache: false });
    mainFetchInFlight = false;
    if (!outcome.ok) {
      this.finish("incomplete", `Could not load the page: ${outcome.reason}`);
      return;
    }
    let page: FetchedPage = outcome.page;

    // 4. Extract claims; fall back to claim discovery via linked pages.
    const extractorModel = await modelFor(this.env, "extractor").catch(() => "default model");
    let claims: ExtractedClaim[] = [];
    try {
      claims = await extractClaims(this.env, page, { max: 6 });
    } catch (err) {
      claims = [];
      this.pushStep({
        agent: "extractor",
        kind: "extract",
        status: "fail",
        url: page.finalUrl,
        label: "Claim extraction failed",
        detail: modelErrorMessage(err, "Could not extract claims from the fetched page."),
      });
    }
    this.pushStep({
      agent: "extractor",
      kind: "extract",
      status: claims.length ? "ok" : "info",
      url: page.finalUrl,
      label: claims.length ? `Extracted ${claims.length} claim(s)` : "No claims found on the input page",
      detail: `model ${extractorModel}`,
    });

    if (claims.length === 0) {
      const discoveryLinks = scout.rankLinks(page, DISCOVERY_KEYWORDS, 4);
      let tried = 0;
      for (const link of discoveryLinks) {
        if (tried >= MAX_DISCOVERY_LINK_FETCHES || Date.now() > deadline) break;
        tried += 1;
        const linkOutcome = await scout.fetchPage(link.url, { allowCache: true });
        if (!linkOutcome.ok) continue;
        const found = await extractClaims(this.env, linkOutcome.page, { max: 6 }).catch(() => []);
        if (found.length > 0) {
          claims = found;
          page = linkOutcome.page;
          break;
        }
      }
      this.pushStep({
        agent: "extractor",
        kind: "extract",
        status: claims.length ? "ok" : "info",
        url: page.finalUrl,
        label: claims.length
          ? `Found ${claims.length} claim(s) after checking linked pages`
          : "No claims found after checking linked pages",
        detail: `model ${extractorModel}`,
      });
      if (claims.length === 0) {
        this.finish("incomplete", "No sustainability claims found on this page or the linked pages checked.");
        return;
      }
    }

    // 5. Select up to 2 claims to investigate; record every extracted claim.
    const picked = pickClaims(claims);
    const claimResults = claims.map((c) => emptyClaimResult(c, page.finalUrl));
    this.setState({
      ...this.state,
      claims: claimResults,
      selectedClaimId: picked[0]?.claimId,
    });

    const investigated = await Promise.all(
      picked.map((claim) =>
        this.investigateClaim(claim, page, scout, searchWeb, deadline).catch((err) => {
          const msg = modelErrorMessage(err, "This claim could not be investigated due to an unexpected error.");
          this.pushStep({
            agent: specialistKind(claim.type),
            kind: "gap",
            status: "fail",
            claimId: claim.claimId,
            label: "Investigation failed",
            detail: msg,
          });
          return { ...emptyClaimResult(claim, page.finalUrl), gaps: [msg] };
        }),
      ),
    );

    for (const result of investigated) {
      const idx = this.state.claims.findIndex((c) => c.claimId === result.claimId);
      if (idx === -1) continue;
      const nextClaims = [...this.state.claims];
      nextClaims[idx] = result;
      this.setState({ ...this.state, claims: nextClaims });
    }

    const anyVerdict = this.state.claims.some((c) => c.verdict !== undefined);
    if (anyVerdict) {
      this.finish("done");
    } else {
      this.finish("incomplete", "Could not reach a verdict for the investigated claims within the search budget.");
    }
  }

  private async investigateClaim(
    claim: ExtractedClaim,
    page: FetchedPage,
    scout: EvidenceScout,
    searchWeb: (query: string) => Promise<{ available: boolean; hits: SearchHit[] }>,
    deadline: number,
  ): Promise<ClaimResult> {
    const base = emptyClaimResult(claim, page.finalUrl);
    const agentId = specialistKind(claim.type);

    if (Date.now() > deadline) {
      const msg = "Investigation stopped: time budget exceeded before this claim could be checked.";
      base.gaps = [msg];
      this.pushStep({
        agent: agentId,
        kind: "gap",
        status: "info",
        claimId: claim.claimId,
        label: "Skipped due to time budget",
        detail: msg,
      });
      return base;
    }

    // a. Plan required evidence with the matching specialist.
    let plan: EvidencePlan;
    try {
      const stub = await this.specialistStub(claim.type);
      plan = await stub.plan(claim, page.finalUrl);
    } catch (err) {
      const msg = modelErrorMessage(err, "Could not determine what evidence would substantiate this claim.");
      base.gaps.push(msg);
      this.pushStep({
        agent: agentId,
        kind: "gap",
        status: "fail",
        claimId: claim.claimId,
        label: "Planning failed",
        detail: msg,
      });
      return base;
    }
    base.required = plan.required;
    this.pushStep({
      agent: agentId,
      kind: "require",
      status: "ok",
      claimId: claim.claimId,
      label: `Requires ${plan.required.length} item(s)`,
      detail: plan.required.join("; "),
    });

    // b. Discover candidate sources.
    const officialHits = await scout.officialCandidates(claim, claim.brand).catch(() => [] as SearchHit[]);
    const searchHits: SearchHit[] = [];
    for (const query of plan.queries.slice(0, MAX_DISCOVERY_QUERIES)) {
      if (Date.now() > deadline) break;
      const res = await searchWeb(query);
      this.pushStep({
        agent: "scout",
        kind: "search",
        status: res.available ? "ok" : "info",
        claimId: claim.claimId,
        label: `Searched: ${query}`,
        detail: res.available
          ? `${res.hits.length} result(s) (snippets unverified)`
          : "search unavailable — limited search mode",
      });
      searchHits.push(...res.hits);
    }
    const linkKeywords = uniqueWords([claim.text, ...plan.required, ...(claim.brand ? [claim.brand] : [])]);
    const linkHits: SearchHit[] = scout
      .rankLinks(page, linkKeywords.length ? linkKeywords : DISCOVERY_KEYWORDS, 3)
      .map((l) => ({ url: l.url, title: l.text || l.url, snippet: "", source: "link" as const }));

    const ownUrlKey = normalizeUrl(page.finalUrl);
    const seen = new Set<string>([ownUrlKey]);
    const candidates: SearchHit[] = [];
    const addCandidates = (hits: SearchHit[]) => {
      for (const hit of hits) {
        const key = normalizeUrl(hit.url);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(hit);
      }
    };
    addCandidates(officialHits);
    const preferred = new Set(plan.preferredIssuers.map((s) => s.toLowerCase()));
    const preferredHits = searchHits.filter(
      (h) =>
        preferred.has(issuerOf(h.url).toLowerCase()) ||
        plan.preferredIssuers.some((p) => h.url.toLowerCase().includes(p.toLowerCase())),
    );
    const otherSearchHits = searchHits.filter((h) => !preferredHits.includes(h));
    addCandidates(preferredHits);
    addCandidates(otherSearchHits);
    addCandidates(linkHits);

    // c. Fetch up to MAX_CANDIDATES_PER_CLAIM candidates, concurrency-limited. Always include the claim's own page.
    const toFetch = candidates.slice(0, MAX_CANDIDATES_PER_CLAIM);
    const overflow = candidates.slice(MAX_CANDIDATES_PER_CLAIM);
    const fetchedPages: FetchedPage[] = [page];
    const checkedUrls: ClaimResult["checkedUrls"] = [{ url: page.finalUrl, status: "fetched" }];

    await runWithConcurrency(toFetch, MAX_CANDIDATE_CONCURRENCY, async (hit) => {
      if (Date.now() > deadline) {
        checkedUrls.push({ url: hit.url, status: "skipped", reason: "time budget exceeded" });
        return;
      }
      const result = await scout.fetchPage(hit.url, { allowCache: true });
      if (result.ok) {
        fetchedPages.push(result.page);
        checkedUrls.push({ url: result.page.finalUrl, status: "fetched" });
      } else {
        checkedUrls.push({ url: hit.url, status: result.status, reason: result.reason });
      }
    });
    for (const extra of overflow) {
      checkedUrls.push({ url: extra.url, status: "skipped", reason: "not fetched — beyond top ranked candidates" });
    }
    base.checkedUrls = checkedUrls;

    // d. Build source excerpts for the specialist to judge.
    const passageKeywords = uniqueWords([claim.text, ...plan.required, ...(claim.brand ? [claim.brand] : [])]);
    const sources: SourceExcerpt[] = fetchedPages.map((p) => ({
      url: p.finalUrl,
      issuer: p.issuer,
      title: p.title,
      retrievedAt: p.fetchedAt,
      cached: p.cached,
      selfDeclared: isSelfDeclared(p.issuer, page.issuer, claim.brand),
      passages: selectPassages(p.text, passageKeywords, { max: 6 }),
    }));

    // e. Assess evidence against requirements.
    let assessment: Assessment;
    try {
      const stub = await this.specialistStub(claim.type);
      assessment = await stub.assess(claim, plan.required, sources);
    } catch (err) {
      const msg = modelErrorMessage(err, "Could not evaluate the fetched evidence for this claim.");
      base.gaps.push(msg);
      this.pushStep({
        agent: agentId,
        kind: "gap",
        status: "fail",
        claimId: claim.claimId,
        label: "Assessment failed",
        detail: msg,
      });
      return base;
    }
    base.evidence = assessment.evidence;
    base.gaps = [...base.gaps, ...assessment.gaps];
    for (const ev of assessment.evidence) {
      this.pushStep({
        agent: agentId,
        kind: "match",
        status: ev.supports === "none" ? "info" : "ok",
        claimId: claim.claimId,
        url: ev.url,
        label: `${ev.issuer}: ${ev.supports} support`,
        detail: `${ev.issuer}${ev.independent ? " (independent)" : " (self-declared)"} — "${truncate(ev.quote, 140)}"`,
      });
    }
    for (const gap of assessment.gaps) {
      this.pushStep({
        agent: agentId,
        kind: "gap",
        status: "info",
        claimId: claim.claimId,
        label: "Gap",
        detail: gap,
      });
    }

    // f. Decide verdict and draft the next action.
    const rule = decideVerdict(claim, plan.required, assessment.evidence, assessment.gaps);
    base.checks = rule.checks;
    base.verdict = rule.verdict;
    this.pushStep({
      agent: "verdict",
      kind: "verdict",
      status: "ok",
      claimId: claim.claimId,
      label: `Verdict: ${rule.verdict}`,
      detail: rule.checks.map((c) => `${c.pass ? "✓" : "✗"} ${c.name}`).join("; "),
    });

    try {
      const action = await writeAction(this.env, claim, rule, plan.required, assessment.evidence, assessment.gaps);
      base.rewrite = action.rewrite;
      base.nextAction = action.nextAction;
      base.evidenceRequest = action.evidenceRequest;
      this.pushStep({
        agent: "coordinator",
        kind: "action",
        status: "ok",
        claimId: claim.claimId,
        label: "Next action drafted",
        detail: action.nextAction,
      });
    } catch (err) {
      const msg = modelErrorMessage(err, "Could not draft a next action for this claim.");
      this.pushStep({
        agent: "coordinator",
        kind: "action",
        status: "fail",
        claimId: claim.claimId,
        label: "Action drafting failed",
        detail: msg,
      });
    }

    return base;
  }

  private async persist(): Promise<void> {
    const inv = this.state;
    if (!inv.id) return; // never started
    try {
      await this.env.DB.prepare(
        `INSERT OR REPLACE INTO investigations
           (id, input_url, mode, status, selected_claim_id, result_json, error, started_at, finished_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
        .bind(
          inv.id,
          inv.input.url,
          inv.input.mode,
          inv.status,
          inv.selectedClaimId ?? null,
          JSON.stringify(inv),
          inv.error ?? null,
          inv.startedAt ?? new Date().toISOString(),
          inv.finishedAt ?? null,
        )
        .run();

      const evidenceRows = inv.claims.flatMap((c) => c.evidence.map((ev) => ({ claimId: c.claimId, ev })));
      for (const { claimId, ev } of evidenceRows) {
        await this.env.DB.prepare(
          `INSERT INTO evidence
             (investigation_id, claim_id, url, issuer, quote, supports, independent, scope_match, satisfies_json, retrieved_at, cached)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        )
          .bind(
            inv.id,
            claimId,
            ev.url,
            ev.issuer,
            ev.quote,
            ev.supports,
            ev.independent ? 1 : 0,
            ev.scopeMatch ? 1 : 0,
            JSON.stringify(ev.satisfies),
            ev.retrievedAt,
            ev.cached ? 1 : 0,
          )
          .run();
      }
    } catch (err) {
      console.error("Failed to persist investigation to D1", inv.id, err);
    }
  }
}
