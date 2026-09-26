import { describe, expect, it } from "vitest";
import { VAGUE_TERMS, decideVerdict } from "../rules";
import type { Evidence } from "../../shared/types";
import type { ExtractedClaim } from "../../shared/internal";

function evidence(overrides: Partial<Evidence>): Evidence {
  return {
    url: "https://example.org/",
    issuer: "example.org",
    quote: "quote",
    retrievedAt: "2026-09-26T00:00:00.000Z",
    cached: false,
    independent: true,
    supports: "full",
    scopeMatch: true,
    satisfies: [],
    ...overrides,
  };
}

describe("VAGUE_TERMS", () => {
  it("includes the EN and PT terms called out in the spec", () => {
    const expected = [
      "sustainable",
      "sustentável",
      "eco-friendly",
      "green",
      "verde",
      "ethical",
      "ético",
      "responsible",
      "responsável",
      "natural",
      "clean",
      "conscious",
      "consciente",
      "planet-friendly",
      "amigo do ambiente",
    ];
    for (const term of expected) {
      expect(VAGUE_TERMS).toContain(term);
    }
  });
});

describe("decideVerdict", () => {
  it("BACKED — Garnier-style: independent Cruelty Free International brand listing", () => {
    const claim: ExtractedClaim = {
      claimId: "c1",
      text: "Garnier is approved by Cruelty Free International",
      type: "certification",
      brand: "Garnier",
    };
    const required = ["Cruelty Free International brand-level approval listing for Garnier"];
    const ev = [
      evidence({
        url: "https://www.crueltyfreeinternational.org/approved-brands/listing/garnier/",
        issuer: "crueltyfreeinternational.org",
        quote: "Garnier is approved by Cruelty Free International",
        independent: true,
        supports: "full",
        scopeMatch: true,
        satisfies: [required[0]],
      }),
    ];
    const result = decideVerdict(claim, required, ev, []);
    expect(result.verdict).toBe("BACKED");
    expect(result.checks).toEqual([
      { name: "Claim is specific", pass: true },
      { name: "Evidence found", pass: true },
      { name: "Independent source", pass: true },
      { name: "Scope matches", pass: true },
      { name: "All required items met", pass: true },
    ]);
  });

  it("does not extend BACKED brand-level approval to a required item outside its scope", () => {
    const claim: ExtractedClaim = {
      claimId: "c1",
      text: "Garnier is approved by Cruelty Free International",
      type: "certification",
      brand: "Garnier",
    };
    const required = ["Cruelty Free International approval covering the specific product line"];
    const ev = [
      evidence({
        url: "https://www.crueltyfreeinternational.org/approved-brands/listing/garnier/",
        independent: true,
        supports: "full",
        scopeMatch: false, // brand-level only, not this product line
        satisfies: [],
      }),
    ];
    const result = decideVerdict(claim, required, ev, required);
    expect(result.verdict).toBe("NOT_PUBLICLY_VERIFIABLE");
  });

  it("NOT_PUBLICLY_VERIFIABLE — YSL-style: only a self-declared baseline, no independent method/data", () => {
    const claim: ExtractedClaim = {
      claimId: "c2",
      text: "Refilling the Eau de Parfum bottle helps to save 58%* glass, 59%* plastics and, 42%* paper.",
      type: "quantitative",
      brand: "YSL",
    };
    const required = [
      "Baseline bottles compared (refillable 50ml + 100ml refill vs three classic 50ml bottles)",
      "Comparison method / calculation",
      "Underlying component weights or volumes",
    ];
    const ev = [
      evidence({
        url: "https://www.yslbeauty.co.uk/fragrances/fragrances-for-her/libre/libre-eau-de-parfum/",
        issuer: "yslbeauty.co.uk",
        quote: "Refilling the Eau de Parfum bottle helps to save 58%* glass, 59%* plastics and, 42%* paper.",
        independent: false, // brand's own site
        supports: "partial",
        scopeMatch: true,
        satisfies: [required[0]],
      }),
    ];
    const gaps = [required[1], required[2]];
    const result = decideVerdict(claim, required, ev, gaps);
    expect(result.verdict).toBe("NOT_PUBLICLY_VERIFIABLE");
    expect(result.checks.find((c) => c.name === "Independent source")?.pass).toBe(false);
    expect(result.checks.find((c) => c.name === "All required items met")?.pass).toBe(false);
  });

  it("VAGUE — Lush-style broad sourcing heading with no bounding number or standard", () => {
    const claim: ExtractedClaim = {
      claimId: "c3",
      text: "Endless heaps of ethically- sourced ingredients",
      type: "sourcing",
      brand: "Lush",
    };
    const result = decideVerdict(claim, [], [], []);
    expect(result.verdict).toBe("VAGUE");
    expect(result.checks.find((c) => c.name === "Claim is specific")?.pass).toBe(false);
  });

  it("VAGUE — Portuguese generic sustainability wording ('alternativa sustentável')", () => {
    const claim: ExtractedClaim = {
      claimId: "c4",
      text: "Uma alternativa sustentável para o seu dia a dia",
      type: "sourcing",
      language: "pt",
    };
    const result = decideVerdict(claim, [], [], []);
    expect(result.verdict).toBe("VAGUE");
  });

  it("any 'generic' claim type is VAGUE regardless of wording", () => {
    const claim: ExtractedClaim = { claimId: "c5", text: "We care about the planet", type: "generic" };
    const result = decideVerdict(claim, [], [], []);
    expect(result.verdict).toBe("VAGUE");
  });

  it("is NOT vague — a bounded natural-origin percentage claim ('Fórmula vegan 97% de origem natural')", () => {
    const claim: ExtractedClaim = {
      claimId: "c6",
      text: "Fórmula vegan 97% de origem natural",
      type: "sourcing",
      language: "pt",
    };
    const required = ["ISO 16128 method reference for the natural-origin percentage"];
    const result = decideVerdict(claim, required, [], required);
    expect(result.verdict).not.toBe("VAGUE");
    expect(result.checks.find((c) => c.name === "Claim is specific")?.pass).toBe(true);
    // No evidence was supplied, so it should still fail to reach BACKED.
    expect(result.verdict).toBe("NOT_PUBLICLY_VERIFIABLE");
  });

  it("is NOT vague when a named standard bounds an otherwise-vague sourcing term", () => {
    const claim: ExtractedClaim = {
      claimId: "c7",
      text: "Ethically sourced through our Fairtrade cocoa programme",
      type: "sourcing",
    };
    const result = decideVerdict(claim, [], [], []);
    expect(result.verdict).not.toBe("VAGUE");
  });

  it("NOT_PUBLICLY_VERIFIABLE when there is no evidence at all", () => {
    const claim: ExtractedClaim = { claimId: "c8", text: "Certified organic by ExampleCert", type: "certification" };
    const required = ["ExampleCert register listing for the brand"];
    const result = decideVerdict(claim, required, [], required);
    expect(result.verdict).toBe("NOT_PUBLICLY_VERIFIABLE");
    expect(result.checks.find((c) => c.name === "Evidence found")?.pass).toBe(false);
  });
});
