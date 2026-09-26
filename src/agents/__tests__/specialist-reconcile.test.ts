import { describe, expect, it } from "vitest";
import { reconcileAssessment, resolveSatisfies } from "../specialist-reconcile";
import type { SourceExcerpt } from "../../shared/internal";

function source(overrides: Partial<SourceExcerpt>): SourceExcerpt {
  return {
    url: "https://www.crueltyfreeinternational.org/approved-brands/listing/garnier/",
    issuer: "crueltyfreeinternational.org",
    title: "Garnier — approved brands",
    retrievedAt: "2026-09-26T00:00:00.000Z",
    cached: false,
    selfDeclared: false,
    passages: ["Garnier is approved by Cruelty Free International under the Leaping Bunny programme."],
    ...overrides,
  };
}

describe("resolveSatisfies", () => {
  const required = ["Certifier register listing naming Garnier", "Certification scope covering brand-level approval"];

  it("resolves an exact text match", () => {
    expect(resolveSatisfies(["Certifier register listing naming Garnier"], required)).toEqual([required[0]]);
  });

  it("resolves a case/whitespace-insensitive near match", () => {
    expect(resolveSatisfies(["  certifier REGISTER   listing naming garnier  "], required)).toEqual([required[0]]);
  });

  it("resolves a 1-based numeric string index", () => {
    expect(resolveSatisfies(["2"], required)).toEqual([required[1]]);
  });

  it("resolves a 1-based numeric index given as a number", () => {
    expect(resolveSatisfies([1], required)).toEqual([required[0]]);
  });

  it("drops an out-of-range index", () => {
    expect(resolveSatisfies(["5", 0, -1], required)).toEqual([]);
  });

  it("drops text that matches none of the required items", () => {
    expect(resolveSatisfies(["something unrelated"], required)).toEqual([]);
  });

  it("dedupes repeated references to the same required item", () => {
    expect(resolveSatisfies(["1", "Certifier register listing naming Garnier"], required)).toEqual([required[0]]);
  });
});

describe("reconcileAssessment", () => {
  const required = ["Cruelty Free International brand-level approval listing for Garnier"];

  it("keeps evidence whose quote is verified against a given passage and maps satisfies by exact text", () => {
    const sources = [source({})];
    const raw = {
      evidence: [
        {
          url: sources[0].url,
          quote: "Garnier is approved by Cruelty Free International under the Leaping Bunny programme.",
          supports: "full" as const,
          scopeMatch: true,
          independent: true,
          satisfies: [required[0]],
        },
      ],
      gaps: [],
    };
    const result = reconcileAssessment(raw, required, sources);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].satisfies).toEqual([required[0]]);
    expect(result.gaps).toEqual([]);
  });

  it("maps satisfies given as a 1-based index", () => {
    const sources = [source({})];
    const raw = {
      evidence: [
        {
          url: sources[0].url,
          quote: "Garnier is approved by Cruelty Free International under the Leaping Bunny programme.",
          supports: "full" as const,
          scopeMatch: true,
          independent: true,
          satisfies: [1],
        },
      ],
      gaps: [],
    };
    const result = reconcileAssessment(raw, required, sources);
    expect(result.evidence[0].satisfies).toEqual([required[0]]);
  });

  it("drops evidence whose url is not one of the given sources", () => {
    const sources = [source({})];
    const raw = {
      evidence: [
        {
          url: "https://not-a-real-source.example/",
          quote: "Garnier is approved by Cruelty Free International under the Leaping Bunny programme.",
          supports: "full" as const,
          scopeMatch: true,
          independent: true,
          satisfies: [required[0]],
        },
      ],
      gaps: [],
    };
    const result = reconcileAssessment(raw, required, sources);
    expect(result.evidence).toEqual([]);
  });

  it("drops evidence whose quote cannot be found verbatim in any passage", () => {
    const sources = [source({})];
    const raw = {
      evidence: [
        {
          url: sources[0].url,
          quote: "This sentence was never on the page.",
          supports: "full" as const,
          scopeMatch: true,
          independent: true,
          satisfies: [required[0]],
        },
      ],
      gaps: [],
    };
    const result = reconcileAssessment(raw, required, sources);
    expect(result.evidence).toEqual([]);
  });

  it("drops a matched quote shorter than 25 characters", () => {
    const sources = [source({ passages: ["Garnier is approved. See our full policy for more detail on scope."] })];
    const raw = {
      evidence: [
        {
          url: sources[0].url,
          quote: "Garnier is approved.",
          supports: "full" as const,
          scopeMatch: true,
          independent: true,
          satisfies: [required[0]],
        },
      ],
      gaps: [],
    };
    const result = reconcileAssessment(raw, required, sources);
    expect(result.evidence).toEqual([]);
  });

  it("drops a matched quote with fewer than 4 words even if 25+ characters", () => {
    const sources = [source({ passages: ["Approved-approved-approved-approved-approved for the full brand range and scope."] })];
    const raw = {
      evidence: [
        {
          url: sources[0].url,
          quote: "Approved-approved-approved-approved-approved",
          supports: "full" as const,
          scopeMatch: true,
          independent: true,
          satisfies: [required[0]],
        },
      ],
      gaps: [],
    };
    const result = reconcileAssessment(raw, required, sources);
    expect(result.evidence).toEqual([]);
  });

  it("forces independent=false for a selfDeclared source regardless of the model's independent flag", () => {
    const sources = [source({ selfDeclared: true })];
    const raw = {
      evidence: [
        {
          url: sources[0].url,
          quote: "Garnier is approved by Cruelty Free International under the Leaping Bunny programme.",
          supports: "full" as const,
          scopeMatch: true,
          independent: true, // model wrongly claims independence
          satisfies: [required[0]],
        },
      ],
      gaps: [],
    };
    const result = reconcileAssessment(raw, required, sources);
    expect(result.evidence[0].independent).toBe(false);
  });

  it("computes gaps for required items with no full+independent+scopeMatch evidence (partial support is not enough)", () => {
    const sources = [source({})];
    const raw = {
      evidence: [
        {
          url: sources[0].url,
          quote: "Garnier is approved by Cruelty Free International under the Leaping Bunny programme.",
          supports: "partial" as const,
          scopeMatch: true,
          independent: true,
          satisfies: [required[0]],
        },
      ],
      gaps: [],
    };
    const result = reconcileAssessment(raw, required, sources);
    expect(result.gaps).toEqual([required[0]]);
  });

  it("adds the explicit 'no independent source' gap when nothing else would produce a gap and no evidence is independent", () => {
    const sources = [source({ selfDeclared: true })];
    const raw = {
      evidence: [
        {
          url: sources[0].url,
          quote: "Garnier is approved by Cruelty Free International under the Leaping Bunny programme.",
          supports: "full" as const,
          scopeMatch: true,
          independent: true, // forced to false because selfDeclared
          satisfies: [], // required=[] below, so unmetRequired([]) is []
        },
      ],
      gaps: [],
    };
    const result = reconcileAssessment(raw, [], sources);
    expect(result.gaps).toEqual(["No independent source found in the pages checked"]);
  });
});
