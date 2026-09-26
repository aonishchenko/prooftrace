// Evidence Scout: the only module that touches the network on ProofTrace's behalf.
// See docs/ARCHITECTURE.md §1 ("Fetch and discovery tools" / "Bounded investigation loop").
//
// Every public method here is designed to never throw: a failed fetch, search or D1
// write becomes a recorded attempt with a user-readable reason, not an exception that
// would abort the Coordinator's run.

import type { ClaimType } from "../shared/types";
import type {
  EvidenceScout,
  FetchedPage,
  FetchOutcome,
  PageLink,
  ScoutAttempt,
  ScoutOptions,
  SearchHit,
} from "../shared/internal";
import { validatePublicUrl } from "./url-safety";
import { extractLinks, htmlToText, issuerOf, MAX_PAGE_CHARS, normalizeWhitespace, sha256Hex } from "./text";

const DEFAULT_TIMEOUT_MS = 15000; // total budget per fetchPage call: fetch + any browser fallback combined
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_BROWSER_JSON_BYTES = 2 * 1024 * 1024; // cap on Browser Run quickAction JSON response bodies
const MAX_REDIRECTS = 5;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED_LINKS = 300;
/** HTTP statuses worth retrying in the headless browser (bot walls, rate limiting). Any other
 * 4xx/5xx is treated as a real, final response — never masked by a "successful" browser render. */
