// HTML-to-text extraction, link discovery and hashing helpers for the Evidence Scout.
// No DOM APIs are available in the Workers runtime, so parsing is done with targeted
// regular expressions rather than a full HTML parser — sufficient for readable-text
// extraction and link discovery on real-world marketing/certifier pages.

export const MAX_PAGE_CHARS = 60000;

// Defect #5: a page over this size is capped *before* any regex/scanning below ever touches it,
// independent of whatever byte cap the caller (evidence-scout.ts) applied upstream on the raw
// network body. This bounds worst-case CPU even if this module is ever called with a larger input.
const MAX_HTML_CHARS = 600_000;

const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const BLOCK_TAG_RE =
  /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|table|thead|tbody|tfoot|header|footer|section|article|nav|main|blockquote|pre|hr|dd|dt|dl|figcaption|figure|address|form|fieldset|aside)\b[^>]*>/gi;
const STRIP_TAG_RE = /<[^>]+>/g;
const LINE_WHITESPACE_RE = /[ \t\f\v\u00a0]+/g;
const HREF_ATTR_RE = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const REMOVABLE_BLOCK_TAGS = new Set(["script", "style", "noscript", "svg", "template"]);
const OPEN_TAG_NAME_RE = /^<([a-zA-Z][a-zA-Z0-9]*)/;

function capHtml(html: string): string {
  return html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
}

/**
 * Removes `<!-- ... -->` comments with a single linear indexOf-based scan, instead of the lazy
 * `[\s\S]*?-->` regex span that is O(n\u00b7k) on hostile input with many unclosed comment starts: a
 * failed regex match at one "<!--" retries at every following character, each re-scanning to the
 * end of the string. An unclosed comment here instead drops everything from its "<!--" to the end
 * of the document, in a single pass that is never rescanned (defect #5).
 */
function stripComments(html: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const start = html.indexOf("<!--", i);
    if (start === -1) {
      out += html.slice(i);
      return out;
    }
    out += html.slice(i, start);
    const end = html.indexOf("-->", start + 4);
    if (end === -1) return out; // unclosed: drop the remainder, never rescan
    i = end + 3;
  }
}

/**
 * Removes script/style/noscript/svg/template elements, tag and content, with a single linear
 * indexOf-based scan per element, instead of the lazy `[\s\S]*?<\/\1>` regex span (same O(n\u00b7k)
 * hazard as stripComments above, for e.g. many unclosed `<script>` tags). When a removable tag's
 * matching close is missing, there is provably no such close anywhere later in the document
 * either, so the rest is dropped once and the scan stops rather than rescanning (defect #5).
 */
function stripRemovableBlocks(html: string): string {
  const lower = html.toLowerCase(); // computed once; never re-derived inside the loop
  let out = "";
  let i = 0;
  const n = html.length;

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }

    const nameMatch = OPEN_TAG_NAME_RE.exec(html.slice(lt, lt + 16));
    const tagName = nameMatch?.[1].toLowerCase();
    if (!tagName || !REMOVABLE_BLOCK_TAGS.has(tagName)) {
      out += html.slice(i, lt + 1);
      i = lt + 1;
      continue;
    }

    out += html.slice(i, lt);
    const openTagEnd = html.indexOf(">", lt);
    if (openTagEnd === -1) return out; // unterminated opening tag: drop the remainder, never rescan

    const closeIdx = lower.indexOf(`</${tagName}`, openTagEnd + 1);
    if (closeIdx === -1) return out; // never closed anywhere later either: drop the remainder, never rescan

    out += " "; // preserve word separation where the removed block sat, same as the old regex's " " replacement
    const closeEnd = html.indexOf(">", closeIdx);
    i = closeEnd === -1 ? n : closeEnd + 1;
  }

  return out;
}

/**
 * Extracts `<a ...>...</a>` elements with a single linear indexOf-based scan, instead of a global
 * lazy-span regex: with a global regex, a `<a>` that never closes causes `exec` to reattempt the
 * failed lazy match at every following character position, each re-scanning to the end of the
 * string \u2014 the O(n\u00b2) hazard behind the "20k unclosed `<a href=x>`" case in defect #5. Once one
 * anchor is found to never close, there is provably no `</a>` anywhere later in the document
 * either, so scanning stops there rather than rescanning.
 */
function scanAnchors(html: string): { hrefRaw: string; innerHtml: string }[] {
  const lower = html.toLowerCase();
  const out: { hrefRaw: string; innerHtml: string }[] = [];
  let i = 0;
  const n = html.length;

  while (i < n) {
    const openStart = lower.indexOf("<a", i);
    if (openStart === -1) break;

    // Reject "<article", "<abbr", etc: a real "<a" tag is followed by whitespace, "/" or ">".
    const after = lower[openStart + 2];
    if (after !== undefined && !/[\s/>]/.test(after)) {
      i = openStart + 2;
      continue;
    }

    const openEnd = html.indexOf(">", openStart);
    if (openEnd === -1) break; // unterminated opening tag: nothing sane follows, stop

    const openTag = html.slice(openStart, openEnd + 1);
    const hrefMatch = HREF_ATTR_RE.exec(openTag);
    const hrefRaw = (hrefMatch ? hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] : "") ?? "";

    const closeIdx = lower.indexOf("</a", openEnd + 1);
    if (closeIdx === -1) break; // never closes anywhere later either: stop entirely, never rescan

    out.push({ hrefRaw, innerHtml: html.slice(openEnd + 1, closeIdx) });
    const closeEnd = html.indexOf(">", closeIdx);
    i = closeEnd === -1 ? n : closeEnd + 1;
  }

  return out;
}

