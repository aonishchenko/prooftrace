import { describe, expect, it } from "vitest";
import { VAGUE_TERMS, decideVerdict, satisfiesRequirement, unmetRequired } from "../rules";
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

  it("an empty required list can never be BACKED, even with a strong independent anchor and no gaps", () => {
    const claim: ExtractedClaim = {
      claimId: "c9",
      text: "Garnier is approved by Cruelty Free International",
      type: "certification",
      brand: "Garnier",
    };
    const ev = [
      evidence({
        independent: true,
        supports: "full",
        scopeMatch: true,
        satisfies: [],
      }),
    ];
    const result = decideVerdict(claim, [], ev, []);
    expect(result.verdict).toBe("NOT_PUBLICLY_VERIFIABLE");
    expect(result.checks.find((c) => c.name === "All required items met")?.pass).toBe(false);
  });

  it("partial support alone never satisfies a required item for BACKED (only independent+scopeMatch+full does)", () => {
    const claim: ExtractedClaim = {
      claimId: "c10",
      text: "Refilling saves 50% packaging",
      type: "quantitative",
      brand: "Acme",
    };
    const required = ["Baseline used for the stated figure"];
    const ev = [
      evidence({
        independent: true,
        supports: "partial",
        scopeMatch: true,
        satisfies: [required[0]],
      }),
    ];
    const result = decideVerdict(claim, required, ev, []);
    expect(result.verdict).toBe("NOT_PUBLICLY_VERIFIABLE");
  });

  it("whole-word VAGUE_TERMS matching: 'ética' does not match inside 'cosmética'", () => {
    const claim: ExtractedClaim = {
      claimId: "c11",
      text: "A nossa marca de cosmética capilar para todos os dias",
      type: "sourcing",
      language: "pt",
    };
    const result = decideVerdict(claim, [], [], []);
    expect(result.verdict).not.toBe("VAGUE");
  });

  it("whole-word VAGUE_TERMS matching: 'green' does not match inside 'greenhouse'", () => {
    const claim: ExtractedClaim = {
      claimId: "c12",
      text: "We track our greenhouse gas emissions every year",
      type: "sourcing",
    };
    const result = decideVerdict(claim, [], [], []);
    expect(result.verdict).not.toBe("VAGUE");
  });

  it("whole-word VAGUE_TERMS matching: 'clean' does not match inside 'cleanser'", () => {
    const claim: ExtractedClaim = {
      claimId: "c13",
      text: "Our best-selling cleanser for daily use",
      type: "sourcing",
    };
    const result = decideVerdict(claim, [], [], []);
    expect(result.verdict).not.toBe("VAGUE");
  });

  it("'Green' as a standalone word IS vague ('A nossa ciência é Green')", () => {
    const claim: ExtractedClaim = {
      claimId: "c14",
      text: "A nossa ciência é Green",
      type: "sourcing",
      language: "pt",
    };
    const result = decideVerdict(claim, [], [], []);
    expect(result.verdict).toBe("VAGUE");
  });

  it("a footnote-style marker glued to a word does not count as a bounding number ('vegan*' has no real quantity)", () => {
    const claim: ExtractedClaim = {
      claimId: "c15",
      text: "Fórmula vegan* mais sustentável",
      type: "sourcing",
      language: "pt",
    };
    const result = decideVerdict(claim, [], [], []);
    expect(result.verdict).toBe("VAGUE");
  });

  it("a digit glued to a word as a footnote marker (no unit/percent) does not count as a bounding number", () => {
    const claim: ExtractedClaim = {
      claimId: "c16b",
      text: "Ingredientes de origem natural1 em toda a nossa gama",
      type: "sourcing",
      language: "pt",
    };
    const result = decideVerdict(claim, [], [], []);
    // "natural" is in VAGUE_TERMS; the glued footnote digit "1" is not a real quantity, so it must
    // not bound the term the way a real "50 ml"/"97%" quantity would.
    expect(result.verdict).toBe("VAGUE");
  });

  it("a real quantity ('50 ml') bounds an otherwise-vague sourcing term", () => {
    const claim: ExtractedClaim = {
      claimId: "c16",
      text: "Embalagem responsável com 50 ml de recarga",
      type: "sourcing",
      language: "pt",
    };
    const result = decideVerdict(claim, [], [], []);
    expect(result.verdict).not.toBe("VAGUE");
  });

  it("a 'generic'-typed claim with a real quantity is NOT automatically VAGUE", () => {
    const claim: ExtractedClaim = {
      claimId: "c17",
      text: "Our packaging uses 97% recycled materials",
      type: "generic",
    };
    const result = decideVerdict(claim, [], [], []);
    expect(result.verdict).not.toBe("VAGUE");
  });

  it("a 'generic'-typed claim with a named standard is NOT automatically VAGUE", () => {
    const claim: ExtractedClaim = {
      claimId: "c18",
      text: "Our cocoa follows the Fairtrade programme",
      type: "generic",
    };
    const result = decideVerdict(claim, [], [], []);
    expect(result.verdict).not.toBe("VAGUE");
  });

  it("a 'generic'-typed claim with no quantity or standard is still VAGUE", () => {
    const claim: ExtractedClaim = { claimId: "c19", text: "We care about the planet", type: "generic" };
    const result = decideVerdict(claim, [], [], []);
    expect(result.verdict).toBe("VAGUE");
  });
});

describe("satisfiesRequirement", () => {
  it("is true only for independent + scopeMatch + full support", () => {
    expect(satisfiesRequirement(evidence({ independent: true, scopeMatch: true, supports: "full" }))).toBe(true);
  });

  it("is false when support is only partial", () => {
    expect(satisfiesRequirement(evidence({ independent: true, scopeMatch: true, supports: "partial" }))).toBe(false);
  });

  it("is false when the source is not independent", () => {
    expect(satisfiesRequirement(evidence({ independent: false, scopeMatch: true, supports: "full" }))).toBe(false);
  });

  it("is false when the scope does not match", () => {
    expect(satisfiesRequirement(evidence({ independent: true, scopeMatch: false, supports: "full" }))).toBe(false);
  });
});

describe("unmetRequired", () => {
  it("returns required items with no evidence satisfying them", () => {
    const required = ["A", "B", "C"];
    const ev = [evidence({ independent: true, scopeMatch: true, supports: "full", satisfies: ["A"] })];
    expect(unmetRequired(required, ev)).toEqual(["B", "C"]);
  });

  it("does not count partial support as meeting a required item", () => {
    const required = ["A"];
    const ev = [evidence({ independent: true, scopeMatch: true, supports: "partial", satisfies: ["A"] })];
    expect(unmetRequired(required, ev)).toEqual(["A"]);
  });

  it("returns [] when every required item is satisfied", () => {
    const required = ["A", "B"];
    const ev = [
      evidence({ independent: true, scopeMatch: true, supports: "full", satisfies: ["A"] }),
      evidence({ independent: true, scopeMatch: true, supports: "full", satisfies: ["B"] }),
    ];
    expect(unmetRequired(required, ev)).toEqual([]);
  });
});
