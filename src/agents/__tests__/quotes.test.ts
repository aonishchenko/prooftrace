import { describe, expect, it } from "vitest";
import { findExact, selectPassages } from "../quotes";

describe("findExact", () => {
  it("matches an exact substring and returns it verbatim", () => {
    const haystack = "Garnier is approved by Cruelty Free International.";
    const result = findExact(haystack, "Garnier is approved by Cruelty Free International");
    expect(result).toBe("Garnier is approved by Cruelty Free International");
  });

  it("is whitespace-insensitive (multiple spaces/newlines in the quote collapse)", () => {
    const haystack = "Endless heaps of\nethically-  sourced   ingredients for our bath bombs.";
    const result = findExact(haystack, "ethically-  sourced ingredients");
    expect(result).toBe("ethically-  sourced   ingredients");
  });

  it("is whitespace-insensitive the other way (quote has single spaces, haystack has newlines)", () => {
    const haystack = "Refilling the Eau de Parfum bottle helps\nto   save 58%* glass, 59%* plastics.";
    const result = findExact(haystack, "helps to save 58%* glass");
    expect(result).toBe("helps\nto   save 58%* glass");
  });

  it("is case-insensitive", () => {
    const haystack = "Fórmula VEGAN 97% de Origem Natural.";
    const result = findExact(haystack, "fórmula vegan 97% de origem natural");
    expect(result).toBe("Fórmula VEGAN 97% de Origem Natural");
  });

  it("treats straight and curly single quotes as interchangeable", () => {
    const haystack = "Garnier’s commitment to cruelty-free testing.";
    const result = findExact(haystack, "Garnier's commitment to cruelty-free testing");
    expect(result).toBe("Garnier’s commitment to cruelty-free testing");
  });

  it("treats straight and curly double quotes as interchangeable", () => {
    const haystack = "We call this our “planet-friendly” promise.";
    const result = findExact(haystack, 'our "planet-friendly" promise');
    expect(result).toBe("our “planet-friendly” promise");
  });

  it("returns null when the quote does not occur in the haystack", () => {
    const haystack = "Garnier is approved by Cruelty Free International.";
    expect(findExact(haystack, "Garnier is certified organic")).toBeNull();
  });

  it("returns null for an empty or whitespace-only quote", () => {
    expect(findExact("some text", "")).toBeNull();
    expect(findExact("some text", "   ")).toBeNull();
  });

  it("escapes regex-special characters in the quote (percent, asterisk, parentheses)", () => {
    const haystack = "Save 58%* glass (versus a classic bottle).";
    expect(findExact(haystack, "58%* glass (versus a classic bottle)")).toBe(
      "58%* glass (versus a classic bottle)",
    );
  });
});

describe("selectPassages", () => {
  it("returns the actual substring around a keyword hit", () => {
    const text = "A".repeat(200) + " ethically sourced ingredients " + "B".repeat(200);
    const [passage] = selectPassages(text, ["ethically"], { window: 60 });
    expect(text.includes(passage)).toBe(true);
    expect(passage).toContain("ethically sourced ingredients");
  });

  it("is accent-insensitive: an unaccented keyword finds an accented occurrence", () => {
    const text = "Uma alternativa sustentável para o seu dia a dia.";
    const passages = selectPassages(text, ["sustentavel"], { window: 40 });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages[0]).toContain("sustentável");
  });

  it("is accent-insensitive the other way: an accented keyword finds an unaccented occurrence", () => {
    const text = "Nossa politica de sourcing etico e responsavel.";
    const passages = selectPassages(text, ["ético"], { window: 40 });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages[0]).toContain("etico");
  });

  it("returns the first `window` characters when there are no keyword hits", () => {
    const text = "x".repeat(1000);
    const passages = selectPassages(text, ["nomatch"], { window: 100 });
    expect(passages).toEqual([text.slice(0, 100)]);
  });

  it("merges overlapping windows from nearby hits into one passage", () => {
    const text = "0123456789 sustainable eco-friendly 9876543210";
    const passages = selectPassages(text, ["sustainable", "eco-friendly"], { window: 20 });
    // Both keywords are close together, so their windows should merge into a single passage.
    expect(passages.length).toBe(1);
    expect(passages[0]).toContain("sustainable");
    expect(passages[0]).toContain("eco-friendly");
  });

  it("respects the max passage count", () => {
    const parts: string[] = [];
    for (let i = 0; i < 20; i++) {
      parts.push("filler ".repeat(50));
      parts.push("green");
    }
    const text = parts.join(" ");
    const passages = selectPassages(text, ["green"], { max: 3, window: 20 });
    expect(passages.length).toBeLessThanOrEqual(3);
  });

  it("defaults to a max of 8 passages and a window of 600 characters", () => {
    const parts: string[] = [];
    for (let i = 0; i < 20; i++) {
      parts.push("filler ".repeat(200));
      parts.push("natural");
    }
    const text = parts.join(" ");
    const passages = selectPassages(text, ["natural"]);
    expect(passages.length).toBeLessThanOrEqual(8);
    for (const p of passages) {
      expect(text.includes(p)).toBe(true);
    }
  });

  it("returns [] for empty text", () => {
    expect(selectPassages("", ["natural"])).toEqual([]);
  });

  it("every returned passage is an exact (verbatim) substring of the source text", () => {
    const text = "Café com açúcar é uma alternativa sustentável para energia natural, dizem os relatórios.";
    const passages = selectPassages(text, ["sustentável", "natural"], { window: 30 });
    for (const p of passages) {
      expect(text.indexOf(p)).toBeGreaterThanOrEqual(0);
    }
  });
});
