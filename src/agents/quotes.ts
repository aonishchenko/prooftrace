// Exact-quote matching and passage selection shared by the extractor and every specialist.
// Both functions only ever return substrings that literally occur in the given text: ProofTrace
// never presents a paraphrase or a model's guess as a "verified" quote.

const SINGLE_QUOTE_CHARS = ["'", "‘", "’", "‚", "‛", "′"];
const DOUBLE_QUOTE_CHARS = ['"', "“", "”", "„", "‟", "″"];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSingleQuoteChar(ch: string): boolean {
  return SINGLE_QUOTE_CHARS.includes(ch);
}

function isDoubleQuoteChar(ch: string): boolean {
  return DOUBLE_QUOTE_CHARS.includes(ch);
}

/** Build a regex source that matches `quote` while treating whitespace runs and quote-mark
 * variants as interchangeable. Every other character is matched literally (case handled by the
 * caller's regex flags). */
function buildFlexiblePattern(quote: string): string {
  let pattern = "";
  let i = 0;
  while (i < quote.length) {
    const ch = quote[i];
    if (/\s/.test(ch)) {
      let j = i;
      while (j < quote.length && /\s/.test(quote[j])) j++;
      pattern += "\\s+";
      i = j;
      continue;
    }
    if (isSingleQuoteChar(ch)) {
      pattern += `[${SINGLE_QUOTE_CHARS.map(escapeRegExp).join("")}]`;
      i++;
      continue;
    }
    if (isDoubleQuoteChar(ch)) {
      pattern += `[${DOUBLE_QUOTE_CHARS.map(escapeRegExp).join("")}]`;
      i++;
      continue;
    }
    pattern += escapeRegExp(ch);
    i++;
  }
  return pattern;
}

/**
 * Whitespace-, case- and quote-mark-insensitive search for `quote` inside `haystack`.
 * Returns the ACTUAL substring of `haystack` that matched (preserving its real casing,
 * whitespace and quote characters), or null when no match exists.
 */
export function findExact(haystack: string, quote: string): string | null {
  const trimmed = quote.trim();
  if (!trimmed || !haystack) return null;

  const pattern = buildFlexiblePattern(trimmed);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "iu");
  } catch {
    // `u` mode can reject some patterns with lone surrogates; retry without it.
    try {
      regex = new RegExp(pattern, "i");
    } catch {
      return null;
    }
  }

  const match = regex.exec(haystack);
  return match ? match[0] : null;
}

/** Strip diacritics from a single UTF-16 code unit while preserving string length (1:1 index map). */
function foldChar(ch: string): string {
  const decomposed = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return decomposed.length === 1 ? decomposed : ch;
}

/** Accent-insensitive, lower-cased fold of `s` that keeps the exact same length and index
 * alignment as `s`, so positions found in the folded string are valid positions in `s`. */
function foldForSearch(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += foldChar(s[i]);
  return out.toLowerCase();
}

interface Range {
  start: number;
  end: number;
}

/**
 * Return exact substrings of `text` around hits of any `keywords` entry (accent-insensitive,
 * case-insensitive), merging overlapping/adjacent windows. When nothing matches, returns the
 * first `window` characters of `text` as a single passage. Every returned string is a verbatim
 * substring of `text`.
 */
export function selectPassages(text: string, keywords: string[], opts?: { max?: number; window?: number }): string[] {
  const max = opts?.max ?? 8;
  const window = opts?.window ?? 600;
  if (!text) return [];

  const folded = foldForSearch(text);
  const foldedKeywords = keywords.map((k) => foldForSearch(k)).filter((k) => k.length > 0);

  const hits: Range[] = [];
  for (const kw of foldedKeywords) {
    if (kw.length === 0 || kw.length > folded.length) continue;
    let from = 0;
    while (from <= folded.length - kw.length) {
      const idx = folded.indexOf(kw, from);
      if (idx === -1) break;
      hits.push({ start: idx, end: idx + kw.length });
      from = idx + kw.length;
    }
  }

  if (hits.length === 0) {
    return [text.slice(0, window)];
  }

  const half = Math.floor(window / 2);
  const ranges = hits
    .map((h) => ({ start: Math.max(0, h.start - half), end: Math.min(text.length, h.end + half) }))
    .sort((a, b) => a.start - b.start);

  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  return merged.slice(0, max).map((r) => text.slice(r.start, r.end));
}
