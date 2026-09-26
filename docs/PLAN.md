# ProofTrace — Implementation Plan

ProofTrace is a team of specialist AI agents that checks a sustainability claim against public evidence and shows its
work: **claim → evidence required → sources checked → evidence found → gaps → verdict → next action.**

Track: AI agents. Build time: 4 hours. Team: 2 (Person A = product/frontend/data, Person B = agents).
**Technical design: [ARCHITECTURE.md](ARCHITECTURE.md).** This file covers what to build, in what order, and who does it.

---

## 1. Principles

1. **Everything on Cloudflare.** Models come from Workers AI (Cloudflare-hosted, paid from the account's credits).
   There is no external model provider and no separate backend (no Railway).
2. **Specialist agents.** Each agent has its own instructions, knowledge, model and **its own database**, and it learns
   from past cases in its specialty.
3. **Code decides verdicts.** Agents extract, reason and collect evidence; rules pick BACKED / VAGUE /
   NOT PUBLICLY VERIFIABLE.
4. **Demo starts pre-built.** The common database (D1) already holds the demo cases, stored source pages, recorded runs,
   configuration and starting lessons. One click runs a case, and one click resets the demo.

## 2. Agent team (details in ARCHITECTURE.md §2–3)

| Agent | Model |
|---|---|
| Coordinator | GLM-4.7 Flash |
| Claim Extractor | Kimi K2.6 |
| Certification Specialist | DeepSeek V4 Flash |
| Quantitative Specialist | DeepSeek V4 Pro |
| Sourcing & Language Specialist | GLM-5.3 |
| Verdict & Action Agent | rules in code + Kimi K2.6 |

---

## 3. Demo cases (freeze at 0:30; quote exactly, with URL)

| Case | Claim (exact public wording) | Specialist | Expected result |
|---|---|---|---|
| Garnier | Approved by Cruelty Free International under the Leaping Bunny programme (5 Mar 2021, all products) | Certification | 🟢 BACKED, confirmed on the certifier's register |
| Lush | "Ethically sourced ingredients". *To do: exact quote + URL* | Sourcing & Language | 🟡 VAGUE. The phrase is vague, not the company. The rewrite uses Lush's real facts: buying direct from producers, cocoa butter certified fair-trade and organic |
| YSL Libre refill | "Save 58% glass, 59% plastics and 42% paper" vs 3 non-refillable 50 ml bottles | Quantitative | 🟠 NOT PUBLICLY VERIFIABLE: baseline ✓, component weights ✗, refill assumption flagged, evidence request drafted |

**Pitch order (2 minutes):**
1. YSL live: the strongest moment.
2. Garnier: a contrast that shows the agents don't fail every claim.
3. Lush with the learning moment: mark the verdict "Wrong, because Lush names fair-trade cocoa butter", re-run it, and
   the card shows "Applied lesson: …" with a sharper rewrite.

Small print on every result: *"Based on public sources retrieved 26 Sept 2026. The absence of public evidence does not
mean a claim is false."*

---

## 4. Timeline and split

| Time | Person A — frontend / data / demo | Person B — agents |
|---|---|---|
| 0:00–0:30 | Scaffold (Vite + Worker + Agents SDK), `wrangler d1 create prooftrace`, create the AI Gateway, `0001_schema.sql`, deploy "hello" once to prove the deploy pipeline works. Write `mock.ts` | Write `types.ts`, `rules.ts`, the knowledge packs and `seed_lessons`. Capture the Lush quote. **Test one tool call on each chosen model**, especially DeepSeek V4 Pro. **0:30: both people sign off on the contract and the demo cases** |
| 0:30–1:45 | Page: demo launcher (from `demo_cases`), live trace with one lane per agent, claim cards, "Request Missing Evidence" modal. Seed files `0002`–`0004`, including `source_snapshots` of the demo pages | `SpecialistAgent` base (model calls, own-database lessons, tools, reflection), Coordinator, Extractor, Certification Specialist. First end-to-end run on the Garnier case |
| 1:45–2:30 | Switch from the mock to the real Coordinator. Add the "What this agent has learned" panel (reads each agent's lessons), the feedback buttons and `/api/demo/reset` | Quantitative + Sourcing specialists, Verdict & Action agent, feedback → lesson flow |
| 2:30–3:10 | Polish the 3 demo flows and the learning moment on the **deployed** URL | Run each case live, `npm run record` → `0005_recorded_runs.sql`, add replay mode |
| 3:10–3:40 | Rehearse the pitch. **Record the backup video** | Fix bugs and latency. Check cost per agent in AI Gateway |
| 3:40–4:00 | Submission text and screenshots | Final deploy + reseed. Check reset → 3 cases → learning moment on the deployed URL |

**Cut order if behind:**
1. Arbitrary URL input.
2. Reranker passage selection.
3. Merge the Quantitative and Sourcing specialists into one agent that keeps both knowledge packs.
4. Source-reliability stats.
5. The page restyle.

Feedback lessons and demo reset are the last things to cut, because they make the learning demo work.

**Always keep:** the specialist agents visible in the trace, and claim → reasoning → evidence → gap → verdict → next
action.

---

## 5. Decisions and open items

| Item | Decision |
|---|---|
| Cloudflare account | `3550b1d16b78241182c4cb602b695110` (aonishchenko33), pinned in `wrangler.jsonc` |
| Models | Workers AI (Cloudflare-hosted) only, one model per agent. Models can be swapped in `agent_config` without a redeploy |
| Backend | Cloudflare Worker only. **No Railway** |
| Storage | Each agent has its own Durable Object SQLite database (its experience). The common D1 database holds demo data, configuration, knowledge and history. Supabase only if D1 proves insufficient |
| Web search | None. Curated trusted sources per specialist, with demo pages pre-stored in D1 |
| DeepSeek V4 Pro tool calling | Verify at 0:30. Fallback: Nemotron 3 120B |
| Lush exact quote + URL | Open. Person B, before 0:30 |
| Evidence request | Draft only, never sent to any brand |
