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
}: {
  id: string;
  url: string;
  onState: (investigation: Investigation) => void;
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

  const handleRetry = () => {
    setCallError(null);
    calledRef.current = false;
    agent.reconnect();
  };

  const connectionMessage = agent.connectionError
    ? `Lost connection to the investigation (${agent.connectionError.message || agent.connectionError.reason || "connection closed"}). It may still be running on the server.`
    : callError;

  return (
    <RunPanel
      investigation={investigation}
      connectionError={connectionMessage}
      onRetryConnection={connectionMessage ? handleRetry : undefined}
    />
  );
}
