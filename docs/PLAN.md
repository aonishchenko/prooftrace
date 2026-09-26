# ProofTrace — URL-first two-hour MVP plan

ProofTrace starts with a **URL supplied by the user**. The app opens that page, extracts its sustainability claims,
searches the public web for relevant evidence, fetches the promising sources, and shows **claim → evidence required →
searches and pages checked → evidence found → gaps → verdict → next action**. A result must distinguish “not found in
this bounded search” from “does not exist.” The [architecture](ARCHITECTURE.md) assigns each collection step.

Track: AI agents. Team: 2 (Person A = page/data/deployment; Person B = agent pipeline). Time available: 2 hours.
The core demo is a live URL investigation. Recorded runs are labelled backup material only.

## 1. Non-negotiable MVP path

1. User pastes a public `https://` product or brand URL and clicks **Investigate**. Three sample URLs prefill the same
   field; they do not bypass collection.
2. The **Evidence Scout** fetches the submitted page at run time, using Cloudflare Browser Run for rendered pages and
   Worker `fetch()` for simple HTML. It records the final URL, fetch status, retrieval time, text and links.
3. Kimi K2.6 extracts the claim **verbatim** from that live page and classifies it. The user can see the source quote.
4. The matching specialist lists what evidence would substantiate that claim and proposes targeted web queries. The
   Evidence Scout executes the searches, fetches candidate pages, and records successful and failed attempts. Snippets never
   count as evidence.
5. The specialist assesses the fetched pages with exact quotes, issuer, independence, scope and missing items.
   Deterministic code chooses the verdict. The page streams the trace and shows linked evidence and next action.

