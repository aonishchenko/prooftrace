import { useEffect, useState } from "react";
import type { Investigation } from "../../shared/types";
import { runMockInvestigation } from "../mock";
import { RunPanel } from "./RunPanel";

/** Dev-only stand-in for LiveConnection, enabled by `?mock=1`. */
export function MockConnection({
  id,
  url,
  onState,
}: {
  id: string;
  url: string;
  onState: (investigation: Investigation) => void;
}) {
  const [investigation, setInvestigation] = useState<Investigation | null>(null);

  useEffect(() => {
    const stop = runMockInvestigation(id, url, (state) => {
      setInvestigation(state);
      onState(state);
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return <RunPanel investigation={investigation} />;
}