const BROWSER_ELIGIBLE_STATUSES = new Set([401, 403, 429, 503]);
// Fixed, user-readable reasons for browser-fallback failures. Provider error strings
// (markdownRes.errors[0].message, thrown exceptions, etc.) are logged via console.error and never
// surfaced here — they may contain provider-internal detail that shouldn't reach the UI/D1.
const BROWSER_ERROR_GENERIC = "The page could not be rendered in the browser.";
const BROWSER_ERROR_BUSY = "The rendering service is busy; try again later.";
const BROWSER_ERROR_BLOCKED_403 = "The site blocked automated access (HTTP 403).";
const BROWSER_ERROR_TIMEOUT = "The page took too long to respond.";
const BROWSER_TIMEOUT_SENTINEL = "evidence-scout:browser-action-timeout";
const ACCEPTABLE_CONTENT_TYPES = ["text/html", "text/plain", "application/xhtml+xml"];
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ProofTrace/0.1 (+claim verification research)";
const ACCEPT_HEADER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const ACCEPT_LANGUAGE = "en,pt;q=0.9";
const CHALLENGE_MARKERS = [
  "just a moment",
  "access denied",
  "captcha",
  "attention required",
  "checking your browser",
  "enable javascript and cookies",
  "verify you are a human",
];
const NAV_NOISE_RE = /(login|signin|sign-in|log-in|cart|checkout|cookie|privacy|terms|contact|sitemap|account|search)/i;
const ASSET_EXT_RE = /\.(css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|mp4|mp3|zip)(?:[?#]|$)/i;

interface OfficialSourceRow {
  id: string;
  name: string;
  domain: string;
  claim_types: string;
  keywords: string;
  lookup_url_pattern: string | null;
  independent: number;
  notes: string | null;
}

interface SourcePageRow {
  id: string;
  requested_url: string;
  final_url: string;
  issuer: string;
  title: string | null;
  text: string;
  links_json: string;
  content_hash: string;
  http_status: number | null;
  fetch_method: string;
  fetched_at: string;
  expires_at: string;
}

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

function looksLikeChallenge(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 1500) return false;
  const lower = trimmed.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

/** Heuristic for a JS-rendered shell: an empty SPA root element, or lots of scripts and little text. */
function looksJsRendered(html: string, text: string): boolean {
  const hasEmptyRoot = /<div[^>]*\bid=["'](root|app|__next|___gatsby)["'][^>]*>\s*<\/div>/i.test(html);
  if (hasEmptyRoot) return true;
  const scriptCount = (html.match(/<script\b/gi) || []).length;
  return scriptCount > 8 && text.length < 600;
}

function firstMarkdownHeading(markdown: string): string {
  const match = /^#{1,6}\s+(.+)$/m.exec(markdown);
  return match ? normalizeWhitespace(match[1]) : "";
}

function normalizeMarkdownWhitespace(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function slugify(brand: string): string {
  return stripDiacritics(brand.toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type RedirectOutcome =
  | { ok: true; response: Response; finalUrl: URL }
  | { ok: false; kind: "timeout" }
  // A genuine transport-level failure (DNS, connection refused, TLS, ...) on any hop. Not a
  // safety verdict, so the browser fallback is still allowed to try the original URL itself.
  | { ok: false; kind: "network"; reason: string }
  // The redirect chain itself failed URL-safety validation (too many hops, missing/invalid
  // Location, or the target rejected by validatePublicUrl). Retrying via the browser would just
  // repeat the same unvalidated redirect there — see fetchPageInner, defect #3 — so this kind must
  // never fall back to the browser.
  | { ok: false; kind: "ssrf"; reason: string };

type BrowserOutcome = { ok: true; page: FetchedPage } | { ok: false; reason: string };
type BrowserActionOutcome = { ok: true; response: Response } | { ok: false; reason: string };

export function createEvidenceScout(env: Env, opts: ScoutOptions): EvidenceScout {
  let officialRows: OfficialSourceRow[] | null = null;

  async function recordAttempt(attempt: ScoutAttempt): Promise<void> {
    opts.onAttempt(attempt);
    try {
      await env.DB.prepare(
        `INSERT INTO source_attempts (investigation_id, kind, target, status, reason, method, result_count, ms, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
        .bind(
          opts.investigationId,
          attempt.kind,
          attempt.target,
          attempt.status,
          attempt.reason ?? null,
          attempt.method ?? null,
          attempt.resultCount ?? null,
          Math.round(attempt.ms),
          new Date().toISOString(),
        )
        .run();
    } catch (err) {
      console.error("evidence-scout: failed to record attempt", err);
    }
  }

  async function tryCache(requestedUrl: string, normalizedUrl: string): Promise<FetchedPage | null> {
    try {
      const nowIso = new Date().toISOString();
      const row = await env.DB.prepare(
        `SELECT * FROM source_pages WHERE (requested_url = ?1 OR final_url = ?2) AND expires_at > ?3 ORDER BY fetched_at DESC LIMIT 1`,
      )
        .bind(requestedUrl, normalizedUrl, nowIso)
        .first<SourcePageRow>();
      if (!row) return null;

      let links: PageLink[] = [];
      try {
        links = JSON.parse(row.links_json);
      } catch {
        links = [];
      }

      return {
        requestedUrl: row.requested_url,
        finalUrl: row.final_url,
        httpStatus: row.http_status ?? 0,
        method: "cache",
        title: row.title ?? "",
        text: row.text,
        links,
        fetchedAt: row.fetched_at,
        cached: true,
        contentHash: row.content_hash,
        issuer: row.issuer,
      };
    } catch (err) {
      console.error("evidence-scout: cache lookup failed", err);
      return null;
    }
  }

  async function savePage(page: FetchedPage, httpStatus: number, fetchMethod: "fetch" | "browser"): Promise<void> {
    try {
      const id = await sha256Hex(page.finalUrl);
      const fetchedAtMs = Date.parse(page.fetchedAt);
      const baseMs = Number.isFinite(fetchedAtMs) ? fetchedAtMs : Date.now();
      const expiresAt = new Date(baseMs + CACHE_TTL_MS).toISOString();
      const linksJson = JSON.stringify(page.links.slice(0, MAX_CACHED_LINKS));

      await env.DB.prepare(
        `INSERT OR REPLACE INTO source_pages
           (id, requested_url, final_url, issuer, title, text, links_json, content_hash, http_status, fetch_method, fetched_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
        .bind(
          id,
          page.requestedUrl,
          page.finalUrl,
          page.issuer,
          page.title,
          page.text,
          linksJson,
          page.contentHash,
          httpStatus,
          fetchMethod,
          page.fetchedAt,
          expiresAt,
        )
        .run();
    } catch (err) {
      console.error("evidence-scout: failed to save source page", err);
    }
  }

  async function readCappedText(response: Response, maxBytes: number): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      return text.length > maxBytes ? text.slice(0, maxBytes) : text;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // best-effort only
      }
    }

    const merged = new Uint8Array(Math.min(total, maxBytes));
    let offset = 0;
    for (const chunk of chunks) {
      const remaining = merged.length - offset;
      if (remaining <= 0) break;
      const take = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      merged.set(take, offset);
      offset += take.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(merged);
  }

  // Takes the caller's AbortSignal rather than owning a timer itself: the caller keeps the same
  // controller alive through body-reading too, so one budget covers the whole network phase
  // (defect #1). Every 3xx response's body is cancelled immediately since it is never read.
  async function fetchWithRedirects(startUrl: URL, signal: AbortSignal): Promise<RedirectOutcome> {
    let current = startUrl;
    let redirects = 0;
    for (;;) {
      let response: Response;
      try {
        response = await fetch(current.href, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: {
            "User-Agent": USER_AGENT,
            Accept: ACCEPT_HEADER,
            "Accept-Language": ACCEPT_LANGUAGE,
          },
        });
      } catch (err) {
        if (signal.aborted) return { ok: false, kind: "timeout" };
        return { ok: false, kind: "network", reason: "A network error occurred while fetching the page." };
      }

      if (response.status >= 300 && response.status < 400) {
        try {
          await response.body?.cancel();
        } catch {
          // best-effort only
        }

        if (redirects >= MAX_REDIRECTS) {
          return { ok: false, kind: "ssrf", reason: "Too many redirects." };
        }
        const location = response.headers.get("location");
        if (!location) {
          return { ok: false, kind: "ssrf", reason: `Redirect (${response.status}) had no Location header.` };
        }
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, current);
        } catch {
          return { ok: false, kind: "ssrf", reason: "Redirected to an invalid URL." };
        }
        const nextCheck = validatePublicUrl(nextUrl.href);
        if (!nextCheck.ok) {
          return { ok: false, kind: "ssrf", reason: `Redirect target rejected: ${nextCheck.reason}` };
        }
        current = nextCheck.url;
        redirects += 1;
        continue;
      }

      return { ok: true, response, finalUrl: current };
    }
  }

  /**
   * Runs one Browser Run quickAction call, bounded by our own timer rather than trusting the
   * provider's `gotoOptions.timeout` alone (defect #2): Workers has a small concurrent-connection
   * limit, so a hung call must still let this function return within budget. The action's own
   * eventual settlement is still awaited internally by Promise.race, so nothing is left dangling
   * from this function's point of view.
   */
  async function raceBrowserAction(action: Promise<Response>, timeoutMs: number): Promise<BrowserActionOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(BROWSER_TIMEOUT_SENTINEL)), timeoutMs);
    });
    try {
      const response = await Promise.race([action, timeout]);
      return { ok: true, response };
    } catch (err) {
      if (err instanceof Error && err.message === BROWSER_TIMEOUT_SENTINEL) {
        return { ok: false, reason: BROWSER_ERROR_TIMEOUT };
      }
      console.error("evidence-scout: browser action call failed", err);
      return { ok: false, reason: BROWSER_ERROR_GENERIC };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reads a quickAction Response's JSON body under the same byte cap as page bodies, so a huge
   * or drip-fed provider response can't stall or blow memory. A cap-truncated body simply fails
   * to parse as JSON, which is treated as a browser failure rather than attempted partial use. */
  async function readCappedJson<T>(response: Response): Promise<T | null> {
    try {
      const text = await readCappedText(response, MAX_BROWSER_JSON_BYTES);
      return JSON.parse(text) as T;
    } catch (err) {
      console.error("evidence-scout: browser response body was not valid JSON (possibly truncated at the byte cap)", err);
      return null;
    }
  }

  function browserFailureReason(httpStatus: number): string {
    if (httpStatus === 429 || httpStatus === 503) return BROWSER_ERROR_BUSY;
    if (httpStatus === 403) return BROWSER_ERROR_BLOCKED_403;
    return BROWSER_ERROR_GENERIC;
  }

  async function fetchViaBrowser(requestedUrl: string, targetUrl: string, timeoutMs: number): Promise<BrowserOutcome> {
    try {
      const gotoTimeout = Math.min(20000, Math.max(5000, timeoutMs));

      const [markdownSettled, linksSettled] = await Promise.allSettled([
        raceBrowserAction(
          env.BROWSER.quickAction("markdown", {
            url: targetUrl,
            gotoOptions: { waitUntil: "networkidle2", timeout: gotoTimeout },
          }),
          timeoutMs,
        ),
        raceBrowserAction(env.BROWSER.quickAction("links", { url: targetUrl, visibleLinksOnly: false }), timeoutMs),
      ]);

      const markdownOutcome: BrowserActionOutcome =
        markdownSettled.status === "fulfilled" ? markdownSettled.value : { ok: false, reason: BROWSER_ERROR_GENERIC };
      if (markdownSettled.status === "rejected") {
        console.error("evidence-scout: markdown action rejected unexpectedly", markdownSettled.reason);
      }
      if (!markdownOutcome.ok) {
        return { ok: false, reason: markdownOutcome.reason };
      }

      const markdownJson = await readCappedJson<BrowserRunMarkdownSuccessResponse | BrowserRunErrorResponse>(
        markdownOutcome.response,
      );
      if (!markdownJson || markdownJson.success !== true) {
        console.error("evidence-scout: browser markdown action failed", markdownOutcome.response.status, markdownJson);
        return { ok: false, reason: browserFailureReason(markdownOutcome.response.status) };
      }

      const text = normalizeMarkdownWhitespace(markdownJson.result).slice(0, MAX_PAGE_CHARS);
      if (text.length === 0) {
        return { ok: false, reason: "Browser rendering returned no readable text." };
      }
      if (looksLikeChallenge(text)) {
        return { ok: false, reason: "The site presented a bot-challenge or access-denied page even in the browser." };
      }

      // The finalUrl the browser actually rendered must itself pass URL-safety validation before
      // any content is kept — silently keeping content when the browser followed an unvalidated
      // redirect (or when we can't tell whether it did) is exactly the SSRF gap defect #3 flags.
      const meta = markdownJson.meta;
      let finalUrl: string;
      if (meta?.finalUrl) {
        const check = validatePublicUrl(meta.finalUrl);
        if (!check.ok) {
          return { ok: false, reason: "The page redirected to a location that could not be verified as safe." };
        }
        finalUrl = check.url.href;
      } else if (meta?.redirectChain && meta.redirectChain.length > 0) {
        // Redirects happened but the provider didn't tell us where we ended up — can't verify it.
        return { ok: false, reason: "The page redirected to a location that could not be verified as safe." };
      } else {
        // No redirect info at all: the browser navigated straight to targetUrl, which the caller
        // already validated with validatePublicUrl before ever invoking fetchViaBrowser.
        finalUrl = targetUrl;
      }

      let links: PageLink[] = [];
      const linksOutcome: BrowserActionOutcome | null = linksSettled.status === "fulfilled" ? linksSettled.value : null;
      if (linksSettled.status === "rejected") {
        console.error("evidence-scout: links action rejected unexpectedly", linksSettled.reason);
      }
      if (linksOutcome?.ok) {
        const linksJson = await readCappedJson<BrowserRunLinksSuccessResponse | BrowserRunErrorResponse>(
          linksOutcome.response,
        );
        if (linksJson?.success) {
          const deduped = new Set<string>();
          for (const href of linksJson.result) {
            let resolved: URL;
            try {
              resolved = new URL(href, finalUrl);
            } catch {
              continue;
            }
            if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
            resolved.hash = "";
            if (deduped.has(resolved.href)) continue;
            deduped.add(resolved.href);
            links.push({ url: resolved.href, text: "" });
          }
        }
      }
      // A links failure never blocks the markdown result — it only means an empty link list.

      // `meta.status` is the HTTP status of the page the browser actually rendered; carry it
      // through rather than hard-coding 200 (defect #8). 200 is used only when the provider omits
      // it, which is an undocumented edge case.
      const httpStatus = typeof meta?.status === "number" ? meta.status : 200;

      const page: FetchedPage = {
        requestedUrl,
        finalUrl,
        httpStatus,
        method: "browser",
        title: firstMarkdownHeading(markdownJson.result),
        text,
        links,
        fetchedAt: new Date().toISOString(),
        cached: false,
        contentHash: await sha256Hex(text),
        issuer: issuerOf(finalUrl),
      };
      return { ok: true, page };
    } catch (err) {
      console.error("evidence-scout: browser fallback failed", err);
      return { ok: false, reason: BROWSER_ERROR_GENERIC };
    }
  }

  async function fetchPageInner(
    requestedUrl: string,
    fetchOpts: { allowCache?: boolean; timeoutMs?: number },
  ): Promise<FetchOutcome> {
    const allowCache = fetchOpts.allowCache ?? true;
    const timeoutMs = fetchOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();
    // Absolute deadline for the whole call: fetch attempt + any browser fallback combined never
    // exceed `timeoutMs` in total (defect #9), rather than each phase getting its own full budget.
    const deadline = start + timeoutMs;

    const check = validatePublicUrl(requestedUrl);
    if (!check.ok) {
      await recordAttempt({ kind: "fetch", target: requestedUrl, status: "skipped", reason: check.reason, ms: Date.now() - start });
      return { ok: false, url: requestedUrl, status: "skipped", reason: check.reason };
    }

    if (allowCache) {
      const cached = await tryCache(requestedUrl, check.url.href);
      if (cached) {
        await recordAttempt({ kind: "fetch", target: requestedUrl, status: "ok", method: "cache", ms: Date.now() - start });
        return { ok: true, page: cached };
      }
    }

    const remainingForFetch = deadline - Date.now();
    if (remainingForFetch <= 0) {
      await recordAttempt({ kind: "fetch", target: requestedUrl, status: "timeout", ms: Date.now() - start });
      return { ok: false, url: requestedUrl, status: "timeout", reason: "The page took too long to respond." };
    }

    // One AbortController spans the whole network phase — following redirects *and* reading the
    // response body — and is cleared only once we are completely done with the response (defect
    // #1). Previously the timer was cleared as soon as headers arrived, leaving a drip-fed body
    // free to stall forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingForFetch);

    let httpStatus = 0;
    let finalUrl: URL = check.url;
    let bodyHtml = "";
    let extracted: { title: string; text: string } | null = null;
    let hardBlockedReason: string | null = null; // final; never retried in the browser
    let attemptBrowser = false;
    let browserFallbackReason: string | null = null; // shown if the browser fallback also fails
    let fallbackToFetchOnBrowserFailure = false; // usable-but-thin/JS-looking fetched text
    let outOfBudget = false; // the shared controller aborted while we were still using the response

    try {
      const redirectResult = await fetchWithRedirects(check.url, controller.signal);

      if (!redirectResult.ok) {
        if (redirectResult.kind === "timeout") {
          outOfBudget = true;
        } else if (redirectResult.kind === "network") {
          // A transport-level failure, not a safety verdict — the browser may still succeed
          // fetching the same (already-validated) URL itself.
          attemptBrowser = true;
          browserFallbackReason = redirectResult.reason;
        } else {
          // "ssrf": redirect-chain validation failed. Retrying via the browser would just repeat
          // the same unvalidated redirect there, so this never falls back (defect #3).
          hardBlockedReason = redirectResult.reason;
        }
      } else {
        const { response, finalUrl: fu } = redirectResult;
        finalUrl = fu;
        httpStatus = response.status;
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        const contentTypeOk = ACCEPTABLE_CONTENT_TYPES.some((t) => contentType.includes(t));

        if (httpStatus >= 400) {
          if (BROWSER_ELIGIBLE_STATUSES.has(httpStatus)) {
            // Bot walls / rate limiting: worth a real render.
            attemptBrowser = true;
            browserFallbackReason = `The site returned HTTP ${httpStatus}.`;
          } else {
            // Any other 4xx/5xx (404, 410, 5xx, ...) is a final answer — rendering it in a
            // browser would only risk masking a real "not found"/"gone" behind a "successful"
            // render of the same error page (defect #8).
            hardBlockedReason = `The page returned HTTP ${httpStatus}.`;
          }
        } else if (!contentTypeOk) {
          hardBlockedReason = `Unexpected content type "${contentType || "unknown"}".`;
        }

        if (hardBlockedReason || attemptBrowser) {
          // Not reading this body — cancel it immediately so the connection is freed right away
          // (Workers allows only a handful of concurrent connections) (defect #1).
          try {
            await response.body?.cancel();
          } catch {
            // best-effort only
          }
        } else {
          try {
            bodyHtml = await readCappedText(response, MAX_BODY_BYTES);
          } catch {
            if (controller.signal.aborted) {
              outOfBudget = true;
            } else {
              hardBlockedReason = "Failed to read the page body.";
            }
          }

          if (!hardBlockedReason && !outOfBudget) {
            extracted = htmlToText(bodyHtml);
            if (looksLikeChallenge(extracted.text)) {
              attemptBrowser = true;
              browserFallbackReason = "The site presented a bot-challenge or access-denied page.";
            } else if (extracted.text.length < 400 || looksJsRendered(bodyHtml, extracted.text)) {
              // Thin or JS-shell content: worth a real render, but a non-empty fetched result is
              // still usable if the browser fallback fails too (defect #7).
              attemptBrowser = true;
              fallbackToFetchOnBrowserFailure = true;
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }

    if (outOfBudget) {
      await recordAttempt({ kind: "fetch", target: requestedUrl, status: "timeout", ms: Date.now() - start });
      return { ok: false, url: requestedUrl, status: "timeout", reason: "The page took too long to respond." };
    }

    if (hardBlockedReason) {
      await recordAttempt({ kind: "fetch", target: requestedUrl, status: "blocked", reason: hardBlockedReason, ms: Date.now() - start });
      return { ok: false, url: requestedUrl, status: "blocked", reason: hardBlockedReason };
    }

    const buildFetchPage = async (): Promise<FetchedPage> => {
      const text = extracted!.text.slice(0, MAX_PAGE_CHARS);
      return {
        requestedUrl,
        finalUrl: finalUrl.href,
        httpStatus,
        method: "fetch",
        title: extracted!.title,
        text,
        links: extractLinks(bodyHtml, finalUrl.href),
        fetchedAt: new Date().toISOString(),
        cached: false,
        contentHash: await sha256Hex(text),
        issuer: issuerOf(finalUrl.href),
      };
    };

    if (!attemptBrowser) {
      // Clean 2xx page, acceptable content-type, substantial non-challenge text.
      const page = await buildFetchPage();
      await recordAttempt({ kind: "fetch", target: requestedUrl, status: "ok", method: "fetch", ms: Date.now() - start });
      await savePage(page, httpStatus, "fetch");
      return { ok: true, page };
    }

    const canFallBackToFetchedPage = fallbackToFetchOnBrowserFailure && extracted !== null && extracted.text.length > 0;
    const remainingForBrowser = deadline - Date.now();

    if (remainingForBrowser > 0) {
      const browserOutcome = await fetchViaBrowser(requestedUrl, finalUrl.href, remainingForBrowser);
      if (browserOutcome.ok) {
        await recordAttempt({ kind: "fetch", target: requestedUrl, status: "ok", method: "browser", ms: Date.now() - start });
        await savePage(browserOutcome.page, browserOutcome.page.httpStatus, "browser");
        return { ok: true, page: browserOutcome.page };
      }
      if (canFallBackToFetchedPage) {
        const page = await buildFetchPage();
        await recordAttempt({ kind: "fetch", target: requestedUrl, status: "ok", method: "fetch", ms: Date.now() - start });
        await savePage(page, httpStatus, "fetch");
        return { ok: true, page };
      }
      const reason = browserFallbackReason ?? browserOutcome.reason;
      await recordAttempt({ kind: "fetch", target: requestedUrl, status: "blocked", reason, ms: Date.now() - start });
      return { ok: false, url: requestedUrl, status: "blocked", reason };
    }

    // Out of overall budget before the browser fallback could even start (defect #9): still
    // return a usable fetched page rather than declaring failure over an imperfect heuristic.
    if (canFallBackToFetchedPage) {
      const page = await buildFetchPage();
      await recordAttempt({ kind: "fetch", target: requestedUrl, status: "ok", method: "fetch", ms: Date.now() - start });
      await savePage(page, httpStatus, "fetch");
      return { ok: true, page };
    }
    await recordAttempt({ kind: "fetch", target: requestedUrl, status: "timeout", ms: Date.now() - start });
    return { ok: false, url: requestedUrl, status: "timeout", reason: "The page took too long to respond." };
  }

  async function loadOfficialSources(): Promise<OfficialSourceRow[]> {
    if (officialRows) return officialRows;
    try {
      const result = await env.DB.prepare(`SELECT * FROM official_sources`).all<OfficialSourceRow>();
      officialRows = result.results ?? [];
    } catch (err) {
      console.error("evidence-scout: failed to load official sources", err);
      officialRows = [];
    }
    return officialRows;
  }

  function buildOfficialUrl(row: OfficialSourceRow, brand: string | undefined): string | null {
    const pattern = row.lookup_url_pattern;
    if (!pattern) return `https://${row.domain}/`;

    const needsSlug = pattern.includes("{slug}");
    const needsBrand = pattern.includes("{brand}");
    if ((needsSlug || needsBrand) && !brand) {
      return `https://${row.domain}/`;
    }

    let url = pattern;
    if (needsSlug) url = url.replace(/\{slug\}/g, slugify(brand!));
    if (needsBrand) url = url.replace(/\{brand\}/g, encodeURIComponent(brand!));
    return url;
  }

  return {
    async fetchPage(url, fetchOpts) {
      try {
        return await fetchPageInner(url, fetchOpts ?? {});
      } catch (err) {
        console.error("evidence-scout: unexpected fetchPage error", err);
        await recordAttempt({
          kind: "fetch",
          target: url,
          status: "error",
          reason: "Unexpected error while fetching the page.",
          ms: 0,
        });
        return { ok: false, url, status: "blocked", reason: "Unexpected error while fetching the page." };
      }
    },

    async searchWeb(query) {
      const start = Date.now();
      const tavilyKey = (env as Cloudflare.Env).TAVILY_API_KEY;
      const braveKey = (env as Cloudflare.Env).BRAVE_SEARCH_API_KEY;
      if (!tavilyKey && !braveKey) {
        await recordAttempt({ kind: "search", target: query, status: "unavailable", ms: Date.now() - start });
        return { available: false, hits: [] };
      }

      let failure = "Search request failed.";
      let timedOut = false;
      for (const provider of ["tavily", "brave"] as const) {
        const key = provider === "tavily" ? tavilyKey : braveKey;
        if (!key) continue;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const response = provider === "tavily"
            ? await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${key}` },
              body: JSON.stringify({ query, search_depth: "basic", topic: "general", max_results: 8, include_answer: false, include_raw_content: false }),
              signal: controller.signal,
            })
            : await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`, {
              headers: { Accept: "application/json", "X-Subscription-Token": key },
              signal: controller.signal,
            });
          if (!response.ok) {
            failure = `${provider === "tavily" ? "Tavily" : "Brave"} search returned HTTP ${response.status}.`;
            continue;
          }

          const data = (await response.json()) as {
            results?: Array<{ url: string; title?: string; content?: string }>;
            web?: { results?: Array<{ url: string; title?: string; description?: string }> };
          };
          const results = provider === "tavily" ? data.results : data.web?.results;
          if (!Array.isArray(results)) {
            failure = `${provider === "tavily" ? "Tavily" : "Brave"} search returned an invalid response.`;
            continue;
          }
          const hits: SearchHit[] = [];
          for (const r of results) {
            if (!r || typeof r.url !== "string") continue;
            const check = validatePublicUrl(r.url);
            if (!check.ok) continue;
            const item = r as { content?: unknown; description?: unknown };
            const snippet = provider === "tavily" ? item.content : item.description;
            hits.push({
              url: check.url.href,
              title: typeof r.title === "string" ? r.title : "",
              snippet: typeof snippet === "string" ? snippet : "",
              source: "search",
            });
          }
          await recordAttempt({ kind: "search", target: query, status: "ok", resultCount: hits.length, ms: Date.now() - start });
          return { available: true, hits };
        } catch {
          timedOut = controller.signal.aborted;
          failure = timedOut ? "Search timed out." : "Search request failed.";
        } finally {
          clearTimeout(timer);
        }
      }
      await recordAttempt({ kind: "search", target: query, status: timedOut ? "timeout" : "error", reason: failure, ms: Date.now() - start });
      return { available: false, hits: [] };
    },

    async officialCandidates(claim, brand) {
      const rows = await loadOfficialSources();
      const claimTextNorm = stripDiacritics(claim.text.toLowerCase());

      const matches = rows.filter((row) => {
        const types = row.claim_types.split(",").map((t) => t.trim()) as ClaimType[];
        if (!types.includes(claim.type)) return false;
        const keywords = row.keywords
          .split(",")
          .map((k) => stripDiacritics(k.trim().toLowerCase()))
          .filter(Boolean);
        return keywords.some((kw) => claimTextNorm.includes(kw));
      });

      const hits: SearchHit[] = [];
      for (const row of matches) {
        if (hits.length >= 3) break;
        const url = buildOfficialUrl(row, brand);
        if (!url) continue;
        const check = validatePublicUrl(url);
        if (!check.ok) continue;
        hits.push({ url: check.url.href, title: row.name, snippet: row.notes ?? "", source: "official" });
      }
      return hits;
    },

    rankLinks(page, keywords, limit) {
      const baseIssuer = page.issuer.toLowerCase();
      const normKeywords = keywords.map((k) => stripDiacritics(k.toLowerCase())).filter(Boolean);

      const scored: { link: PageLink; score: number; pathLen: number }[] = [];

      for (const link of page.links) {
        let url: URL;
        try {
          url = new URL(link.url);
        } catch {
          continue;
        }
        const host = url.hostname.toLowerCase().replace(/^www\./, "");
        const sameSite = host === baseIssuer || host.endsWith(`.${baseIssuer}`);
        if (!sameSite) continue;

        if (ASSET_EXT_RE.test(url.pathname)) continue;
        if (NAV_NOISE_RE.test(url.pathname) || NAV_NOISE_RE.test(link.text || "")) continue;

        const haystack = stripDiacritics(`${url.pathname} ${link.text}`.toLowerCase());
        let score = 0;
        for (const kw of normKeywords) {
          score += countOccurrences(haystack, kw);
        }
        if (score <= 0) continue;

        scored.push({ link, score, pathLen: url.pathname.length });
      }

      scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.pathLen - b.pathLen));
      return scored.slice(0, limit).map((s) => s.link);
    },
  };
}
