import { useAgent } from "agents/react";
import { useEffect, useRef, useState } from "react";
import type { Investigation } from "../../shared/types";
import { RunPanel } from "./RunPanel";

// The Coordinator's exact callable RPC method name is unconfirmed: the backend
// (src/agents/coordinator.ts) had not been written yet when this was built.
// This builder's task instructions specify `agent.call("start", [{ url, mode }])`;
// src/shared/types.ts instead documents "Input to Coordinator.investigate()".
// Kept as one constant so it is a one-line fix once the real method is known.
const INVESTIGATE_METHOD = "start";

/** Connects to the real Coordinator Agent DO via `agents/react`'s useAgent. */
export function LiveConnection({
  id,
  url,
  onState,
  onFailed,
}: {
  id: string;
  url: string;
  onState: (investigation: Investigation) => void;
  /** Called when the initial call rejects or the socket closes for good, so the
   * caller (App) can re-enable its form instead of staying stuck on "running". */
  onFailed?: (message: string) => void;
}) {
  const [investigation, setInvestigation] = useState<Investigation | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const calledRef = useRef(false);

  const agent = useAgent<Investigation>({
    agent: "coordinator",
    name: id,
    onStateUpdate: (state) => {
      setInvestigation(state);
      onState(state);
    },
  });

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;
    agent.ready
      .then(() => agent.call(INVESTIGATE_METHOD, [{ url, mode: "live" }]))
      .catch((err: unknown) => {
        setCallError(err instanceof Error ? err.message : "Failed to start the investigation.");
      });
    // Runs once per mounted instance (this component is remounted with a fresh
    // `key` for every new investigation id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Retry must not depend on the mount-only effect above (it never re-runs, since
  // its deps are `[]`). Reconnect the socket first when it's permanently closed
  // (a terminal close won't auto-retry, and `agent.ready` would hang forever
  // without this), then await `ready` and call `start` directly - the server's
  // start() is idempotent, so re-issuing it is safe even if the first call
  // actually landed.
  const handleRetry = () => {
    setCallError(null);
    if (agent.connectionError) {
      agent.reconnect();
    }
    agent.ready
      .then(() => agent.call(INVESTIGATE_METHOD, [{ url, mode: "live" }]))
      .catch((err: unknown) => {
        setCallError(err instanceof Error ? err.message : "Failed to start the investigation.");
      });
  };

  const connectionMessage = agent.connectionError
    ? `Lost connection to the investigation (${agent.connectionError.message || agent.connectionError.reason || "connection closed"}). It may still be running on the server.`
    : callError;

  useEffect(() => {
    if (connectionMessage) {
      onFailed?.(connectionMessage);
    }
    // Re-report whenever the message text changes (new failure, or the same
    // failure surfacing again after a failed retry); onFailed is expected to be
    // a stable callback from the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionMessage]);

  return (
    <RunPanel
      investigation={investigation}
      connectionError={connectionMessage}
      onRetryConnection={connectionMessage ? handleRetry : undefined}
    />
  );
}
