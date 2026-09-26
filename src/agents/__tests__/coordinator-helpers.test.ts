import { describe, expect, it } from "vitest";
import {
  BRAND_DOMAINS,
  domainMatches,
  deterministicNextAction,
  gateVerdict,
  isDuplicateStep,
  isSelfDeclaredSource,
  normalizeBrand,
  summarizeRequired,
  truncate,
  withBudget,
} from "../coordinator-helpers";

describe("withBudget", () => {
  it("resolves ok:true when the promise settles before the deadline", async () => {
    const now = () => 1000;
    const result = await withBudget(Promise.resolve("value"), 2000, "test", now);
    expect(result).toEqual({ ok: true, value: "value" });
  });

  it("resolves a timeout marker immediately when the deadline has already passed", async () => {
    const now = () => 5000;
    const result = await withBudget(new Promise(() => {}), 1000, "late", now);
    expect(result).toEqual({ ok: false, timedOut: true, label: "late" });
  });

  it("resolves a timeout marker when the promise outlives the remaining budget", async () => {
    const now = () => 0;
    const slow = new Promise((resolve) => setTimeout(() => resolve("too-late"), 50));
    const result = await withBudget(slow, 10, "slow-stage", now);
    expect(result).toEqual({ ok: false, timedOut: true, label: "slow-stage" });
  });

  it("propagates a rejection that happens before the deadline", async () => {
    const now = () => 0;
    await expect(withBudget(Promise.reject(new Error("boom")), 1000, "failing", now)).rejects.toThrow("boom");
  });

  it("ignores a late rejection once it has already timed out", async () => {
    const now = () => 0;
    let reject!: (err: unknown) => void;
    const neverResolves = new Promise((_resolve, rej) => {
      reject = rej;
    });
    const result = await withBudget(neverResolves, 10, "late-reject", now);
    expect(result).toEqual({ ok: false, timedOut: true, label: "late-reject" });
    // Settle the underlying promise after the fact; withBudget must not throw or reject again.
    reject(new Error("too late to matter"));
    await new Promise((r) => setTimeout(r, 5));
  });
});

describe("normalizeBrand", () => {
  it("strips accents, case and punctuation", () => {
    expect(normalizeBrand("Yves Saint Laurent")).toBe("yvessaintlaurent");
    expect(normalizeBrand("L'Oréal")).toBe("loreal");
    expect(normalizeBrand("Ysl")).toBe("ysl");
  });
});

describe("domainMatches", () => {
  it("matches an exact plain domain and its subdomains", () => {
    expect(domainMatches("loreal.com", "loreal.com")).toBe(true);
    expect(domainMatches("www.loreal.com", "loreal.com")).toBe(true);
    expect(domainMatches("press.loreal.com", "loreal.com")).toBe(true);
    expect(domainMatches("notloreal.com", "loreal.com")).toBe(false);
  });

  it("matches a wildcard-suffix pattern across TLDs and subdomains", () => {
    expect(domainMatches("garnier.pt", "garnier.*")).toBe(true);
    expect(domainMatches("garnier.com", "garnier.*")).toBe(true);
    expect(domainMatches("garnier.co.uk", "garnier.*")).toBe(true);
    expect(domainMatches("shop.garnier.pt", "garnier.*")).toBe(true);
    expect(domainMatches("notgarnier.pt", "garnier.*")).toBe(false);
    expect(domainMatches("garniershop.pt", "garnier.*")).toBe(false);
  });
});

describe("isSelfDeclaredSource", () => {
  it("treats the claim's own domain as self-declared regardless of brand", () => {
    expect(isSelfDeclaredSource("garnier.pt", "garnier.pt", undefined)).toBe(true);
    expect(isSelfDeclaredSource("shop.garnier.pt", "garnier.pt", undefined)).toBe(true);
  });

  it("falls back to domain equality with the claim's own source when the brand is unknown", () => {
    expect(isSelfDeclaredSource("independent-lab.org", "unknownbrand.example", "Some Random Brand")).toBe(false);
    expect(isSelfDeclaredSource("unknownbrand.example", "unknownbrand.example", "Some Random Brand")).toBe(true);
  });

  it("marks the parent-group domain self-declared for known brands (Garnier/YSL -> loreal.com)", () => {
    expect(isSelfDeclaredSource("loreal.com", "garnier.pt", "Garnier")).toBe(true);
    expect(isSelfDeclaredSource("www.loreal.com", "garnier.pt", "garnier")).toBe(true);
    expect(isSelfDeclaredSource("loreal.com", "yslbeauty.com", "Yves Saint Laurent")).toBe(true);
    expect(isSelfDeclaredSource("loreal.com", "yslbeauty.com", "YSL")).toBe(true);
  });

  it("marks lorealparis.* self-declared for Garnier via the brand-domain map", () => {
    expect(isSelfDeclaredSource("lorealparis.com", "garnier.pt", "Garnier")).toBe(true);
  });

  it("does not mark an unrelated brand's domain self-declared", () => {
    expect(isSelfDeclaredSource("lush.com", "garnier.pt", "Garnier")).toBe(false);
  });

  it("treats a genuinely independent certifier domain as not self-declared", () => {
    expect(isSelfDeclaredSource("crueltyfreeinternational.org", "garnier.pt", "Garnier")).toBe(false);
  });

  it("has entries for every brand named in the spec", () => {
    expect(BRAND_DOMAINS.garnier).toContain("loreal.com");
    expect(BRAND_DOMAINS.lush).toContain("lush.com");
  });
});

