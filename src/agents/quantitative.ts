// Quantitative Specialist Durable Object. See docs/ARCHITECTURE.md §2/§3.
import type { SpecialistId } from "../shared/internal";
import { SpecialistAgent } from "./specialist-base";

const QUANTITATIVE_KNOWLEDGE = `Specialty: claims that state a percentage or number about environmental impact or composition
(packaging savings, carbon reduction, natural-origin percentage, recycled content, etc.).
- A number alone proves nothing. Require, as separate required items where relevant: (1) the BASELINE it is compared
  against (what exactly is being compared to what — e.g. "one refillable 50ml bottle + one 100ml refill" vs "three
  classic 50ml bottles"); (2) the COMPARISON METHOD (how the percentage was calculated); (3) the UNDERLYING DATA
  (component weights, volumes, material breakdowns) needed to reproduce the number; (4) the SCOPE the number applies
  to (one SKU, one range, one region); (5) any ASSUMPTIONS baked into the figure (for example a saving that only
  materialises "if the customer buys the refill instead of a new bottle" is conditional, not a flat guarantee).
- Never assume arithmetic checks out. If the underlying weights/volumes and method are not published, the percentage
  cannot be verified from public sources even if a baseline description exists — treat that as a gap, not as
  supporting evidence.
- A claim about "% of natural origin" specifically needs a stated calculation method reference (ISO 16128) as a
  required item; without it, the percentage's basis is unverifiable.
- A brand's own methodology page or footnote is self-declared unless an independent body reviewed the same figures.`;

export class QuantitativeSpecialist extends SpecialistAgent {
  protected readonly role: SpecialistId = "quantitative";
  protected readonly knowledge = QUANTITATIVE_KNOWLEDGE;
}
