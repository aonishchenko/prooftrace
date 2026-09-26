// Dev-only mock investigation runner, enabled by `?mock=1`. Emits a realistic
// Investigation sequence over time so the UI can be built/demoed/screenshotted
// without the backend Coordinator running. Modelled on the garnier.pt sample
// case described in docs/PLAN.md.
import type { ClaimResult, Investigation, Step } from "../shared/types";

type Reducer = (prev: Investigation) => Investigation;

function addStep(step: Omit<Step, "id">): Reducer {
  return (prev) => ({
    ...prev,
    steps: [...prev.steps, { ...step, id: `mock-s${prev.steps.length + 1}` }],
  });
}

function addClaim(claim: ClaimResult): Reducer {
  return (prev) => ({ ...prev, claims: [...prev.claims, claim] });
}

function patchClaim(claimId: string, patch: Partial<ClaimResult>): Reducer {
  return (prev) => ({
    ...prev,
    claims: prev.claims.map((c) => (c.claimId === claimId ? { ...c, ...patch } : c)),
  });
}

function setMeta(patch: Partial<Investigation>): Reducer {
  return (prev) => ({ ...prev, ...patch });
}

function compose(...reducers: Reducer[]): Reducer {
  return (prev) => reducers.reduce((state, r) => r(state), prev);
}

interface TimedEvent {
  at: number; // ms since run start; also used as the scheduling delay and Step.at
  apply: Reducer;
}

/**
 * Builds and runs a mock Investigation timeline for `url`, calling `onUpdate`
 * with a new immutable Investigation snapshot on every simulated event.
 * Returns a stop function that cancels any pending events (call on unmount).
 */
