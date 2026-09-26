import { useState } from "react";
import type { ClaimResult, Verdict } from "../../shared/types";
import { formatUtc, truncateUrl } from "../format";
import { EvidenceRequestModal } from "./EvidenceRequestModal";

const VERDICT_LABEL: Record<Verdict, string> = {
  BACKED: "BACKED",
  VAGUE: "VAGUE",
  NOT_PUBLICLY_VERIFIABLE: "NOT PUBLICLY VERIFIABLE",
};

function VerdictBadge({ verdict, attempted }: { verdict?: Verdict; attempted: boolean }) {
  if (!verdict) {
    return <span className="chip chip--verdict chip--verdict-none">{attempted ? "UNVERIFIED" : "NOT CHECKED"}</span>;
  }
  return (
    <span className={`chip chip--verdict chip--verdict-${verdict.toLowerCase()}`}>
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

export function ClaimCard({ claim }: { claim: ClaimResult }) {
  const [showRequest, setShowRequest] = useState(false);

  // Only evidence that is independent, in scope, and fully supportive can tick
  // a requirement - matches the backend's own verdict rule, so a checkmark
  // here never contradicts the claim's overall verdict. Everything else
  // (self-declared, out-of-scope, or partial support) still tells the reader
  // something was found, but only as a neutral "partial / self-declared" note.
  const isStrongEvidence = (e: (typeof claim.evidence)[number]) =>
    e.independent && e.scopeMatch && e.supports === "full";
  const satisfied = new Set(
    claim.evidence.filter(isStrongEvidence).flatMap((e) => e.satisfies),
  );
  const weaklySatisfied = new Set(
    claim.evidence.filter((e) => !isStrongEvidence(e)).flatMap((e) => e.satisfies),
  );

  return (
    <article className="claim-card">
      <blockquote className="claim-card__quote">
        “{claim.text}”
        <footer>
          <a href={claim.sourceUrl} target="_blank" rel="noreferrer" title={claim.sourceUrl}>
            {truncateUrl(claim.sourceUrl)}
          </a>
        </footer>
      </blockquote>

      <div className="claim-card__meta">
        <span className="chip chip--type">{claim.type}</span>
        <VerdictBadge verdict={claim.verdict} attempted={claim.required.length > 0 || claim.checkedUrls.length > 0} />
      </div>

      {claim.checks && claim.checks.length > 0 && (
        <div className="claim-card__section">
          <h4>Checks</h4>
          <ul className="claim-card__checks">
            {claim.checks.map((check) => (
              <li key={check.name} className={check.pass ? "is-pass" : "is-fail"}>
                <span aria-hidden="true">{check.pass ? "✓" : "✕"}</span> {check.name}
              </li>
            ))}
          </ul>
        </div>
      )}

      {claim.required.length > 0 && (
        <div className="claim-card__section">
          <h4>Evidence required</h4>
          <ul>
            {claim.required.map((req) => {
              const isFull = satisfied.has(req);
              const isPartial = !isFull && weaklySatisfied.has(req);
              return (
                <li key={req} className={isFull ? "is-pass" : isPartial ? "is-partial" : undefined}>
                  {isFull && <span aria-hidden="true">✓ </span>}
                  {isPartial && <span aria-hidden="true">◐ </span>}
                  {req}
                  {isPartial && <span className="claim-card__partial-note"> partial / self-declared</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {claim.evidence.length > 0 && (
        <div className="claim-card__section">
          <h4>Evidence</h4>
          <ul className="evidence-list">
            {claim.evidence.map((evidence, index) => (
              <li key={`${evidence.url}-${index}`}>
                <blockquote>“{evidence.quote}”</blockquote>
                <div className="evidence-list__meta">
                  <span>{evidence.issuer}</span>
                  <a href={evidence.url} target="_blank" rel="noreferrer" title={evidence.url}>
                    {truncateUrl(evidence.url)}
                  </a>
                  <span className="chip">{evidence.independent ? "Independent" : "Self-declared"}</span>
                  {evidence.cached && <span className="chip">Cached source</span>}
                  <span className="chip">Supports {evidence.supports}</span>
                  <span className="evidence-list__date">{formatUtc(evidence.retrievedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {claim.gaps.length > 0 && (
        <div className="claim-card__section">
          <h4>Gaps</h4>
          <ul>
            {claim.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </div>
      )}

      {claim.checkedUrls.length > 0 && (
        <details className="claim-card__sources">
          <summary>Sources checked ({claim.checkedUrls.length})</summary>
          <ul>
            {claim.checkedUrls.map((checked) => (
              <li key={checked.url}>
                <span className={`chip chip--${checked.status}`}>{checked.status}</span>
                <a href={checked.url} target="_blank" rel="noreferrer" title={checked.url}>
                  {truncateUrl(checked.url)}
                </a>
                {checked.reason && <span className="claim-card__reason"> — {checked.reason}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {claim.rewrite && (
        <div className="claim-card__section">
          <h4>Rewrite suggestion</h4>
          <p>{claim.rewrite}</p>
        </div>
      )}

      {claim.nextAction && (
        <div className="claim-card__section">
          <h4>Next action</h4>
          <p>{claim.nextAction}</p>
        </div>
      )}

      {claim.evidenceRequest && (
        <div>
          <button type="button" className="button button--secondary" onClick={() => setShowRequest(true)}>
            Request missing evidence
          </button>
          {showRequest && (
            <EvidenceRequestModal text={claim.evidenceRequest} onClose={() => setShowRequest(false)} />
          )}
        </div>
      )}
    </article>
  );
}
