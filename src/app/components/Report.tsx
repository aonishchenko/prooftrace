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

  // A claim was actually investigated (and belongs in the full ClaimCard,
  // verdict badge and gap reasons included) if the run recorded anything
  // about it at all - not just a verdict or a required-evidence list. A claim
  // whose investigation failed outright (required: [] with the failure
  // explained in gaps) must not be silently demoted to "Other claims found"
  // with its reason hidden.
  const wasInvestigated = (c: (typeof investigation.claims)[number]) =>
    Boolean(
      c.verdict ||
        c.required.length > 0 ||
        c.gaps.length > 0 ||
        c.checkedUrls.length > 0 ||
        (c.checks && c.checks.length > 0) ||
        c.claimId === investigation.selectedClaimId,
    );

  const investigated = investigation.claims.filter(wasInvestigated);
  const other = investigation.claims.filter((c) => !wasInvestigated(c));
  const allRetrievedAt = investigation.claims.flatMap((c) => c.evidence.map((e) => e.retrievedAt));
  const range = formatUtcRange(allRetrievedAt);

  return (
    <div className="report" aria-label="Investigation report">
      {(status === "incomplete" || status === "error") && (
        <div className="report__error" role="alert">
          <p className="report__error-title">{status === "error" ? "Something went wrong" : "Investigation incomplete"}</p>
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
          <p className="lbl">Other claims found</p>
          <ul>
            {other.map((claim) => (
              <li key={claim.claimId}>
                <span className="tag">{claim.type}</span> <span className="serif">“{claim.text}”</span>
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
    </div>
  );
}
