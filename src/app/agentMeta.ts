// Presentation metadata for each AgentId: readable name + a distinct badge colour.
// Colour values are CSS custom-property references so dark mode swaps them automatically.
import type { AgentId } from "../shared/types";

export interface AgentMeta {
  name: string;
  color: string;
}

export const AGENT_META: Record<AgentId, AgentMeta> = {
  coordinator: { name: "Coordinator", color: "var(--agent-coordinator)" },
  scout: { name: "Evidence Scout", color: "var(--agent-scout)" },
  extractor: { name: "Claim Extractor", color: "var(--agent-extractor)" },
  certification: { name: "Certification Specialist", color: "var(--agent-certification)" },
  quantitative: { name: "Quantitative Specialist", color: "var(--agent-quantitative)" },
  sourcing: { name: "Sourcing Specialist", color: "var(--agent-sourcing)" },
  verdict: { name: "Verdict", color: "var(--agent-verdict)" },
};

export function agentName(id: AgentId): string {
  return AGENT_META[id]?.name ?? id;
}
