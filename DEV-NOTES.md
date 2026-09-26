# ProofTrace: Development Notes

26 September 2026. Build the Studio screen shown in `prooftrace-studio.html`. Match it exactly.

## 1. What it does

A user pastes a product page address or a claim. The agent shows five steps, then one verdict with a next step. There are three verdicts: **Backed**, **Vague** and **Evidence not public**. The demo uses three recorded cases: Garnier (Backed), Lush (Vague) and YSL Beauty (Evidence not public).

## 2. Files

- `prooftrace-studio.html`: the design reference, a working page with all the styles and behaviour.
- `data/case-garnier.json`, `case-lush.json`, `case-ysl.json`: one recorded result each.

## 3. Stack

Next.js (App Router), TypeScript and plain CSS variables in `app/globals.css`. Fonts through `next/font/google`: **Gloock** for the wordmark, headline and claim; **Hanken Grotesk** for the text; **DM Mono** for small labels.

## 4. Colours

| Token | Value | Token | Value |
|---|---|---|---|
| `--bg` | #FCF8F2 | `--accent` (button) | #C4501A |
| `--surface` | #FFFFFF | `--accent-ink` | #FFFFFF |
| `--ink` | #2B2420 | `--mark` (highlight) | #F2B33D |
| `--muted` | #74685F | `--mark-soft` | #FCEBC4 |
| `--faint` | #9A8D83 | `--line` / `--line-2` | #ECE3D8 / #F3ECE3 |

Verdict colours (text on background): Backed #1E6B4E on #E7F3EC · Vague #7A5600 on #FFF1C6 · Evidence not public #B4471A on #FDEBE1. Never use red. Always show verdicts with text and an icon, never colour alone.

## 5. Screen structure

1. **Top bar:** the wordmark "ProofTrace" (Gloock, 26 px) with a marigold bar under "Trace" and a small orange tick. Links on the right: "How it works", "For retailers".
2. **Top row:** the headline "Is this claim backed by evidence?" on the left. On the right, the input with the "Check this claim" button, then an "Examples" row with the three brands.
3. **Left column:** the claim in quotes, a meta line (brand and date checked), a progress line, and "Steps" with five titles.
4. **Right column, one white card:** the verdict pill, `summary` in bold, `tip_short` with a marigold rule on its left, "Evidence" rows (name, status, "Source" link), the next action with a copy button, and a "Next example" link.
5. **Footer:** "A review of public evidence on the date checked. Not a judgement of intent. Not legal advice."

## 6. Behaviour

- The page opens with the Garnier result already showing.
- Choosing an example loads its claim and clears the result.
- "Check this claim" disables the button ("Checking…"). The steps tick off about 900 ms apart, and the progress line fills. Then the verdict pill pops in once.
- Copy buttons show a "Copied" toast. The YSL evidence request is an editable text box.
- `prefers-reduced-motion` turns every animation off.
- Below 900 px everything stacks into one column. Below 520 px the button sits under the input.

## 7. Data contract (`lib/types.ts`)

```ts
type Verdict = 'backed' | 'vague' | 'not_public';
interface CaseResult {
  id: string; brand: string; claim_text: string; claim_short: string;
  source_url: string; checked_on: string;
  steps: { title: string; detail: string; source: string }[];
  verdict: Verdict; headline: string; summary: string; tip_short: string;
  evidence: { name: string; status: 'found' | 'partial' | 'not_found'; url: string | null }[];
  next_action: { type: 'share' | 'rewrite' | 'request'; label: string; text: string };
}
```

The case files hold extra fields (`why`, `takeaway`, `team_check`). Ignore them for now, and never show `team_check`.

## 8. Server

- `POST /api/check` with `{ "input": "..." }`. It streams `{ "type": "step" }` events, then `{ "type": "result", "data": CaseResult }`.
- With `NEXT_PUBLIC_USE_MOCK=true`, match the input to a case file and replay it. Build the whole screen in mock mode first. Keep mock mode for the demo.

## 9. Claude Code prompts, in order

1. "Read DEV-NOTES.md and open prooftrace-studio.html. Set up the colours, fonts and types. Stop and show me."
2. "Build the top bar, wordmark and top row to match the design."
3. "Build the claim column, steps and result card in mock mode, using the files in `data/`."
4. "Add the motion, the toast, reduced motion and the mobile layout. Check at 390 px."
5. "Connect to `/api/check` when mock mode is off."

## 10. Before the demo

Replace the Lush placeholder claim with the exact wording from lush.com. Recheck the Garnier listing and the YSL figures on the day. Words never shown: false, fake, misleading, greenwashing, illegal.
