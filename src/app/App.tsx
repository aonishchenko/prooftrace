import { useCallback, useState } from "react";
import type { Investigation } from "../shared/types";
import { DemoChips } from "./components/DemoChips";
import { Header } from "./components/Header";
import { InvestigateForm } from "./components/InvestigateForm";
import { InvestigationView } from "./components/InvestigationView";

function isMockMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("mock") === "1";
}

interface RunRequest {
  id: string;
  url: string;
}

export default function App() {
  const [url, setUrl] = useState("");
  const [run, setRun] = useState<RunRequest | null>(null);
  const [status, setStatus] = useState<Investigation["status"] | null>(null);
  const [mockMode] = useState(isMockMode);

  const handleSubmit = useCallback((submittedUrl: string) => {
    const id = crypto.randomUUID();
    setRun({ id, url: submittedUrl });
    setStatus("running");
  }, []);

  const handleState = useCallback((investigation: Investigation) => {
    setStatus(investigation.status);
  }, []);

  const running = status === "running";

  return (
    <main className="app-shell">
      <Header />
      <InvestigateForm url={url} onUrlChange={setUrl} onSubmit={handleSubmit} disabled={running} />
      <DemoChips onPick={setUrl} />
      {run && <InvestigationView key={run.id} id={run.id} url={run.url} mock={mockMode} onState={handleState} />}
    </main>
  );
}