/** Named HTML entities beyond the XML-predefined set: Latin-1 letters plus common punctuation. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  euro: "€",
  pound: "£",
  cent: "¢",
  yen: "¥",
  sect: "§",
  para: "¶",
  laquo: "«",
  raquo: "»",
  iexcl: "¡",
  iquest: "¿",
  shy: "­",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  micro: "µ",
  ordm: "º",
  ordf: "ª",
  curren: "¤",
  brvbar: "¦",
  uml: "¨",
  macr: "¯",
  acute: "´",
  cedil: "¸",
  not: "¬",
  szlig: "ß",
  Agrave: "À",
  Aacute: "Á",
  Acirc: "Â",
  Atilde: "Ã",
  Auml: "Ä",
  Aring: "Å",
  AElig: "Æ",
  Ccedil: "Ç",
  Egrave: "È",
  Eacute: "É",
  Ecirc: "Ê",
  Euml: "Ë",
  Igrave: "Ì",
  Iacute: "Í",
  Icirc: "Î",
  Iuml: "Ï",
  ETH: "Ð",
  Ntilde: "Ñ",
  Ograve: "Ò",
  Oacute: "Ó",
  Ocirc: "Ô",
  Otilde: "Õ",
  Ouml: "Ö",
  Oslash: "Ø",
  Ugrave: "Ù",
  Uacute: "Ú",
  Ucirc: "Û",
  Uuml: "Ü",
  Yacute: "Ý",
  THORN: "Þ",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  eth: "ð",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  thorn: "þ",
  yuml: "ÿ",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, ent: string) => {
    if (ent[0] === "#") {
      const isHex = ent[1] === "x" || ent[1] === "X";
      const codePoint = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const replacement = NAMED_ENTITIES[ent];
    return replacement !== undefined ? replacement : match;
  });
}

function stripTagsToText(fragment: string): string {
  return decodeEntities(fragment.replace(STRIP_TAG_RE, " "));
}

/** Collapses any run of whitespace (including newlines) to a single space and trims. */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Extracts a page title and readable text from raw HTML. Never throws. */
export function htmlToText(html: string): { title: string; text: string } {
  const capped = capHtml(html);
  const withoutComments = stripComments(capped);

  const titleMatch = TITLE_RE.exec(withoutComments);
  const title = titleMatch ? normalizeWhitespace(stripTagsToText(titleMatch[1])) : "";

  const withoutNoise = stripRemovableBlocks(withoutComments);
  // Collapse any incidental whitespace (including literal newlines in the markup source)
  // to single spaces *before* inserting block breaks, so only real block boundaries become
  // line breaks in the output — a stray "\n" inside a <div> must not split running text.
  const collapsedSource = withoutNoise.replace(/\s+/g, " ");
  const withBreaks = collapsedSource.replace(BLOCK_TAG_RE, "\n");
  const bareText = decodeEntities(withBreaks.replace(STRIP_TAG_RE, " "));

  const lines = bareText
    .split("\n")
    .map((line) => line.replace(LINE_WHITESPACE_RE, " ").trim())
    .filter((line) => line.length > 0);

  return { title, text: lines.join("\n") };
}

/** Extracts absolute http(s) links (deduped, fragment-free) from HTML, resolved against `baseUrl`. */
export function extractLinks(html: string, baseUrl: string): { url: string; text: string }[] {
  const capped = capHtml(html);
  const withoutNoise = stripRemovableBlocks(stripComments(capped));
  const seen = new Set<string>();
  const out: { url: string; text: string }[] = [];

  for (const { hrefRaw: rawHref, innerHtml } of scanAnchors(withoutNoise)) {
    const hrefRaw = rawHref.trim();
    if (!hrefRaw || hrefRaw.startsWith("#")) continue;

    let resolved: URL;
    try {
      resolved = new URL(hrefRaw, baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;

    resolved.hash = "";
    const url = resolved.href;
    if (seen.has(url)) continue;
    seen.add(url);

    out.push({ url, text: normalizeWhitespace(stripTagsToText(innerHtml)) });
  }

  return out;
}

/** SHA-256 hex digest of a string, using WebCrypto (available in both Workers and Node). */
export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Registrable-ish hostname of a URL, with a leading "www." stripped. */
export function issuerOf(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  } catch {
    return "";
  }
}
