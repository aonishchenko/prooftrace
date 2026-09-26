import type { Investigation } from "../../shared/types";
import { LiveConnection } from "./LiveConnection";
import { MockConnection } from "./MockConnection";

interface InvestigationViewProps {
  id: string;
  url: string;
  mock: boolean;
  onState: (investigation: Investigation) => void;
  /** Called when the connection can't start or drops for good (no state update follows). */
  onFailed?: (message: string) => void;
}

/**
 * Picks the live Coordinator connection or the local mock runner. The choice
 * is made here (not inside a single component) so each branch calls its own
 * hooks unconditionally.
 */
export function InvestigationView({ id, url, mock, onState, onFailed }: InvestigationViewProps) {
  return mock ? (
    <MockConnection id={id} url={url} onState={onState} />
  ) : (
    <LiveConnection id={id} url={url} onState={onState} onFailed={onFailed} />
  );
}
