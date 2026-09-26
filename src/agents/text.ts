// HTML-to-text extraction, link discovery and hashing helpers for the Evidence Scout.
// No DOM APIs are available in the Workers runtime, so parsing is done with targeted
// regular expressions rather than a full HTML parser — sufficient for readable-text
// extraction and link discovery on real-world marketing/certifier pages.

export const MAX_PAGE_CHARS = 60000;

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const REMOVE_BLOCKS_RE = /<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const BLOCK_TAG_RE =
  /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|table|thead|tbody|tfoot|header|footer|section|article|nav|main|blockquote|pre|hr|dd|dt|dl|figcaption|figure|address|form|fieldset|aside)\b[^>]*>/gi;
const STRIP_TAG_RE = /<[^>]+>/g;
const LINE_WHITESPACE_RE = /[ \t\f\v ]+/g;
const ANCHOR_RE = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi;

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
  const withoutComments = html.replace(COMMENT_RE, "");

  const titleMatch = TITLE_RE.exec(withoutComments);
  const title = titleMatch ? normalizeWhitespace(stripTagsToText(titleMatch[1])) : "";

  const withoutNoise = withoutComments.replace(REMOVE_BLOCKS_RE, " ");
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
  const withoutNoise = html.replace(COMMENT_RE, "").replace(REMOVE_BLOCKS_RE, " ");
  const seen = new Set<string>();
  const out: { url: string; text: string }[] = [];

  ANCHOR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANCHOR_RE.exec(withoutNoise))) {
    const hrefRaw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const innerHtml = match[4] ?? "";
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
