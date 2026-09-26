import { describe, expect, it } from "vitest";
import { extractLinks, htmlToText, issuerOf, MAX_PAGE_CHARS, normalizeWhitespace, sha256Hex } from "../text";

describe("htmlToText", () => {
  it("extracts the title and drops script/style/noscript content", () => {
    const html = `
      <html>
        <head>
          <title>  Garnier &amp; Nature  </title>
          <style>body { color: red; }</style>
          <script>console.log("should not appear");</script>
        </head>
        <body>
          <noscript>Enable JavaScript to continue</noscript>
          <h1>Our sustainability commitment</h1>
          <p>We reduce plastic packaging across our brands.</p>
        </body>
      </html>`;
    const { title, text } = htmlToText(html);
    expect(title).toBe("Garnier & Nature");
    expect(text).not.toContain("console.log");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("Enable JavaScript");
    expect(text).toContain("Our sustainability commitment");
    expect(text).toContain("We reduce plastic packaging across our brands.");
  });

  it("decodes named and numeric entities", () => {
    const html = "<p>Caf&eacute; &amp; cr&#233;me &mdash; 100&#37; natural &#x2013; today&#39;s offer</p>";
    const { text } = htmlToText(html);
    expect(text).toBe("Café & créme — 100% natural – today's offer");
  });

  it("preserves Portuguese accented characters embedded directly as UTF-8", () => {
    const html = "<p>Compromisso com a sustentabilidade: reciclável, não testado em animais.</p>";
    const { text } = htmlToText(html);
    expect(text).toBe("Compromisso com a sustentabilidade: reciclável, não testado em animais.");
  });

  it("keeps block-level breaks as newlines and collapses whitespace within a line", () => {
    const html = "<div>First   block</div><div>Second\n   block</div><p>Third block</p>";
    const { text } = htmlToText(html);
    expect(text.split("\n")).toEqual(["First block", "Second block", "Third block"]);
  });

  it("converts <br> into a line break", () => {
    const html = "<p>Line one<br>Line two</p>";
    const { text } = htmlToText(html);
    expect(text.split("\n")).toEqual(["Line one", "Line two"]);
  });

  it("removes svg and template content", () => {
    const html = '<svg><path d="M0 0"/></svg><template><p>hidden</p></template><p>visible</p>';
    const { text } = htmlToText(html);
    expect(text).toBe("visible");
  });

  it("returns an empty title when none is present", () => {
    const { title } = htmlToText("<p>No title here</p>");
    expect(title).toBe("");
  });
});

describe("normalizeWhitespace", () => {
  it("collapses all whitespace runs including newlines and trims", () => {
    expect(normalizeWhitespace("  a  \n\n  b\tc  ")).toBe("a b c");
  });
});

describe("extractLinks", () => {
  const base = "https://www.loreal.com/en/commitments/";

  it("resolves relative links against the base URL", () => {
    const html = '<a href="/en/brands/garnier">Garnier</a>';
    const links = extractLinks(html, base);
    expect(links).toEqual([{ url: "https://www.loreal.com/en/brands/garnier", text: "Garnier" }]);
  });

  it("encodes spaces in relative paths", () => {
    const html = '<a href="/Loreal/Brand Sites/Garnier/x">Garnier site</a>';
    const links = extractLinks(html, base);
    expect(links).toEqual([
      { url: "https://www.loreal.com/Loreal/Brand%20Sites/Garnier/x", text: "Garnier site" },
    ]);
  });

  it("dedupes identical resolved URLs and drops the fragment", () => {
    const html = `
      <a href="/en/brands/garnier#top">Garnier</a>
      <a href="https://www.loreal.com/en/brands/garnier">Garnier again</a>
    `;
    const links = extractLinks(html, base);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://www.loreal.com/en/brands/garnier");
  });

  it("drops fragment-only, mailto, tel and javascript links", () => {
    const html = `
      <a href="#section">Jump</a>
      <a href="mailto:hello@example.com">Email us</a>
      <a href="tel:+123456789">Call us</a>
      <a href="javascript:void(0)">Nothing</a>
      <a href="https://example.com/real">Real link</a>
    `;
    const links = extractLinks(html, base);
    expect(links).toEqual([{ url: "https://example.com/real", text: "Real link" }]);
  });

  it("keeps only absolute http(s) links, resolving protocol-relative URLs against the base scheme", () => {
    const html = '<a href="//cdn.loreal.com/asset">CDN asset</a>';
    const links = extractLinks(html, base);
    expect(links).toEqual([{ url: "https://cdn.loreal.com/asset", text: "CDN asset" }]);
  });

  it("strips inner tags and decodes entities from anchor text", () => {
    const html = '<a href="https://example.com/a"><strong>Cruelty</strong> &amp; Free</a>';
    const links = extractLinks(html, base);
    expect(links).toEqual([{ url: "https://example.com/a", text: "Cruelty & Free" }]);
  });

  it("ignores links inside removed script/style blocks", () => {
    const html = '<script>document.write(\'<a href="https://evil.example.com/">x</a>\');</script><a href="https://good.example.com/">Good</a>';
    const links = extractLinks(html, base);
    expect(links).toEqual([{ url: "https://good.example.com/", text: "Good" }]);
  });
});

