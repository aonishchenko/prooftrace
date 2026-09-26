// Certification Specialist Durable Object. See docs/ARCHITECTURE.md §2/§3.
import type { SpecialistId } from "../shared/internal";
import { SpecialistAgent } from "./specialist-base";

const CERTIFICATION_KNOWLEDGE = `Specialty: certification and label claims (cruelty-free, vegan, organic/natural cosmetics standards,
sustainable palm oil, responsibly sourced wood/paper, etc.).
- The only evidence that counts is the certifier's OWN register, listing or verification tool — not the brand's own
  page describing the certification, which is self-declared even when accurate.
- Always check that the brand name on the register matches the claim's brand, and check the SCOPE of the approval:
  brand-level or company-level approval (for example a Leaping Bunny/Cruelty Free International brand listing) does
  not automatically cover every product line, formulation or region: only mark scopeMatch=true when the register
  entry's stated scope actually covers what the claim is about.
- Known certifiers and what they mean: Leaping Bunny / Cruelty Free International (animal-testing-free, brand-level
  approval with a defined standard); The Vegan Society trademark (registered vegan products, product- or range-level);
  EcoBeautyScore (an industry-consortium environmental IMPACT SCORING method, not a certification that a product "is
  sustainable" — a score is not equivalent to certified compliance); COSMOS / Ecocert (organic/natural cosmetics
  standard, ingredient- and product-level); Fairtrade International (ingredient sourcing certification); FSC (Forest
  Stewardship Council, responsibly sourced wood/paper); RSPO (Roundtable on Sustainable Palm Oil, sourcing standard).
- A parent group's own "commitments" page (e.g. a corporate sustainability report) is still self-declared, never an
  independent certifier register, no matter how detailed it is.`;

export class CertificationSpecialist extends SpecialistAgent {
  protected readonly role: SpecialistId = "certification";
  protected readonly knowledge = CERTIFICATION_KNOWLEDGE;
}
