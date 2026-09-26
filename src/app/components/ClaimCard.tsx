import { useState } from "react";
import type { ClaimResult, Verdict } from "../../shared/types";
import { formatUtc, truncateUrl } from "../format";
import { EvidenceRequestModal } from "./EvidenceRequestModal";
import { EvidenceIcon, VerdictIcon, type EvidenceState } from "./icons";

const VERDICT_LABEL: Record<Verdict, string> = {
  BACKED: "Backed",
  VAGUE: "Vague",
  NOT_PUBLICLY_VERIFIABLE: "Not publicly verifiable",
};

const VERDICT_CLASS: Record<Verdict, string> = {
  BACKED: "v-backed",
  VAGUE: "v-vague",
  NOT_PUBLICLY_VERIFIABLE: "v-not_public",
};

const EVIDENCE_LABEL: Record<EvidenceState, string> = {
  found: "Found",
  partial: "Partial / self-declared",
  not_found: "Not found",
};

function VerdictPill({ verdict, attempted }: { verdict?: Verdict; attempted: boolean }) {
  const cls = verdict ? VERDICT_CLASS[verdict] : "v-none";
  const label = verdict ? VERDICT_LABEL[verdict] : attempted ? "Unverified" : "Not checked";
  return (
    <span className={`pill pop ${cls}`}>
      <VerdictIcon verdict={verdict} />
      {label}
    </span>
  );
}

export function ClaimCard({ claim }: { claim: ClaimResult }) {
  const [showRequest, setShowRequest] = useState(false);
  const [copied, setCopied] = useState(false);

  // Only evidence that is independent, in scope, and fully supportive can tick
  // a requirement - matches the backend's own verdict rule, so a tick here
  // never contradicts the claim's overall verdict. Everything else (self-declared,
  // out-of-scope, or partial support) shows as "partial / self-declared".
  const isStrongEvidence = (e: (typeof claim.evidence)[number]) =>
    e.independent && e.scopeMatch && e.supports === "full";
  const satisfied = new Set(claim.evidence.filter(isStrongEvidence).flatMap((e) => e.satisfies));
  const weaklySatisfied = new Set(
    claim.evidence.filter((e) => !isStrongEvidence(e)).flatMap((e) => e.satisfies),
  );
  const requirementState = (req: string): EvidenceState =>
    satisfied.has(req) ? "found" : weaklySatisfied.has(req) ? "partial" : "not_found";

  const copyRewrite = async () => {
    if (!claim.rewrite) return;
    try {
      await navigator.clipboard.writeText(claim.rewrite);
      setCopied(true);
      setTimeout(() => setCopied(false), 1700);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className="claim-card">
      <div className="blk">
        <p className="lbl">The claim</p>
        <p className="serif claimq">“{claim.text}”</p>
        <div className="meta">
          <span className="tag">{claim.type}</span>
          <a href={claim.sourceUrl} target="_blank" rel="noreferrer" title={claim.sourceUrl}>
            {truncateUrl(claim.sourceUrl.replace(/^https?:\/\//, ""), 48)}
          </a>
        </div>
      </div>

      <VerdictPill verdict={claim.verdict} attempted={claim.required.length > 0 || claim.checkedUrls.length > 0} />

      {claim.nextAction && <p className="sum">{claim.nextAction}</p>}

      {claim.gaps.length > 0 && (
        <div className="blk">
          <p className="lbl">Gaps</p>
          {claim.gaps.map((gap) => (
            <p key={gap} className="tip">
              {gap}
            </p>
          ))}
        </div>
      )}

      {claim.checks && claim.checks.length > 0 && (
        <div className="blk">
          <p className="lbl">Checks</p>
          <ul className="checks">
            {claim.checks.map((check) => (
              <li key={check.name} className={check.pass ? "s-found" : "s-not_found"}>
                <EvidenceIcon state={check.pass ? "found" : "not_found"} />
                <span>
                  <span className="sr-only">{check.pass ? "Passed: " : "Not met: "}</span>
                  {check.name}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {claim.required.length > 0 && (
        <div className="blk">
          <p className="lbl">Evidence required</p>
          {claim.required.map((req) => {
            const state = requirementState(req);
            return (
              <div key={req} className={`evi s-${state}`}>
                <EvidenceIcon state={state} />
                <div>
                  <span className="n">{req}</span> <span className="x">· {EVIDENCE_LABEL[state]}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {claim.evidence.length > 0 && (
        <div className="blk">
          <p className="lbl">Evidence</p>
          {claim.evidence.map((evidence, index) => {
            const state: EvidenceState = isStrongEvidence(evidence) ? "found" : evidence.supports === "none" ? "not_found" : "partial";
            return (
              <div key={`${evidence.url}-${index}`} className={`evi s-${state}`}>
                <EvidenceIcon state={state} />
                <div>
                  <blockquote className="quote">“{evidence.quote}”</blockquote>
                  <div className="x">
                    <span className="n">{evidence.issuer}</span>
                    {" · "}
                    {evidence.independent ? "Independent" : "Self-declared"}
                    {" · "}supports {evidence.supports}
                    {evidence.cached && " · Cached source"}
                    {" · "}
                    <a href={evidence.url} target="_blank" rel="noreferrer" title={evidence.url}>
                      Source
                    </a>
                    {" · "}
                    {formatUtc(evidence.retrievedAt)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {claim.checkedUrls.length > 0 && (
        <details className="sources">
          <summary>Sources checked ({claim.checkedUrls.length})</summary>
          <ul>
            {claim.checkedUrls.map((checked) => (
              <li key={checked.url}>
                <span className={`tag tag--${checked.status}`}>{checked.status}</span>
                <a href={checked.url} target="_blank" rel="noreferrer" title={checked.url}>
                  {truncateUrl(checked.url.replace(/^https?:\/\//, ""))}
                </a>
                {checked.reason && <span className="x"> — {checked.reason}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {(claim.rewrite || claim.evidenceRequest) && (
        <div className="act">
          {claim.rewrite && (
            <>
              <span className="h">Suggested rewrite</span>
              <p className="q">{claim.rewrite}</p>
            </>
          )}
          <div className="act__buttons">
            {claim.rewrite && (
              <button type="button" className="cta cta--quiet" onClick={copyRewrite}>
                {copied ? "Copied" : "Copy suggested rewrite"}
              </button>
            )}
            {claim.evidenceRequest && (
              <button type="button" className="cta" onClick={() => setShowRequest(true)}>
                Request missing evidence
              </button>
            )}
          </div>
          {showRequest && claim.evidenceRequest && (
            <EvidenceRequestModal text={claim.evidenceRequest} onClose={() => setShowRequest(false)} />
          )}
        </div>
      )}
    </article>
  );
}