describe("issuerOf", () => {
  it("returns the hostname without a leading www.", () => {
    expect(issuerOf("https://www.garnier.pt/path")).toBe("garnier.pt");
  });

  it("leaves hostnames without www. unchanged", () => {
    expect(issuerOf("https://crueltyfreeinternational.org/listing")).toBe("crueltyfreeinternational.org");
  });

  it("lowercases the hostname", () => {
    expect(issuerOf("https://WWW.Example.COM/")).toBe("example.com");
  });

  it("returns an empty string for an unparseable URL", () => {
    expect(issuerOf("not a url")).toBe("");
  });
});

describe("sha256Hex", () => {
  it("produces the known SHA-256 hex digest for an empty string", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("produces a stable, deterministic 64-char hex digest", async () => {
    const a = await sha256Hex("hello world");
    const b = await sha256Hex("hello world");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different digests for different input", async () => {
    const a = await sha256Hex("hello world");
    const b = await sha256Hex("hello world!");
    expect(a).not.toBe(b);
  });
});

describe("MAX_PAGE_CHARS", () => {
  it("is exported as a positive constant", () => {
    expect(MAX_PAGE_CHARS).toBe(60000);
  });
});

describe("CPU-safety on hostile unclosed-tag input (defect #5)", () => {
  // A lazy `[\s\S]*?</a>` / script / comment span is O(n·k) once many such tags are opened but
  // never closed: each failed match retries at the next character, re-scanning to the end every
  // time. This must complete in well under a CPU-limit kill, not just "eventually".
  it("handles 20k unclosed <a href=x> tags plus an unclosed <script> in well under 200ms", () => {
    const anchors = "<a href=x>link text ".repeat(20000);
    const html = `<html><body>${anchors}<script>var neverCloses = "${"x".repeat(5000)}";</body></html>`;

    const start = performance.now();
    const { text } = htmlToText(html);
    const links = extractLinks(html, "https://example.com/");
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(200);
    // The unclosed <script> has no matching </script> anywhere, so stripRemovableBlocks bails out
    // and drops everything from that point on — the preceding anchor text should still survive.
    expect(text).toContain("link text");
    // None of the 20k <a> tags ever close, so no link is ever extracted from them.
    expect(links).toEqual([]);
  });

  it("still extracts links normally around a single unclosed <script> deep in the page", () => {
    const html = `<a href="https://example.com/good">Good</a><script>var x = 1;`;
    const links = extractLinks(html, "https://example.com/");
    expect(links).toEqual([{ url: "https://example.com/good", text: "Good" }]);
  });

  it("caps HTML at 600KB before parsing", () => {
    const huge = "<p>" + "a".repeat(700_000) + "</p>";
    const start = performance.now();
    const { text } = htmlToText(huge);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
    expect(text.length).toBeLessThanOrEqual(600_000);
  });
});
