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

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED_LINKS = 300;
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
  | { ok: false; kind: "blocked"; reason: string };

type BrowserOutcome = { ok: true; page: FetchedPage } | { ok: false; reason: string };

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

  async function fetchWithRedirects(startUrl: URL, timeoutMs: number): Promise<RedirectOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let current = startUrl;
      let redirects = 0;
      for (;;) {
        let response: Response;
        try {
          response = await fetch(current.href, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              "User-Agent": USER_AGENT,
              Accept: ACCEPT_HEADER,
              "Accept-Language": ACCEPT_LANGUAGE,
            },
          });
        } catch (err) {
          if (controller.signal.aborted) return { ok: false, kind: "timeout" };
          return { ok: false, kind: "blocked", reason: "A network error occurred while fetching the page." };
        }

        if (response.status >= 300 && response.status < 400) {
          if (redirects >= MAX_REDIRECTS) {
            return { ok: false, kind: "blocked", reason: "Too many redirects." };
          }
          const location = response.headers.get("location");
          if (!location) {
            return { ok: false, kind: "blocked", reason: `Redirect (${response.status}) had no Location header.` };
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, current);
          } catch {
            return { ok: false, kind: "blocked", reason: "Redirected to an invalid URL." };
          }
          const nextCheck = validatePublicUrl(nextUrl.href);
          if (!nextCheck.ok) {
            return { ok: false, kind: "blocked", reason: `Redirect target rejected: ${nextCheck.reason}` };
          }
          current = nextCheck.url;
          redirects += 1;
          continue;
        }

        return { ok: true, response, finalUrl: current };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchViaBrowser(requestedUrl: string, targetUrl: string, timeoutMs: number): Promise<BrowserOutcome> {
    try {
      const gotoTimeout = Math.min(20000, Math.max(5000, timeoutMs));
      const [markdownRes, linksRes] = await Promise.all([
        env.BROWSER.quickAction("markdown", {
          url: targetUrl,
          gotoOptions: { waitUntil: "networkidle2", timeout: gotoTimeout },
        })
          .then((r) => r.json() as Promise<BrowserRunMarkdownSuccessResponse | BrowserRunErrorResponse>)
          .catch((err) => ({ success: false, errors: [{ message: String(err) }] }) as BrowserRunErrorResponse),
        env.BROWSER.quickAction("links", { url: targetUrl, visibleLinksOnly: false })
          .then((r) => r.json() as Promise<BrowserRunLinksSuccessResponse | BrowserRunErrorResponse>)
          .catch((err) => ({ success: false, errors: [{ message: String(err) }] }) as BrowserRunErrorResponse),
      ]);

      if (!markdownRes.success) {
        const reason = markdownRes.errors?.[0]?.message || "Browser rendering failed.";
        return { ok: false, reason: `Browser fallback failed: ${reason}` };
      }

      const text = normalizeMarkdownWhitespace(markdownRes.result).slice(0, MAX_PAGE_CHARS);
      if (text.length === 0) {
        return { ok: false, reason: "Browser rendering returned no readable text." };
      }
      if (looksLikeChallenge(text)) {
        return { ok: false, reason: "The site presented a bot-challenge or access-denied page even in the browser." };
      }

      let finalUrl = targetUrl;
      const metaFinalUrl = markdownRes.meta?.finalUrl;
      if (metaFinalUrl) {
        const check = validatePublicUrl(metaFinalUrl);
        if (check.ok) finalUrl = check.url.href;
      }

      let links: PageLink[] = [];
      if (linksRes.success) {
        const deduped = new Set<string>();
        for (const href of linksRes.result) {
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

      const page: FetchedPage = {
        requestedUrl,
        finalUrl,
        httpStatus: 200,
        method: "browser",
        title: firstMarkdownHeading(markdownRes.result),
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
      return { ok: false, reason: "Browser rendering failed unexpectedly." };
    }
  }

  async function fetchPageInner(
    requestedUrl: string,
    fetchOpts: { allowCache?: boolean; timeoutMs?: number },
  ): Promise<FetchOutcome> {
    const allowCache = fetchOpts.allowCache ?? true;
    const timeoutMs = fetchOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();

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

    const redirectResult = await fetchWithRedirects(check.url, timeoutMs);

    if (!redirectResult.ok) {
      if (redirectResult.kind === "timeout") {
        await recordAttempt({ kind: "fetch", target: requestedUrl, status: "timeout", ms: Date.now() - start });
        return { ok: false, url: requestedUrl, status: "timeout", reason: "The page took too long to respond." };
      }

      const browserOutcome = await fetchViaBrowser(requestedUrl, check.url.href, timeoutMs);
      if (browserOutcome.ok) {
        await recordAttempt({ kind: "fetch", target: requestedUrl, status: "ok", method: "browser", ms: Date.now() - start });
        await savePage(browserOutcome.page, 200, "browser");
        return { ok: true, page: browserOutcome.page };
      }
      await recordAttempt({
        kind: "fetch",
        target: requestedUrl,
        status: "blocked",
        reason: redirectResult.reason,
        ms: Date.now() - start,
      });
      return { ok: false, url: requestedUrl, status: "blocked", reason: redirectResult.reason };
    }

    const { response, finalUrl } = redirectResult;
    const httpStatus = response.status;
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const contentTypeOk = ACCEPTABLE_CONTENT_TYPES.some((t) => contentType.includes(t));

    let blockedReason: string | null = null;
    if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429 || httpStatus === 503) {
      blockedReason = `The site returned HTTP ${httpStatus}.`;
    } else if (httpStatus >= 400) {
      blockedReason = `The site returned HTTP ${httpStatus}.`;
    } else if (!contentTypeOk) {
      blockedReason = `Unexpected content type "${contentType || "unknown"}".`;
    }

    let bodyHtml = "";
    if (!blockedReason) {
      try {
        bodyHtml = await readCappedText(response, MAX_BODY_BYTES);
      } catch {
        blockedReason = "Failed to read the page body.";
      }
    }

    let extracted: { title: string; text: string } | null = null;
    if (!blockedReason) {
      extracted = htmlToText(bodyHtml);
      if (looksLikeChallenge(extracted.text)) {
        blockedReason = "The site presented a bot-challenge or access-denied page.";
      }
    }

    const needsBrowser =
      blockedReason !== null ||
      (extracted !== null && extracted.text.length < 400) ||
      (extracted !== null && looksJsRendered(bodyHtml, extracted.text));

    if (needsBrowser) {
      const browserOutcome = await fetchViaBrowser(requestedUrl, finalUrl.href, timeoutMs);
      if (browserOutcome.ok) {
        await recordAttempt({ kind: "fetch", target: requestedUrl, status: "ok", method: "browser", ms: Date.now() - start });
        await savePage(browserOutcome.page, httpStatus, "browser");
        return { ok: true, page: browserOutcome.page };
      }
      const reason = blockedReason ?? browserOutcome.reason;
      await recordAttempt({ kind: "fetch", target: requestedUrl, status: "blocked", reason, ms: Date.now() - start });
      return { ok: false, url: requestedUrl, status: "blocked", reason };
    }

    const text = extracted!.text.slice(0, MAX_PAGE_CHARS);
    const page: FetchedPage = {
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

    await recordAttempt({ kind: "fetch", target: requestedUrl, status: "ok", method: "fetch", ms: Date.now() - start });
    await savePage(page, httpStatus, "fetch");
    return { ok: true, page };
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
      const key = (env as Cloudflare.Env).BRAVE_SEARCH_API_KEY;
      if (!key) {
        await recordAttempt({ kind: "search", target: query, status: "unavailable", ms: Date.now() - start });
        return { available: false, hits: [] };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`, {
          headers: { Accept: "application/json", "X-Subscription-Token": key },
          signal: controller.signal,
        });

        if (!response.ok) {
          await recordAttempt({
            kind: "search",
            target: query,
            status: "error",
            reason: `Search API returned HTTP ${response.status}.`,
            ms: Date.now() - start,
          });
          return { available: true, hits: [] };
        }

        const data = (await response.json()) as {
          web?: { results?: Array<{ url: string; title?: string; description?: string }> };
        };
        const results = data.web?.results ?? [];
        const hits: SearchHit[] = [];
        for (const r of results) {
          const check = validatePublicUrl(r.url);
          if (!check.ok) continue;
          hits.push({ url: check.url.href, title: r.title ?? "", snippet: r.description ?? "", source: "search" });
        }

        await recordAttempt({ kind: "search", target: query, status: "ok", resultCount: hits.length, ms: Date.now() - start });
        return { available: true, hits };
      } catch (err) {
        const timedOut = controller.signal.aborted;
        await recordAttempt({
          kind: "search",
          target: query,
          status: timedOut ? "timeout" : "error",
          reason: timedOut ? "Search timed out." : "Search request failed.",
          ms: Date.now() - start,
        });
        return { available: true, hits: [] };
      } finally {
        clearTimeout(timer);
      }
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
