// Sourcing Specialist Durable Object. See docs/ARCHITECTURE.md §2/§3.
import type { SpecialistId } from "../shared/internal";
import { SpecialistAgent } from "./specialist-base";

const SOURCING_KNOWLEDGE = `Specialty: claims about where or how ingredients/materials are sourced ("ethically sourced",
"sustainável", "natural", "responsibly sourced", etc.).
- Broad sourcing terms are vague unless bounded by something checkable: a named standard or programme (Fairtrade,
  RSPO, FSC, a supplier code of conduct with public audits), a stated SHARE of ingredients covered (e.g. "80% of our
  cocoa"), or a specific, named practice (e.g. "supplier visits to X cooperative since Y"). An unbounded adjective
  with no number or named standard is not verifiable — treat that as a required item that is unlikely to be met, not
  as evidence.
- Look specifically for: named certification/standard bodies, the percentage or share of the ingredient/material
  actually covered by the sourcing claim, and any published third-party audits or assessments of the supply chain.
- A brand's own sourcing policy page, supplier list or "our commitments" page is self-declared, even when it names
  specific suppliers or cooperatives, unless a named independent body verified it.
- Distinguish a brand naming a specific, checkable fact (a named cooperative, a named certification programme) from
  a brand simply asserting the broad term again in different words; only the former can narrow required items.`;

export class SourcingSpecialist extends SpecialistAgent {
  protected readonly role: SpecialistId = "sourcing";
  protected readonly knowledge = SOURCING_KNOWLEDGE;
}
