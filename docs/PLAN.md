# ProofTrace — Two-hour MVP plan

ProofTrace checks a public sustainability claim against saved public evidence and shows its work:
**claim → evidence required → sources checked → evidence found → gaps → verdict → next action.**

Track: AI agents. Team: 2 (Person A = page/data/deployment; Person B = agent pipeline). Time available: **2 hours**.
The implementation contract and model choices are in [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Demo scope

- One Cloudflare Worker serves the React page, API and Agents SDK Durable Objects. Models use only Cloudflare-hosted
  Workers AI IDs (`@cf/`); no external model provider or separate backend.
- The three fixed cases run against source snapshots saved with URLs and retrieval times. A live investigation still
  calls the agents and models; it does not need to fetch a third-party site during the pitch.
- Code alone chooses `BACKED`, `VAGUE` or `NOT_PUBLICLY_VERIFIABLE`. Model text cannot override the verdict.
- Each specialist keeps feedback lessons in its own Durable Object SQLite database. For the MVP, lessons come from
  explicit reviewer feedback; automatic reflection, embeddings and source statistics are deferred.
- A recorded run is visibly labelled **Recorded run**. It is a reliable backup, not a substitute for claiming that a
  model call is live. The page offers **Run live** when enabled.

## 2. Frozen demo cases

Store the exact quotation and its source URL in `demo_cases`. Store the cited page text in `source_snapshots` with a
retrieval timestamp. Preserve the surrounding passage and footnote; do not present a shortened paraphrase as a quote.

| Case | Exact claim to display | Primary source and evidence | Expected result |
|---|---|---|---|
| YSL Libre | “Refilling the Eau de Parfum bottle helps to save 58%* glass, 59%* plastics and, 42%* paper.” | [YSL product page](https://www.yslbeauty.co.uk/fragrances/fragrances-for-her/libre/libre-eau-de-parfum/WW-50424YSL.html?dwvar_WW-50424YSL_size=50+ml). Its footnote compares one refillable 50 ml bottle plus one 100 ml refill with three classic non-refillable 50 ml bottles. | `NOT_PUBLICLY_VERIFIABLE`: comparison baseline is stated, but public component weights or calculation detail are still needed to reproduce the percentages. Flag the refill assumption and draft an evidence request. |
| Garnier | “Garnier is approved by Cruelty Free International” | [Garnier UK page](https://www.garnier.co.uk/within-garnier); verify against the [certifier's Garnier listing](https://www.crueltyfreeinternational.org/approved-brands/listing/garnier/). | `BACKED` for **brand approval** if the saved certifier listing shows Garnier. Do not extend this verdict to every product unless independent evidence confirms that scope. |
| Lush | “Endless heaps of ethically- sourced ingredients” | Heading on [Lush's bath-bomb page](https://www.lush.com/au/en/a/how-make-bath-bombs). The same page names fair trade cocoa butter and says Lush works directly with suppliers and visits them. Keep the source's unusual hyphenation in the exact quote. | `VAGUE` for the broad heading. The rewrite should identify the narrower, attributed examples and avoid treating the brand's own description as independent certification. |

The Lush learning moment is feedback on the **rewrite**, not a claim that the `VAGUE` verdict was wrong. Submit
“Rewrite missed the named cocoa butter and supplier visits.” The sourcing agent saves that lesson. A targeted rerun
uses the same snapshot and shows **Applied lesson: …** with a better rewrite; the verdict remains `VAGUE`. Never replay
an unchanged recording and imply it applied new feedback.

Small print on results: “Based on public sources retrieved [snapshot date]. The absence of public evidence does not
mean a claim is false.” Use each snapshot's actual date rather than a hard-coded date.

## 3. Two-hour build order

| Elapsed time | Person A — page, data, deployment | Person B — agents and rules | Checkpoint |
|---|---|---|---|
| 0:00–0:15 | Scaffold Vite + Worker + Agents SDK; create D1; deploy a page and API response. | Define shared types and deterministic verdict rules; run one schema/tool smoke call on Kimi K2.6 and DeepSeek V4 Pro. | A deployed URL and working model calls. If a model fails, switch to the Cloudflare-hosted fallback immediately. |
| 0:15–0:45 | Seed three cases and source snapshots; build launcher and trace/card UI with fixture data. | Implement the Coordinator's extraction stage and Quantitative Specialist. Finish **YSL** end to end first. | YSL live run displays the exact quote, comparison footnote, gap, verdict and evidence request on the deployed URL. |
| 0:45–1:10 | Add Garnier and Lush source display and case cards. | Add Certification and Sourcing specialists. Reuse the same evidence and verdict contract. | All three cases complete live at least once. Freeze any working path. |
| 1:10–1:30 | Add feedback control and lesson display; add a clearly labelled recorded-run fallback. | Save explicit feedback in Sourcing DO; targeted Lush rerun applies it. Record successful runs. | Reset → baseline Lush → feedback → targeted rerun works; recordings replay accurately. |
| 1:30–1:45 | Polish only broken UI, source links and error messages; capture screenshots and backup video. | Fix schema, timeout or model failures; measure live latency. | Full flow passes on the deployed URL. |
| 1:45–2:00 | Rehearse a two-minute pitch and prepare submission text. | Final deploy and verify one case plus recorded fallback. | Submission assets and backup are ready. |

**Pitch:** Show the YSL trace first; switch to Garnier for the positive contrast; show Lush's vague heading and the
feedback-driven rewrite. Use a measured live run only if it fits the pitch. Otherwise label recorded runs clearly and
offer a separate live run afterward. A 120-second run cap is a failure bound, not a target demo duration.

## 4. Cut order and acceptance

Cut in this order if behind: arbitrary URL/text input, live page fetching, reranking, embeddings, automatic reflection,
source statistics, model-generated coordinator narration, extra knowledge packs, restyling. The three fixed cases,
source links, deterministic verdicts, a visible multi-agent trace and a deployable page stay in scope. If feedback is
not working by 1:30, keep the baseline Lush result and omit the learning claim from the pitch.

The MVP is ready when the deployed URL can: (1) load the three cases; (2) show exact source-backed claims, evidence
requirements and gaps; (3) produce the expected verdicts through code; (4) show agent identities and next actions;
(5) label recorded runs; and (6) show the feedback lesson on a targeted Lush rerun if that feature is demonstrated.

## 5. Decisions

| Item | Decision |
|---|---|
| Cloudflare account | `3550b1d16b78241182c4cb602b695110` (aonishchenko33) in `wrangler.jsonc` |
| Model budget | Quality and correct evidence handling take priority over price. Use only Cloudflare-hosted Workers AI models; verify paid access with real calls. |
| Storage | Durable Object SQLite for per-agent lessons and coordinator state; D1 for demo cases, snapshots, configuration and recorded runs. |
| Evidence request | Draft only; never sent to a brand. |
| Demo reset | Reset specialist lessons to a known baseline and clear demo history; retain snapshots and recorded runs. |
