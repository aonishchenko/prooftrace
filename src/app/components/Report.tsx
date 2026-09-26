import type { Investigation } from "../../shared/types";
import { agentName } from "../agentMeta";
import { formatUtcRange } from "../format";
import { ClaimCard } from "./ClaimCard";

/** Final report: shown once the investigation is done, incomplete, or errored. */
export function Report({ investigation }: { investigation: Investigation }) {
  const { status } = investigation;
  if (status !== "done" && status !== "incomplete" && status !== "error") {
    return null;
  }

  const investigated = investigation.claims.filter((c) => c.required.length > 0 || c.verdict);
  const other = investigation.claims.filter((c) => !(c.required.length > 0 || c.verdict));
  const allRetrievedAt = investigation.claims.flatMap((c) => c.evidence.map((e) => e.retrievedAt));
  const range = formatUtcRange(allRetrievedAt);

  return (
    <section className="report" aria-label="Investigation report">
      {(status === "incomplete" || status === "error") && (
        <div className="report__error" role="alert">
          <h2>{status === "error" ? "Something went wrong" : "Investigation incomplete"}</h2>
          <p>{investigation.error ?? "No further detail was provided."}</p>
          {investigation.steps.length > 0 && (
            <details className="report__attempted">
              <summary>What was attempted ({investigation.steps.length} steps)</summary>
              <ul>
                {investigation.steps.map((step) => (
                  <li key={step.id}>
                    {agentName(step.agent)}: {step.label}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {investigated.map((claim) => (
        <ClaimCard key={claim.claimId} claim={claim} />
      ))}

      {other.length > 0 && (
        <div className="report__other-claims">
          <h3>Other claims found</h3>
          <ul>
            {other.map((claim) => (
              <li key={claim.claimId}>
                <span className="chip chip--type">{claim.type}</span> “{claim.text}”
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="report__small-print">
        {range
          ? `Based on public pages retrieved ${range}. `
          : "Based on public pages retrieved during this run. "}
        This search may not cover every source. The absence of public evidence does not mean a claim is
        false.
      </p>
    </section>
  );
}
