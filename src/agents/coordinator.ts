// Coordinator Agent — orchestrates one investigation end to end.
// One Durable Object instance per investigation; DO name === investigation id (see docs/ARCHITECTURE.md §3).
//
// Ownership note: this file owns the pipeline only. It imports the Evidence Scout, extractor, rules, action writer,
// model helpers and the three specialist Durable Objects, all written by other builders against the shared
// contracts in src/shared/types.ts and src/shared/internal.ts.

import { Agent, callable, getAgentByName } from "agents";
import type { Connection } from "agents";

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
  ExtractedClaim,
  FetchedPage,
  RpcResult,
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
import {
  deterministicNextAction,
  gateVerdict,
  isDuplicateStep,
  isSelfDeclaredSource,
  summarizeRequired,
  truncate,
  withBudget,
} from "./coordinator-helpers";

// One absolute run budget. Every model call, search and fetch is raced against it (see `withBudget`
// below); a hard backstop timer and an SDK-scheduled watchdog both force `finish("incomplete", ...)`
// if the pipeline itself never gets there. See docs/ARCHITECTURE.md §4 and the LIVE E2E FAILURE this
// file was rewritten to fix (37s + 117s specialist calls, duplicated steps, a run stuck >9min).
const RUN_DEADLINE_MS = 120_000;
// Hard backstop: an in-process timer fires this long after RUN_DEADLINE_MS even if every awaited
// promise in executePipeline never settles (e.g. a hung fetch/model call with no timeout of its own).
const HARD_BACKSTOP_EXTRA_MS = 5_000;
// SDK-scheduled watchdog (`this.schedule`, survives a DO restart/eviction, unlike the plain timer
// above): fires this many seconds after the run deadline if the investigation is still "running".
const WATCHDOG_EXTRA_SECONDS = 20;
// Reserve this much of the remaining budget for verdict + action-writing + persist. If less than this
// remains before writeAction would be called, skip the model call and use a deterministic sentence.
const ACTION_RESERVE_MS = 20_000;

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