The MVP uses Cloudflare-hosted Workers AI models only. A web search API supplies **URLs**, not model inference;
the Worker and Browser Run fetch those URLs and the specialists inspect the returned pages. Use the [Tavily Search
API](https://docs.tavily.com/documentation/api-reference/endpoint/search) for broad discovery; keep its key in a
Worker secret. If search credentials are unavailable, link-following and known certifier lookups still work, but the
UI must say **Limited search** and the URL-first MVP is not considered complete.

Bound each investigation to about three search queries, eight fetched candidate pages and a 120-second run cap.
Prioritize official certifier registers, brand methodology reports and primary documents. Respect blocked pages and
show them as unchecked; never infer a negative result from a fetch error. A previously fetched page may be reused
only with its cache date displayed. At least the submitted URL is fetched live for a **Live run**.

## 2. Demo URLs and expected checks

These URLs are examples for the input field and regression checks, not pre-computed inputs to the agents. Save
recorded successful runs as a clearly labelled fallback after the live pipeline works.

| Input URL | Claim to verify from the fetched page | Independent/extra source to discover and fetch | Expected result |
|---|---|---|---|
| [YSL Libre product page](https://www.yslbeauty.co.uk/fragrances/fragrances-for-her/libre/libre-eau-de-parfum/WW-50424YSL.html?dwvar_WW-50424YSL_size=50+ml) | “Refilling the Eau de Parfum bottle helps to save 58%* glass, 59%* plastics and, 42%* paper.” Preserve its footnote comparing one refillable 50 ml bottle and one 100 ml refill with three classic 50 ml bottles. | Search for published component weights, calculation method or an independently checked packaging assessment. | `NOT_PUBLICLY_VERIFIABLE` if the baseline is found but those figures cannot be reproduced from fetched public documents. Draft a request for the missing data. |
| [Garnier UK page](https://www.garnier.co.uk/within-garnier) | “Garnier is approved by Cruelty Free International” | Fetch the [certifier's Garnier listing](https://www.crueltyfreeinternational.org/approved-brands/listing/garnier/) through discovery or a certifier directory lookup. | `BACKED` for brand approval when the live certifier page confirms it. Do not extend that result to every product unless its scope is independently confirmed. |
| [Lush bath-bomb page](https://www.lush.com/au/en/a/how-make-bath-bombs) | “Endless heaps of ethically- sourced ingredients” (source heading; retain its spelling). | Search for sourcing policy or named ingredient evidence, then fetch the pages. The starting page itself names fair trade cocoa butter and supplier visits. | `VAGUE` for the broad heading. Attribute narrower examples to their issuer; do not label Lush's own statements as independent certification. |

Small print: “Based on public pages retrieved [actual timestamps]. This search may not cover every source. The absence
of public evidence does not mean a claim is false.”

## 3. Two-hour build order

| Elapsed | Person A — page and deployment | Person B — collection and agents | Checkpoint |
|---|---|---|---|
| 0:00–0:15 | Scaffold and deploy the Worker + React URL form. Configure D1, AI, Browser Run binding and `TAVILY_API_KEY` secret. | Implement shared types, URL validation and one real `fetch_page` call. Smoke test Kimi and DeepSeek Pro on the account. | Deployed page can fetch a user URL; search API and model access are known. |
| 0:15–0:40 | Build streaming trace with fetched URL, status, quote and timestamps. | Implement live page extraction and exact claim extraction. | Paste the YSL URL; the app retrieves its claim and footnote without a saved snapshot. |
| 0:40–1:10 | Build evidence cards, attempted-source list and error/limited-search states. | Add Evidence Scout `search_web` + fetch of ranked results, then Quantitative Specialist and verdict rules. | YSL URL runs end to end with real searches and fetched evidence/gaps. |
| 1:10–1:35 | Add the Garnier and Lush sample URL buttons and result views. | Add Certification and Sourcing Specialists, official-source prioritization and reusable source cache. | All three sample URLs finish on the deployed URL; each trace shows which pages were actually fetched. |
| 1:35–1:50 | Capture screenshots and backup video; record clearly labelled replay runs. | Fix failures and latency, verify source citations and scope checks. | One live URL run plus all three recorded backups work. |
| 1:50–2:00 | Rehearse two-minute pitch and prepare submission text. | Final deploy and URL-to-verdict smoke test. | Submission assets ready. |

**Pitch:** Paste and investigate one URL live if measured latency fits. Show the fetched page, web searches, opened
sources and verdict. Use labelled recordings for the other cases. The 120-second cap is a failure bound, not a target
pitch duration.

## 4. Cut order and acceptance

Cut feedback learning, per-agent lesson databases, embeddings, reranking, automatic reflection, extra claim types,
polish and arbitrary multi-claim pages before cutting live URL collection. Keep URL input, live fetch, claim extraction,
targeted web search, source fetches, visible attempt log, evidence evaluation and a deterministic verdict. The
Evidence Scout is a module inside the Coordinator for this MVP; its ownership and trace stages remain explicit.

The MVP is ready when a **new user-supplied public URL** (within the supported claim types) can reach a verdict with
at least the submitted page fetched live and its public evidence search documented. A sample-only snapshot runner
does not meet this acceptance criterion. For blocked, unsupported or timed-out pages, show an incomplete result and
the reason rather than a fabricated verdict.

## 5. Decisions and setup

| Item | Decision |
|---|---|
| Cloudflare account | `3550b1d16b78241182c4cb602b695110` (aonishchenko33) in `wrangler.jsonc` |
| Models | Cloudflare-hosted Workers AI (`@cf/`) only; quality takes priority over price. See architecture model table. |
| Web discovery | Tavily Search returns candidate URLs. It is a search data service, not an AI model; use `TAVILY_API_KEY` as a Worker secret. Brave is an optional fallback. |
| Page collection | Worker `fetch()` for simple pages; Cloudflare Browser Run Markdown/links for rendered or difficult pages. |
| Storage | D1 stores investigation history, fetched-page cache, search/fetch attempts and recordings. Per-agent lessons are deferred. |
| Evidence request | Draft only; never sent to a brand. |