describe("gateVerdict", () => {
  const base = {
    ruleVerdict: "NOT_PUBLICLY_VERIFIABLE" as const,
    searchMode: "full" as const,
    fetchedIndependentCandidate: true,
    deadlineHit: false,
  };

  it("passes BACKED and VAGUE through untouched", () => {
    expect(gateVerdict({ ...base, ruleVerdict: "BACKED" })).toEqual({ verdict: "BACKED" });
    expect(gateVerdict({ ...base, ruleVerdict: "VAGUE" })).toEqual({ verdict: "VAGUE" });
  });

  it("allows NOT_PUBLICLY_VERIFIABLE after a completed bounded search", () => {
    expect(gateVerdict(base)).toEqual({ verdict: "NOT_PUBLICLY_VERIFIABLE" });
  });

  it("withholds the verdict when search mode is limited", () => {
    const result = gateVerdict({ ...base, searchMode: "limited" });
    expect(result.verdict).toBeUndefined();
    expect(result.gap).toMatch(/not completed/i);
  });

  it("withholds the verdict when no independent candidate was fetched", () => {
    const result = gateVerdict({ ...base, fetchedIndependentCandidate: false });
    expect(result.verdict).toBeUndefined();
    expect(result.gap).toMatch(/no independent page/i);
  });

  it("withholds the verdict when the deadline was hit", () => {
    const result = gateVerdict({ ...base, deadlineHit: true });
    expect(result.verdict).toBeUndefined();
    expect(result.gap).toMatch(/time limit/i);
  });

  it("checks search mode before candidate-fetched before deadline", () => {
    const result = gateVerdict({
      ruleVerdict: "NOT_PUBLICLY_VERIFIABLE",
      searchMode: "limited",
      fetchedIndependentCandidate: false,
      deadlineHit: true,
    });
    expect(result.gap).toMatch(/not completed/i);
  });
});

describe("deterministicNextAction", () => {
  it("returns a distinct sentence per verdict, and a fallback for undefined", () => {
    const backed = deterministicNextAction("BACKED");
    const vague = deterministicNextAction("VAGUE");
    const npv = deterministicNextAction("NOT_PUBLICLY_VERIFIABLE");
    const none = deterministicNextAction(undefined);
    const all = [backed, vague, npv, none];
    expect(new Set(all).size).toBe(4);
    for (const s of all) expect(s.length).toBeGreaterThan(0);
  });
});

describe("truncate", () => {
  it("leaves short text untouched and clips long text with an ellipsis", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("a".repeat(20), 10)).toBe(`${"a".repeat(9)}…`);
  });
});

describe("summarizeRequired", () => {
  it("shows at most 4 items, truncated to 120 chars, with a '+N more' suffix", () => {
    const items = ["one", "two", "three", "four", "five", "six"];
    const summary = summarizeRequired(items);
    expect(summary).toContain("one; two; three; four");
    expect(summary).toContain("(+2 more)");
    expect(summary).not.toContain("five");
  });

  it("truncates a single long item to 120 chars", () => {
    const long = "x".repeat(200);
    const summary = summarizeRequired([long]);
    expect(summary.replace(" (+0 more)", "").length).toBeLessThanOrEqual(120);
  });

  it("omits the suffix entirely at 4 or fewer items", () => {
    expect(summarizeRequired(["a", "b"])).toBe("a; b");
  });
});

describe("isDuplicateStep", () => {
  it("is false when there is no previous step", () => {
    expect(isDuplicateStep(undefined, { agent: "scout", label: "x" })).toBe(false);
  });

  it("is true only when agent, label, detail and url all match", () => {
    const a = { agent: "scout", label: "Searched: x", detail: "1 result", url: undefined };
    const b = { agent: "scout", label: "Searched: x", detail: "1 result", url: undefined };
    expect(isDuplicateStep(a, b)).toBe(true);
    expect(isDuplicateStep(a, { ...b, detail: "2 results" })).toBe(false);
    expect(isDuplicateStep(a, { ...b, url: "https://example.com" })).toBe(false);
    expect(isDuplicateStep(a, { ...b, agent: "verdict" })).toBe(false);
  });
});
