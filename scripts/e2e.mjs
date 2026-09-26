// ProofTrace end-to-end smoke test against a deployed Worker. Node 20+, no dependencies (uses global fetch).
//
// Usage:
//   BASE_URL=https://prooftrace.<sub>.workers.dev node scripts/e2e.mjs
//   BASE_URL=... INPUT_URL="https://www.garnier.co.uk/within-garnier" node scripts/e2e.mjs
//
// Drives the REST API (POST /api/investigate, GET /api/investigations/:id) — the same endpoints the
// Coordinator's WebSocket path complements for the live page. See docs/PLAN.md / docs/ARCHITECTURE.md.

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error("BASE_URL environment variable is required, e.g. https://prooftrace.<sub>.workers.dev");
  process.exit(1);
}
const INPUT_URL = process.env.INPUT_URL || "https://www.garnier.pt/";
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 180_000;
const VALID_VERDICTS = new Set(["BACKED", "VAGUE", "NOT_PUBLICLY_VERIFIABLE"]);

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

function stepLine(step) {
  const detail = step.detail ? ` — ${step.detail}` : "";
  return `[${step.agent}] ${step.label}${detail} (${step.status})`;
}

function inputHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { res, body, text };
}

async function main() {
  const base = BASE_URL.replace(/\/+$/, "");
  console.log(`ProofTrace e2e: POST ${base}/api/investigate  { "url": "${INPUT_URL}" }`);

  const { res: startRes, body: startBody, text: startText } = await fetchJson(`${base}/api/investigate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: INPUT_URL }),
  });
  if (!startRes.ok) {
    fail(`POST /api/investigate returned HTTP ${startRes.status}: ${startText}`);
    return;
  }
  const id = startBody && startBody.id;
  if (!id) {
    fail(`POST /api/investigate did not return an "id": ${startText}`);
    return;
  }
  console.log(`Investigation id: ${id}\n`);

  const startedAt = Date.now();
  const seenStepIds = new Set();
  let investigation = null;

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const { res, body, text } = await fetchJson(`${base}/api/investigations/${id}`);
    if (!res.ok) {
      fail(`GET /api/investigations/${id} returned HTTP ${res.status}: ${text}`);
      return;
    }
    investigation = body;
    for (const step of investigation.steps ?? []) {
      if (seenStepIds.has(step.id)) continue;
      seenStepIds.add(step.id);
      console.log(stepLine(step));
    }
    if (investigation.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (!investigation) {
    fail("Never received an investigation snapshot.");
    return;
  }

  // 1. The run finishes (status not "running") within the wait budget.
  if (investigation.status === "running") {
    fail(`Investigation did not finish within ${MAX_WAIT_MS / 1000}s (still "running" after ${elapsedSec}s).`);
    return;
  }

  // 2. Status is "done" or "incomplete" — never "error".
  if (investigation.status === "error") {
    fail(`Investigation ended in status "error": ${investigation.error ?? "(no error message)"}`);
    return;
  }
  if (investigation.status !== "done" && investigation.status !== "incomplete") {
    fail(`Unexpected status "${investigation.status}".`);
    return;
  }

  // 3. A scout step fetched the input URL successfully.
  const host = inputHostname(INPUT_URL);
  const fetchedInput = (investigation.steps ?? []).some(
    (s) => s.agent === "scout" && s.status === "ok" && typeof s.url === "string" && host && s.url.toLowerCase().includes(host),
  );
  if (!fetchedInput) {
    fail(`No scout step recorded a successful fetch of the input URL (expected a host match for "${host}").`);
    return;
  }

  let verdictCount = 0;
  let evidenceCount = 0;

  if (investigation.status === "done") {
    // 4. At least one claim has a verdict; every evidence quote/url is well formed; every claim has text.
    for (const claim of investigation.claims ?? []) {
      if (!claim.text || claim.text.trim() === "") {
        fail(`Claim ${claim.claimId} has empty text.`);
        return;
      }
      if (claim.verdict === undefined) continue;
      if (!VALID_VERDICTS.has(claim.verdict)) {
        fail(`Claim ${claim.claimId} has an invalid verdict "${claim.verdict}".`);
        return;
      }
      verdictCount += 1;
      for (const ev of claim.evidence ?? []) {
        evidenceCount += 1;
        if (!ev.quote || ev.quote.trim() === "") {
          fail(`Claim ${claim.claimId} has an evidence entry with an empty quote (${ev.url}).`);
          return;
        }
        if (!/^https?:\/\//i.test(ev.url ?? "")) {
          fail(`Claim ${claim.claimId} has an evidence entry with a non-http(s) url: "${ev.url}".`);
          return;
        }
      }
    }
    if (verdictCount === 0) {
      fail('Status "done" but no claim has a verdict.');
      return;
    }
  } else {
    // 5. "incomplete" always carries a user-readable reason.
    if (!investigation.error || investigation.error.trim() === "") {
      fail('Status "incomplete" but no error string was present.');
      return;
    }
    evidenceCount = (investigation.claims ?? []).reduce((n, c) => n + (c.evidence?.length ?? 0), 0);
  }

  const checkedCount = (investigation.claims ?? []).reduce((n, c) => n + (c.checkedUrls?.length ?? 0), 0);

  console.log("\n=== ProofTrace e2e summary ===");
  console.log(`status:       ${investigation.status}`);
  console.log(`duration:     ${elapsedSec}s`);
  console.log(`claims:       ${investigation.claims?.length ?? 0}`);
  console.log(`verdicts:     ${verdictCount}`);
  console.log(`evidence:     ${evidenceCount}`);
  console.log(`checked URLs: ${checkedCount}`);
  if (investigation.error) console.log(`error:        ${investigation.error}`);
  console.log("\nPASS");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
