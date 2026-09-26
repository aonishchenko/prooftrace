import { describe, expect, it } from "vitest";
import { createEvidenceScout } from "../evidence-scout";
import type { FetchedPage } from "../../shared/internal";

// rankLinks is a pure function of (page, keywords, limit); env/DB/BROWSER are never touched
// by it, so a minimal stub scout is enough to exercise it without any Cloudflare bindings.
const scout = createEvidenceScout({} as unknown as Env, { investigationId: "test", onAttempt: () => {} });

function makePage(links: FetchedPage["links"], issuer = "garnier.pt"): FetchedPage {
  return {
    requestedUrl: `https://www.${issuer}/`,
    finalUrl: `https://www.${issuer}/`,
    httpStatus: 200,
    method: "fetch",
    title: "Garnier",
    text: "irrelevant for ranking",
    links,
    fetchedAt: new Date().toISOString(),
    cached: false,
    contentHash: "deadbeef",
    issuer,
  };
}

describe("rankLinks", () => {
  it("keeps only same-site links, including subdomains, and drops other domains", () => {
    const page = makePage([
      { url: "https://www.garnier.pt/sustentabilidade", text: "Sustentabilidade" },
      { url: "https://sustentabilidade.garnier.pt/cruelty-free", text: "" },
      { url: "https://www.loreal.com/sustentabilidade", text: "L'Oréal" },
    ]);
    const result = scout.rankLinks(page, ["sustent", "cruelty"], 10);
    const urls = result.map((r) => r.url);
    expect(urls).toContain("https://www.garnier.pt/sustentabilidade");
    expect(urls).toContain("https://sustentabilidade.garnier.pt/cruelty-free");
    expect(urls).not.toContain("https://www.loreal.com/sustentabilidade");
    expect(result).toHaveLength(2);
  });

  it("excludes common asset extensions but keeps PDFs", () => {
    const page = makePage([
      { url: "https://www.garnier.pt/assets/sustentabilidade.css", text: "Sustentabilidade" },
      { url: "https://www.garnier.pt/assets/sustentabilidade.js", text: "Sustentabilidade" },
      { url: "https://www.garnier.pt/img/sustentabilidade.png", text: "" },
      { url: "https://www.garnier.pt/img/sustentabilidade.jpg", text: "" },
      { url: "https://www.garnier.pt/img/sustentabilidade.svg", text: "" },
      { url: "https://www.garnier.pt/img/sustentabilidade.webp", text: "" },
      { url: "https://www.garnier.pt/docs/relatorio-sustentabilidade.pdf", text: "Relatório de sustentabilidade" },
      { url: "https://www.garnier.pt/sustentabilidade", text: "Sustentabilidade" },
    ]);
    const result = scout.rankLinks(page, ["sustent"], 10);
    const urls = result.map((r) => r.url).sort();
    expect(urls).toEqual(
      ["https://www.garnier.pt/docs/relatorio-sustentabilidade.pdf", "https://www.garnier.pt/sustentabilidade"].sort(),
    );
  });

  it("excludes obvious navigation noise even when keywords match", () => {
    const page = makePage([
      { url: "https://www.garnier.pt/login/sustentabilidade", text: "" },
      { url: "https://www.garnier.pt/cart/sustentabilidade", text: "" },
      { url: "https://www.garnier.pt/cookie-policy", text: "Cookie policy sustentabilidade" },
      { url: "https://www.garnier.pt/privacy-sustentabilidade", text: "" },
      { url: "https://www.garnier.pt/terms-sustentabilidade", text: "" },
      { url: "https://www.garnier.pt/contact-sustentabilidade", text: "" },
      { url: "https://www.garnier.pt/sitemap-sustentabilidade", text: "" },
      { url: "https://www.garnier.pt/account/sustentabilidade", text: "" },
      { url: "https://www.garnier.pt/search?q=sustentabilidade", text: "" },
      { url: "https://www.garnier.pt/sustentabilidade", text: "" },
    ]);
    const result = scout.rankLinks(page, ["sustent"], 10);
    expect(result.map((r) => r.url)).toEqual(["https://www.garnier.pt/sustentabilidade"]);
  });

  it("scores by keyword hits in the URL path and anchor text, case- and accent-insensitively, and drops zero-score links", () => {
    const page = makePage([
      { url: "https://www.garnier.pt/compromisso-cruelty-free", text: "Cruelty Free" }, // compromisso(1) + cruelty(1 path + 1 text) = 3
      { url: "https://www.garnier.pt/vegan/produtos-vegan", text: "" }, // vegan x2 = 2, longer path
      { url: "https://www.garnier.pt/sustentabilidade", text: "SUSTENTABILIDADE" }, // sustent x2 = 2, shorter path
      { url: "https://www.garnier.pt/pagina-aleatoria", text: "Nada relevante" }, // 0
    ]);
    const keywords = ["sustent", "compromisso", "cruelty", "vegan", "recicl"];

    const result = scout.rankLinks(page, keywords, 10);

    expect(result.map((r) => r.url)).toEqual([
      "https://www.garnier.pt/compromisso-cruelty-free",
      "https://www.garnier.pt/sustentabilidade",
      "https://www.garnier.pt/vegan/produtos-vegan",
    ]);
  });

  it("respects the limit while preserving score-desc, then shorter-path-first ordering", () => {
    const page = makePage([
      { url: "https://www.garnier.pt/compromisso-cruelty-free", text: "Cruelty Free" },
      { url: "https://www.garnier.pt/vegan/produtos-vegan", text: "" },
      { url: "https://www.garnier.pt/sustentabilidade", text: "SUSTENTABILIDADE" },
      { url: "https://www.garnier.pt/pagina-aleatoria", text: "Nada relevante" },
    ]);
    const keywords = ["sustent", "compromisso", "cruelty", "vegan", "recicl"];

    const result = scout.rankLinks(page, keywords, 2);

    expect(result.map((r) => r.url)).toEqual([
      "https://www.garnier.pt/compromisso-cruelty-free",
      "https://www.garnier.pt/sustentabilidade",
    ]);
  });

  it("matches keywords and text accent-insensitively in both directions", () => {
    const page = makePage([
      { url: "https://www.garnier.pt/pagina", text: "Compromisso Sustentável" }, // accented text, plain keyword
      { url: "https://www.garnier.pt/reciclavel-info", text: "" }, // plain path, accented keyword
    ]);

    const withPlainKeyword = scout.rankLinks(page, ["sustentavel"], 10);
    expect(withPlainKeyword.map((r) => r.url)).toEqual(["https://www.garnier.pt/pagina"]);

    const withAccentedKeyword = scout.rankLinks(page, ["reciclável"], 10);
    expect(withAccentedKeyword.map((r) => r.url)).toEqual(["https://www.garnier.pt/reciclavel-info"]);
  });

  it("returns an empty array when no link scores above zero", () => {
    const page = makePage([{ url: "https://www.garnier.pt/pagina-aleatoria", text: "Nada relevante" }]);
    expect(scout.rankLinks(page, ["sustent", "cruelty"], 10)).toEqual([]);
  });
});