function specialistKind(type: ClaimType): SpecialistId {
  if (type === "certification") return "certification";
  if (type === "quantitative") return "quantitative";
  return "sourcing"; // sourcing & generic share the Sourcing Specialist
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
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

/** Safe to show in the UI per shared/internal.ts's RpcResult contract; never a raw provider error. */
function rpcFailureMessage(result: { ok: false; userMessage: string }): string {
  return result.userMessage;
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
  // True exactly while this in-memory instance owns an active pipeline. A fresh Durable Object wake
  // (new isolate) always starts with this false, even if `state.status` is still "running" from before
  // the previous incarnation was evicted/crashed — `onStart` below uses that combination to detect and
  // recover an interrupted run.
  #running = false;

  /**
   * Client/RPC entry point. Idempotent: a second call while running (or after finishing) just returns the
   * current status instead of starting a second pipeline. The pipeline itself is NOT awaited so this call
   * (whether invoked over the WebSocket RPC protocol or as a direct DO RPC call from src/server.ts) returns
   * immediately; keepAliveWhile + ctx.waitUntil keep the Durable Object alive while it runs in the background.
   *
   * `#running` closes a narrow race the persisted `state.status` check alone can't: two `start()` calls
   * arriving back to back, before the first call's `setState` has taken effect, could otherwise both read
   * "idle" and both launch a pipeline.
   */
  @callable()
  async start(input: InvestigateInput): Promise<{ id: string; status: string }> {
    const id = this.ctx.id.name ?? this.ctx.id.toString();
    if (this.state.status !== "idle" || this.#running) {
      return { id, status: this.state.status };
    }
    this.#running = true;

    const mode = input.mode ?? "live";
    const startedAt = new Date().toISOString();
    this.setState({
      ...this.state,
      id,
      input: { url: input.url, mode },
      status: "running",
      startedAt,
    });

    // Write the "running" row immediately (item 3): if the Worker crashes mid-run, D1 still shows an
    // in-flight investigation instead of nothing. Never blocks the response; D1 errors are swallowed
    // (logged) rather than failing this callable.
    this.ctx.waitUntil(this.persist().catch((err) => console.error("D1 persist failed (initial running row)", id, err)));

    // Durable watchdog: survives a full DO eviction/restart (unlike the in-process backstop timer in
    // runPipeline). If the run is somehow still "running" this long after it started, force it done.
    try {
      await this.schedule(Math.ceil(RUN_DEADLINE_MS / 1000) + WATCHDOG_EXTRA_SECONDS, "expireRun", undefined, {
        idempotent: true,
      });
    } catch (err) {
      console.error("Failed to schedule expireRun watchdog", id, err);
    }

    const pipeline = this.keepAliveWhile(() => this.runPipeline(id, { url: input.url, mode }));
    this.ctx.waitUntil(pipeline);
    return { id, status: "running" };
  }

  /** Plain RPC method used by GET /api/investigations/:id for HTTP polling. */
  async snapshot(): Promise<Investigation> {
    return this.state;
  }

  /**
   * Durable-execution recovery hook (SDK lifecycle callback, runs on every Durable Object wake,
   * including after eviction/restart). If a previous incarnation crashed mid-pipeline — state still
   * says "running", nothing in THIS isolate is actively driving it, and it started longer ago than the
   * run cap allows — finish it as incomplete instead of leaving it stuck forever.
   */
  async onStart(): Promise<void> {
    if (this.state.status !== "running" || this.#running) return;
    const startedAtMs = this.state.startedAt ? Date.parse(this.state.startedAt) : NaN;
    const age = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : Number.POSITIVE_INFINITY;
    if (age > RUN_DEADLINE_MS) {
      this.finish("incomplete", "The run was interrupted before it finished.");
      await this.persist().catch((err) => console.error("D1 persist failed (onStart recovery)", this.state.id, err));
    }
  }

  /**
   * SDK-scheduled watchdog callback (see `this.schedule` in `start()`). Runs even if this Durable
   * Object was evicted and restarted since the run began. A no-op if the run already finished.
   */
  async expireRun(): Promise<void> {
    if (this.state.status === "running") {
      this.finish("incomplete", "The run reached its time limit before it could produce a verdict for every claim checked.");
      await this.persist().catch((err) => console.error("D1 persist failed (expireRun watchdog)", this.state.id, err));
    }
  }

  /**
   * CRITICAL fix (item 1 of the LIVE E2E FAILURE writeup): reject any state change that did not
   * originate from this Coordinator's own server-side code. `Agent.setState()` (which every write in
   * this file goes through — pushStep/finish/etc.) always passes `source: "server"`; the ONLY other way
   * a state change reaches here is a client sending a raw `cf_agent_state` protocol frame directly
   * (`WebSockets.applyStateFrame` in the SDK), which passes the originating `Connection` as `source`.
   * Rejecting anything but "server" here closes that off completely: a client can forge a whole
   * Investigation object over the wire, but the write never lands.
   *
   * Deliberately NOT paired with `shouldConnectionBeReadonly() => true` for every connection: verified
   * against the installed SDK (node_modules/agents/dist/src-BNU3ZiJM.js) that `Agent.setState()` throws
   * *before* even reaching this hook when the calling connection is readonly — including when the write
   * happens inside a `@callable()` method invoked over that same connection (RPC dispatch runs inside
   * `runInHostContext(invoke, { connection })`, so `store.connection` is set for the whole call). This
   * app's own live page starts a run via `useAgent()` -> `agent.start(...)` over that same WebSocket
   * (see src/app/components/LiveConnection.tsx), and `start()` itself calls `this.setState(...)`. Making
   * every connection readonly would make the product's own "start an investigation" button throw
   * "Connection is readonly". `validateStateChange` alone fully closes the described vulnerability
   * (forged `cf_agent_state` frames) without that regression, so it is the only override added here.
   */
  validateStateChange(_nextState: Investigation, source: Connection | "server"): void {
    if (source !== "server") {
      throw new Error("State changes must come from the server.");
    }
  }

  private pushStep(step: Omit<Step, "id" | "at">): void {
    const last = this.state.steps[this.state.steps.length - 1];
    if (isDuplicateStep(last, step)) return; // defensive net alongside the item-5 duplicate-push fix below
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
    // Hard backstop (item 2): fires HARD_BACKSTOP_EXTRA_MS after the run deadline no matter what —
    // even if some awaited promise inside executePipeline never settles (a hung call with no timeout of
    // its own). This is a plain in-process timer, not a promise in the pipeline's own chain, so it keeps
    // running regardless of what executePipeline is stuck awaiting. `keepAliveWhile` (in `start()`) keeps
    // this Durable Object instance alive for it to fire; `expireRun`/`onStart` above cover the case where
    // the instance itself doesn't survive that long.
    const backstopTimer = setTimeout(() => {
      if (this.state.status === "running") {
        console.error("Coordinator hard backstop fired", id);
        this.finish("incomplete", "The run reached its time limit before it could produce a verdict for every claim checked.");
        this.persist().catch((err) => console.error("D1 persist failed (hard backstop)", id, err));
      }
    }, RUN_DEADLINE_MS + HARD_BACKSTOP_EXTRA_MS);

    try {
      await this.executePipeline(id, input);
    } catch (err) {
      console.error("Coordinator pipeline crashed", id, err);
      this.finish("error", "The investigation failed unexpectedly. Please try again.");
    } finally {
      clearTimeout(backstopTimer);
      this.#running = false;
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

    // Shared across claims investigated in parallel: the FIRST real search result confirms whether
    // search is actually available, regardless of which claim's scout instance performed it.
    const noteSearchAvailability = (available: boolean) => {
      if (searchModeConfirmed) return;
      searchModeConfirmed = true;
      const confirmed: "full" | "limited" = available ? "full" : "limited";
      if (confirmed !== searchMode) {
        searchMode = confirmed;
        this.setState({ ...this.state, searchMode });
      }
      if (searchMode === "limited") announceLimited();
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

    // 4. Extract claims; fall back to claim discovery via linked pages. Every model call in this
    // function is raced against the run deadline via `withBudget` (item 2): a timeout stops that stage
    // and the pipeline moves on with whatever it already has, instead of hanging.
    const extractorModel = await modelFor(this.env, "extractor").catch(() => "default model");
    let claims: ExtractedClaim[] = [];
    try {
      const budgeted = await withBudget(extractClaims(this.env, page, { max: 6, deadlineMs: deadline }), deadline, "extract");
      if (budgeted.ok) {
        claims = budgeted.value;
      } else {
        this.pushStep({
          agent: "extractor",
          kind: "extract",
          status: "info",
          url: page.finalUrl,
          label: "Claim extraction stopped",
          detail: "Stopped: time budget exceeded before extraction finished.",
        });
      }
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
    if (claims.length > 0) {
      this.pushStep({
        agent: "extractor",
        kind: "extract",
        status: "ok",
        url: page.finalUrl,
        label: `Extracted ${claims.length} claim(s)`,
        detail: `model ${extractorModel}`,
      });
    } else if (Date.now() <= deadline) {
      this.pushStep({
        agent: "extractor",
        kind: "extract",
        status: "info",
        url: page.finalUrl,
        label: "No claims found on the input page",
        detail: `model ${extractorModel}`,
      });
    }

    if (claims.length === 0) {
      const discoveryLinks = scout.rankLinks(page, DISCOVERY_KEYWORDS, 4);
      let tried = 0;
      for (const link of discoveryLinks) {
        if (tried >= MAX_DISCOVERY_LINK_FETCHES || Date.now() > deadline) break;
        tried += 1;
        const linkOutcome = await scout.fetchPage(link.url, { allowCache: true });
        if (!linkOutcome.ok) continue;
        const budgeted = await withBudget(
          extractClaims(this.env, linkOutcome.page, { max: 6, deadlineMs: deadline }),
          deadline,
          "discovery-extract",
        ).catch(() => ({ ok: false, timedOut: true, label: "discovery-extract" }) as const);
        if (budgeted.ok && budgeted.value.length > 0) {
          claims = budgeted.value;
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
        this.investigateClaim(claim, page, id, deadline, noteSearchAvailability).catch((err) => {
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

    // 6. Run status per ARCHITECTURE.md §4: "done" only once at least one investigated claim actually
    // has a verdict; a claim gated to "no verdict yet" by `gateVerdict` does not count.
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
    investigationId: string,
    deadline: number,
    noteSearchAvailability: (available: boolean) => void,
  ): Promise<ClaimResult> {
    const base = emptyClaimResult(claim, page.finalUrl);
    const agentId = specialistKind(claim.type);
    let deadlineHit = false;

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

    // Own scout instance per claim (item 5): claims run concurrently (Promise.all in executePipeline),
    // so a single shared onAttempt closure has no way to know which claim a search/fetch belongs to.
    // createEvidenceScout() has no per-instance state besides a lazily-loaded, read-only official-sources
    // cache, so creating one per claim is cheap and safe. This closure is also the ONLY place a "search"
    // or "fetch" step is pushed for a claim's own discovery/collection work — there is deliberately no
    // second manual push alongside it (that duplicate push was the root cause of every search step
    // appearing twice in the live trace).
    const claimOnAttempt = (a: ScoutAttempt) => {
      if (a.kind === "search") {
        this.pushStep({
          agent: "scout",
          kind: "search",
          status: stepStatusFor(a),
          claimId: claim.claimId,
          label: `Searched: ${a.target}`,
          detail: searchStepDetail(a),
        });
        return;
      }
      this.pushStep({
        agent: "scout",
        kind: "fetch",
        status: stepStatusFor(a),
        url: a.target,
        claimId: claim.claimId,
        label: fetchStepLabel(a),
        detail: fetchStepDetail(a),
      });
    };
    const scout = createEvidenceScout(this.env, { investigationId, onAttempt: claimOnAttempt });

    // a. Plan required evidence with the matching specialist. Never throws (RpcResult contract); a
    // transport-level failure calling the stub itself is still caught below.
    let plan: EvidencePlan;
    try {
      const stub = await this.specialistStub(claim.type);
      // Explicit annotation: the DO RPC stub's return type distributes the `RpcResult` union over
      // `Promise` (`Promise<A> | Promise<B>` instead of `Promise<A | B>`), which defeats `withBudget`'s
      // generic inference if passed directly. Binding it to a plainly-typed `Promise<RpcResult<...>>`
      // first collapses that back to a normal promise `withBudget` can be called with.
      const planCall: Promise<RpcResult<EvidencePlan>> = stub.plan(claim, page.finalUrl, deadline);
      const budgeted = await withBudget(planCall, deadline, "plan");
      if (!budgeted.ok) {
        deadlineHit = true;
        const msg = "Planning stopped: time budget exceeded before this claim's requirements could be determined.";
        base.gaps.push(msg);
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
      const result: RpcResult<EvidencePlan> = budgeted.value;
      if (!result.ok) {
        const msg = rpcFailureMessage(result);
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
      plan = result.value;
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
      detail: summarizeRequired(plan.required), // item 8: at most 4 items, each capped at 120 chars
    });

    // b. Discover candidate sources.
    const officialHits = await scout.officialCandidates(claim, claim.brand).catch(() => [] as SearchHit[]);
    const searchHits: SearchHit[] = [];
    for (const query of plan.queries.slice(0, MAX_DISCOVERY_QUERIES)) {
      if (Date.now() > deadline) {
        deadlineHit = true;
        break;
      }
      // scout.searchWeb() already reports this attempt to claimOnAttempt above (exactly one "search"
      // step per query) — no second push here, unlike the pre-fix version of this loop.
      const res = await scout.searchWeb(query);
      noteSearchAvailability(res.available);
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

    // c. Fetch up to MAX_CANDIDATES_PER_CLAIM candidates, concurrency-limited. Always include the claim's
    // own page. The whole batch is raced against the remaining budget: on timeout, whatever candidates
    // already resolved are kept and the rest are treated as not fetched — never awaited indefinitely.
    const toFetch = candidates.slice(0, MAX_CANDIDATES_PER_CLAIM);
    const overflow = candidates.slice(MAX_CANDIDATES_PER_CLAIM);
    const fetchedPages: FetchedPage[] = [page];
    const checkedUrls: ClaimResult["checkedUrls"] = [{ url: page.finalUrl, status: "fetched" }];

    // Tracked by requested URL (not `checkedUrls`, whose recorded url can be the post-redirect final
    // URL): a candidate the outer race never even started for must still get a checkedUrls entry below.
    const startedUrls = new Set<string>();
    const fetchBatch = withBudget(
      runWithConcurrency(toFetch, MAX_CANDIDATE_CONCURRENCY, async (hit) => {
        startedUrls.add(hit.url);
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
      }),
      deadline,
      "fetch-batch",
    );
    const fetchOutcome = await fetchBatch;
    if (!fetchOutcome.ok) deadlineHit = true;
    for (const extra of toFetch) {
      if (!startedUrls.has(extra.url)) {
        checkedUrls.push({ url: extra.url, status: "skipped", reason: "time budget exceeded before this candidate was fetched" });
      }
    }
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
      selfDeclared: isSelfDeclaredSource(p.issuer, page.issuer, claim.brand),
      passages: selectPassages(p.text, passageKeywords, { max: 6 }),
    }));
    const fetchedIndependentCandidate = sources.some((s) => !s.selfDeclared);

    // e. Assess evidence against requirements.
    let assessment: Assessment;
    try {
      const stub = await this.specialistStub(claim.type);
      // See the matching comment on the `plan()` call above re: the DO RPC stub's distributed-union
      // return type.
      const assessCall: Promise<RpcResult<Assessment>> = stub.assess(claim, plan.required, sources, deadline);
      const budgeted = await withBudget(assessCall, deadline, "assess");
      if (!budgeted.ok) {
        deadlineHit = true;
        const msg = "Assessment stopped: time budget exceeded before the fetched evidence could be evaluated.";
        base.gaps.push(msg);
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
      const result: RpcResult<Assessment> = budgeted.value;
      if (!result.ok) {
        const msg = rpcFailureMessage(result);
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
      assessment = result.value;
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

    // f. Decide the rule verdict, then gate it (item 4): NOT_PUBLICLY_VERIFIABLE only stands after a
    // completed bounded search. BACKED and VAGUE always stand.
    const rule = decideVerdict(claim, plan.required, assessment.evidence, assessment.gaps);
    base.checks = rule.checks;

    const gate = gateVerdict({
      ruleVerdict: rule.verdict,
      searchMode: this.state.searchMode ?? "limited",
      fetchedIndependentCandidate,
      deadlineHit: deadlineHit || Date.now() > deadline,
    });
    base.verdict = gate.verdict;
    if (gate.gap) base.gaps = [...base.gaps, gate.gap];

    this.pushStep({
      agent: "verdict",
      kind: "verdict",
      status: "ok",
      claimId: claim.claimId,
      label: gate.verdict ? `Verdict: ${gate.verdict}` : "Verdict withheld: search not completed",
      detail: [rule.checks.map((c) => `${c.pass ? "✓" : "✗"} ${c.name}`).join("; "), gate.gap].filter(Boolean).join(" — "),
    });

    // g. Draft the next action — or, with less than ACTION_RESERVE_MS left, use a deterministic
    // sentence from the verdict instead of spending the little remaining budget on a model call (item 2).
    const remainingForAction = deadline - Date.now();
    if (remainingForAction < ACTION_RESERVE_MS) {
      base.nextAction = deterministicNextAction(base.verdict);
      this.pushStep({
        agent: "coordinator",
        kind: "action",
        status: "info",
        claimId: claim.claimId,
        label: "Next action set from verdict",
        detail: "Time budget nearly exhausted — used a deterministic action instead of drafting one.",
      });
    } else {
      try {
        const budgeted = await withBudget(
          writeAction(this.env, claim, rule, plan.required, assessment.evidence, assessment.gaps, deadline),
          deadline,
          "action",
        );
        if (budgeted.ok) {
          base.rewrite = budgeted.value.rewrite;
          base.nextAction = budgeted.value.nextAction;
          base.evidenceRequest = budgeted.value.evidenceRequest;
          this.pushStep({
            agent: "coordinator",
            kind: "action",
            status: "ok",
            claimId: claim.claimId,
            label: "Next action drafted",
            detail: budgeted.value.nextAction,
          });
        } else {
          base.nextAction = deterministicNextAction(base.verdict);
          this.pushStep({
            agent: "coordinator",
            kind: "action",
            status: "info",
            claimId: claim.claimId,
            label: "Next action set from verdict",
            detail: "Stopped: time budget exceeded before drafting finished.",
          });
        }
      } catch (err) {
        const msg = modelErrorMessage(err, "Could not draft a next action for this claim.");
        base.nextAction = deterministicNextAction(base.verdict);
        this.pushStep({
          agent: "coordinator",
          kind: "action",
          status: "fail",
          claimId: claim.claimId,
          label: "Action drafting failed",
          detail: msg,
        });
      }
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
