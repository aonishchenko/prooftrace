import { describe, expect, it } from "vitest";
import { fallbackExtractClaims, isSubstantiveClaim, numericClaimCandidates } from "../extractor";
import type { FetchedPage } from "../../shared/internal";

describe("claim quality filter", () => {
  it("rejects Garnier homepage navigation while retaining a specific linked-page assertion", () => {
    expect(isSubstantiveClaim("EcoBeautyScore")).toBe(false);
    expect(isSubstantiveClaim("New! Garnier x Gisele")).toBe(false);
    expect(isSubstantiveClaim("Body Superfood Aloe Vera")).toBe(false);

    const line = "99% dos nossos ingredientes são vega* *Sem ingredientes ou derivados de origem animal";
    expect(numericClaimCandidates(`Fórmulas vegan\n${line}\nHidrata por 48h`)).toEqual([line]);
  });

  it("can extract the Garnier percentage directly if the hosted extractor stalls", () => {
    const page = {
      title: "Ingredientes: Descobre Todos os Nossos Segredos | Garnier",
      text: "Fórmulas vegan\n99% dos nossos ingredientes são vega* *Sem ingredientes ou derivados de origem animal\nEm Garnier, acreditamos que as Ciências Green impulsionarão o futuro da beleza, permitindo-nos criar fórmulas com um impacto reduzido no planeta.",
    } as FetchedPage;
    expect(fallbackExtractClaims(page)).toMatchObject([
      { claimId: "c1", type: "quantitative", brand: "Garnier", text: "99% dos nossos ingredientes são vega* *Sem ingredientes ou derivados de origem animal" },
      { claimId: "c2", type: "generic", brand: "Garnier" },
    ]);
  });
});