export function runMockInvestigation(
  id: string,
  url: string,
  onUpdate: (investigation: Investigation) => void
): () => void {
  const certifierUrl = "https://www.crueltyfreeinternational.org/approved-brands/listing/garnier/";
  const brandReportUrl = "https://www.garnier.pt/sustentabilidade/relatorio";
  const ingredientGlossaryUrl = "https://www.garnier.pt/ingredientes/origem-natural";
  const aggregatorUrl = "https://pt.wikipedia.org/wiki/Garnier";

  const startedAt = new Date().toISOString();
  let state: Investigation = {
    id,
    input: { url, mode: "live" },
    status: "running",
    steps: [],
    claims: [],
    searchMode: "full",
    startedAt,
  };

  const claim1: ClaimResult = {
    claimId: "mock-claim-1",
    text: "Fórmula vegan 97% de origem natural",
    sourceUrl: url,
    type: "quantitative",
    required: [],
    evidence: [],
    gaps: [],
    checkedUrls: [],
  };

  const claim2: ClaimResult = {
    claimId: "mock-claim-2",
    text: "Aprovada pela Cruelty Free International",
    sourceUrl: url,
    type: "certification",
    required: [],
    evidence: [],
    gaps: [],
    checkedUrls: [],
  };

  const claim3: ClaimResult = {
    claimId: "mock-claim-3",
    text: "Embalagem 100% reciclável",
    sourceUrl: url,
    type: "generic",
    required: [],
    evidence: [],
    gaps: [],
    checkedUrls: [],
  };

  const nowIso = () => new Date().toISOString();

  const events: TimedEvent[] = [
    {
      at: 0,
      apply: addStep({
        agent: "coordinator",
        kind: "info",
        label: "Investigation started",
        detail: `Input URL: ${url}`,
        status: "info",
        at: 0,
      }),
    },
    {
      at: 300,
      apply: addStep({
        agent: "scout",
        kind: "fetch",
        label: "Fetching submitted page",
        status: "running",
        url,
        at: 300,
      }),
    },
    {
      at: 1200,
      apply: addStep({
        agent: "scout",
        kind: "fetch",
        label: "Fetched submitted page",
        detail: "200 OK · text extracted via Worker fetch()",
        status: "ok",
        url,
        at: 1200,
      }),
    },
    {
      at: 1500,
      apply: addStep({
        agent: "extractor",
        kind: "extract",
        label: "Extracting sustainability claims",
        status: "running",
        at: 1500,
      }),
    },
    {
      at: 2300,
      apply: compose(
        addClaim(claim1),
        addStep({
          agent: "extractor",
          kind: "extract",
          label: 'Found claim: "Fórmula vegan 97% de origem natural"',
          detail: "Classified as quantitative (ingredient-origin percentage)",
          status: "ok",
          url,
          claimId: claim1.claimId,
          at: 2300,
        })
      ),
    },
    {
      at: 2600,
      apply: compose(
        addClaim(claim2),
        addStep({
          agent: "extractor",
          kind: "extract",
          label: 'Found claim: "Aprovada pela Cruelty Free International"',
          detail: "Classified as certification",
          status: "ok",
          url,
          claimId: claim2.claimId,
          at: 2600,
        })
      ),
    },
    {
      at: 2800,
      apply: compose(
        addClaim(claim3),
        addStep({
          agent: "extractor",
          kind: "extract",
          label: 'Found claim: "Embalagem 100% reciclável"',
          detail: "Classified as generic; not selected for deep investigation in this run",
          status: "info",
          url,
          claimId: claim3.claimId,
          at: 2800,
        })
      ),
    },
    {
      at: 3000,
      apply: addStep({
        agent: "certification",
        kind: "require",
        label: "Certification Specialist reviewing claim",
        status: "running",
        claimId: claim2.claimId,
        at: 3000,
      }),
    },
    {
      at: 3600,
      apply: compose(
        patchClaim(claim2.claimId, {
          required: [
            "Confirmation on the certifier's official register",
            "Certifier is independent of the brand",
            "Listing matches the exact brand name",
          ],
        }),
        addStep({
          agent: "certification",
          kind: "require",
          label: "Requirements defined",
          detail: "Certifier register listing, issuer independence, exact brand match",
          status: "ok",
          claimId: claim2.claimId,
          at: 3600,
        })
      ),
    },
    {
      at: 3900,
      apply: addStep({
        agent: "quantitative",
        kind: "require",
        label: "Quantitative Specialist reviewing claim",
        status: "running",
        claimId: claim1.claimId,
        at: 3900,
      }),
    },
    {
      at: 4500,
      apply: compose(
        patchClaim(claim1.claimId, {
          required: [
            'Definition of "vegan" applied to this formula',
            "Method for calculating percentage of natural origin",
            "Underlying ingredient-origin data or third-party audit",
          ],
        }),
        addStep({
          agent: "quantitative",
          kind: "require",
          label: "Requirements defined",
          detail: "Definition, calculation method, and underlying data or audit for the 97% figure",
          status: "ok",
          claimId: claim1.claimId,
          at: 4500,
        })
      ),
    },
    {
      at: 4900,
      apply: addStep({
        agent: "scout",
        kind: "search",
        label: "Searching: Garnier Cruelty Free International listing",
        status: "running",
        claimId: claim2.claimId,
        at: 4900,
      }),
    },
    {
      at: 5800,
      apply: addStep({
        agent: "scout",
        kind: "search",
        label: "3 results",
        detail: "crueltyfreeinternational.org, garnier.pt, pt.wikipedia.org",
        status: "ok",
        claimId: claim2.claimId,
        at: 5800,
      }),
    },
    {
      at: 6100,
      apply: addStep({
        agent: "scout",
        kind: "open",
        label: "Opening certifier listing",
        status: "running",
        url: certifierUrl,
        claimId: claim2.claimId,
        at: 6100,
      }),
    },
    {
      at: 7000,
      apply: compose(
        patchClaim(claim2.claimId, {
          checkedUrls: [
            ...claim2.checkedUrls,
            { url, status: "fetched" },
            { url: certifierUrl, status: "fetched" },
          ],
        }),
        addStep({
          agent: "scout",
          kind: "open",
          label: "Fetched certifier page",
          detail: "200 OK · Garnier listed as an approved brand",
          status: "ok",
          url: certifierUrl,
          claimId: claim2.claimId,
          at: 7000,
        })
      ),
    },
    {
      at: 7300,
      apply: addStep({
        agent: "scout",
        kind: "search",
        label: "Searching: Garnier vegan formula ingredient-origin methodology",
        status: "running",
        claimId: claim1.claimId,
        at: 7300,
      }),
    },
    {
      at: 8200,
      apply: addStep({
        agent: "scout",
        kind: "search",
        label: "2 results",
        detail: "garnier.pt/sustentabilidade, garnier.pt/ingredientes",
        status: "ok",
        claimId: claim1.claimId,
        at: 8200,
      }),
    },
    {
      at: 8500,
      apply: addStep({
        agent: "scout",
        kind: "open",
        label: "Opening brand sustainability report",
        status: "running",
        url: brandReportUrl,
        claimId: claim1.claimId,
        at: 8500,
      }),
    },
    {
      at: 9600,
      apply: addStep({
        agent: "scout",
        kind: "open",
        label: "Blocked",
        detail: "403 Forbidden — automated access blocked",
        status: "fail",
        url: brandReportUrl,
        claimId: claim1.claimId,
        at: 9600,
      }),
    },
    {
      at: 9900,
      apply: addStep({
        agent: "scout",
        kind: "open",
        label: "Opening ingredient glossary",
        status: "running",
        url: ingredientGlossaryUrl,
        claimId: claim1.claimId,
        at: 9900,
      }),
    },
    {
      at: 10800,
      apply: compose(
        patchClaim(claim1.claimId, {
          checkedUrls: [
            { url, status: "fetched" },
            { url: brandReportUrl, status: "blocked", reason: "403 Forbidden — automated access blocked" },
            { url: ingredientGlossaryUrl, status: "fetched" },
          ],
        }),
        addStep({
          agent: "scout",
          kind: "open",
          label: "Fetched ingredient glossary",
          detail: '200 OK · defines "origem natural" by mass fraction; no per-product % shown',
          status: "ok",
          url: ingredientGlossaryUrl,
          claimId: claim1.claimId,
          at: 10800,
        })
      ),
    },
    {
      at: 11100,
      apply: addStep({
        agent: "certification",
        kind: "match",
        label: "Matching evidence against requirements",
        status: "running",
        claimId: claim2.claimId,
        at: 11100,
      }),
    },
    {
      at: 11800,
      apply: compose(
        patchClaim(claim2.claimId, {
          evidence: [
            {
              url: certifierUrl,
              issuer: "Cruelty Free International",
              quote: "Garnier is an approved brand under the Leaping Bunny programme, verified cruelty-free.",
              retrievedAt: nowIso(),
              cached: false,
              independent: true,
              supports: "full",
              scopeMatch: true,
              satisfies: [
                "Confirmation on the certifier's official register",
                "Certifier is independent of the brand",
                "Listing matches the exact brand name",
              ],
            },
          ],
          checks: [
            { name: "Certifier register confirms brand listing", pass: true },
            { name: "Certifier is independent of Garnier", pass: true },
          ],
        }),
        addStep({
          agent: "certification",
          kind: "match",
          label: "Certifier listing confirms brand approval",
          detail: "Independent register match at brand level",
          status: "ok",
          claimId: claim2.claimId,
          at: 11800,
        })
      ),
    },
    {
      at: 12000,
      apply: addStep({
        agent: "quantitative",
        kind: "match",
        label: "Matching evidence against requirements",
        status: "running",
        claimId: claim1.claimId,
        at: 12000,
      }),
    },
    {
      at: 12700,
      apply: compose(
        patchClaim(claim1.claimId, {
          evidence: [
            {
              url: ingredientGlossaryUrl,
              issuer: "Garnier (brand statement)",
              quote:
                '"Origem natural" refere-se à fração da massa dos ingredientes derivada de fontes naturais, calculada segundo diretrizes internas da marca.',
              retrievedAt: nowIso(),
              cached: false,
              independent: false,
              supports: "partial",
              scopeMatch: true,
              satisfies: ["Method for calculating percentage of natural origin"],
            },
          ],
          checks: [
            { name: "Ingredient-origin methodology published", pass: true },
            { name: "Underlying percentage reproducible from public data", pass: false },
            { name: "Independently audited", pass: false },
          ],
        }),
        addStep({
          agent: "quantitative",
          kind: "match",
          label: "Brand methodology found; underlying data not found",
          detail: "Self-declared calculation method only; no dataset or audit located",
          status: "ok",
          claimId: claim1.claimId,
          at: 12700,
        })
      ),
    },
    {
      at: 12900,
      apply: compose(
        patchClaim(claim1.claimId, {
          gaps: [
            "No third-party audit or published dataset for the 97% figure was found in this search.",
            "The brand's methodology page explains the definition but shows no per-product calculation.",
          ],
        }),
        addStep({
          agent: "quantitative",
          kind: "gap",
          label: "Gap: underlying percentage data not publicly available",
          status: "info",
          claimId: claim1.claimId,
          at: 12900,
        })
      ),
    },
    {
      at: 13000,
      apply: compose(
        patchClaim(claim2.claimId, { verdict: "BACKED" }),
        addStep({
          agent: "verdict",
          kind: "verdict",
          label: "Verdict: BACKED",
          detail: "Independent certifier register confirms brand-level approval",
          status: "ok",
          claimId: claim2.claimId,
          at: 13000,
        })
      ),
    },
    {
      at: 13200,
      apply: compose(
        patchClaim(claim1.claimId, { verdict: "NOT_PUBLICLY_VERIFIABLE" }),
        addStep({
          agent: "verdict",
          kind: "verdict",
          label: "Verdict: NOT PUBLICLY VERIFIABLE",
          detail: "Baseline definition found, but the 97% figure is not reproducible from fetched public sources",
          status: "ok",
          claimId: claim1.claimId,
          at: 13200,
        })
      ),
    },
    {
      at: 13500,
      apply: compose(
        patchClaim(claim2.claimId, {
          nextAction:
            "No action needed for the brand-level approval claim; verify separately before extending it to a specific product.",
        }),
        addStep({
          agent: "coordinator",
          kind: "action",
          label: "Drafted next action",
          detail: "No action needed — claim is backed for brand-level approval",
          status: "ok",
          claimId: claim2.claimId,
          at: 13500,
        })
      ),
    },
    {
      at: 13800,
      apply: compose(
        patchClaim(claim1.claimId, {
          rewrite:
            'Consider: "Formulated to our internal natural-origin ingredient standard" — narrower, and does not assert an unaudited percentage.',
          nextAction:
            "Request the underlying ingredient-origin dataset or an independent audit from Garnier before repeating the 97% figure.",
          evidenceRequest:
            "We could not independently verify the calculation behind \"97% de origem natural\" for this formula. Could you share: (1) the ingredient-level mass-fraction data or dataset used, (2) the calculation methodology in full, and (3) any independent/third-party audit of this figure? (Draft only — not sent.)",
        }),
        addStep({
          agent: "coordinator",
          kind: "action",
          label: "Drafted rewrite suggestion and evidence request",
          detail: "Narrower rewrite plus a draft request for the missing dataset",
          status: "ok",
          claimId: claim1.claimId,
          at: 13800,
        })
      ),
    },
    {
      at: 14100,
      apply: compose(
        setMeta({ status: "done", finishedAt: new Date().toISOString() }),
        addStep({
          agent: "coordinator",
          kind: "info",
          label: "Investigation complete",
          status: "ok",
          at: 14100,
        })
      ),
    },
  ];

  const timers: ReturnType<typeof setTimeout>[] = [];
  for (const event of events) {
    const timer = setTimeout(() => {
      state = event.apply(state);
      onUpdate(state);
    }, event.at);
    timers.push(timer);
  }

  // Emit the initial state synchronously so the UI has something to render immediately.
  onUpdate(state);

  return () => {
    for (const timer of timers) clearTimeout(timer);
  };
}
