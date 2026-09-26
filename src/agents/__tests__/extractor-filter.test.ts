import { describe, expect, it } from "vitest";
import { isSubstantiveClaim, numericClaimCandidates } from "../extractor";

describe("claim quality filter", () => {
  it("rejects Garnier homepage navigation while retaining a specific linked-page assertion", () => {
    expect(isSubstantiveClaim("EcoBeautyScore")).toBe(false);
    expect(isSubstantiveClaim("New! Garnier x Gisele")).toBe(false);
    expect(isSubstantiveClaim("Body Superfood Aloe Vera")).toBe(false);

    const line = "99% dos nossos ingredientes são vega* *Sem ingredientes ou derivados de origem animal";
    expect(numericClaimCandidates(`Fórmulas vegan\n${line}\nHidrata por 48h`)).toEqual([line]);
  });
});
