import { useCallback, useEffect, useState } from "react";
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

/** A run that stays "running" this long without settling is treated as stalled. */
const STALL_THRESHOLD_MS = 150_000;
/** How often to re-check the stall threshold while a run is in flight. */
const STALL_CHECK_INTERVAL_MS = 5_000;

export default function App() {
  const [url, setUrl] = useState("");
  const [run, setRun] = useState<RunRequest | null>(null);
  const [status, setStatus] = useState<Investigation["status"] | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [submittedAtMs, setSubmittedAtMs] = useState<number | null>(null);
  const [stalled, setStalled] = useState(false);
  const [mockMode] = useState(isMockMode);

  const startNewRun = useCallback((targetUrl: string) => {
    const id = crypto.randomUUID();
    setRun({ id, url: targetUrl });
    setStatus("running");
    setStartedAt(null);
    setSubmittedAtMs(Date.now());
    setStalled(false);
  }, []);

  const handleSubmit = useCallback(
    (submittedUrl: string) => {
      startNewRun(submittedUrl);
    },
    [startNewRun],
  );

  const handleState = useCallback((investigation: Investigation) => {
    setStatus(investigation.status);
    setStartedAt(investigation.startedAt ?? null);
    if (investigation.status !== "running") {
      setStalled(false);
    }
  }, []);

  // A failed `start()` call or a permanently closed socket (see LiveConnection's
  // callError/connectionError paths) never produces a state update, so without
  // this the form would stay disabled forever with `status` stuck at "running".
  const handleFailed = useCallback(() => {
    setStatus("error");
    setStalled(false);
  }, []);

  // Stall watchdog: a run stuck at "running" for too long (server crash mid-run,
  // dropped message, etc. with no terminal state and no connection error) must
  // never spin forever — surface it and let the user bail out.
  useEffect(() => {
    if (status !== "running") return;
    const referenceMs = startedAt ? new Date(startedAt).getTime() : submittedAtMs ?? Date.now();
    const check = () => {
      if (Date.now() - referenceMs > STALL_THRESHOLD_MS) {
        setStalled(true);
      }
    };
    check();
    const timer = setInterval(check, STALL_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [status, startedAt, submittedAtMs]);

  const handleStartNewRun = useCallback(() => {
    if (!run) return;
    startNewRun(run.url);
  }, [run, startNewRun]);

  const running = status === "running" && !stalled;

  return (
    <div className="ds">
      <Header />
      <main className="pad page">
        <section className="top" aria-label="Check a page">
          <div>
            <h1 className="serif top__title">Is this claim backed by evidence?</h1>
            <p className="lead">Checks a sustainability claim against public evidence and shows its work.</p>
          </div>
          <div className="inputs">
            <InvestigateForm url={url} onUrlChange={setUrl} onSubmit={handleSubmit} disabled={running} />
            <DemoChips onPick={setUrl} selectedUrl={url} />
          </div>
        </section>
        {stalled && (
          <div className="stall-banner" role="alert">
            <p>This run seems stalled. It has been running for over two minutes with no result.</p>
            <button type="button" className="textlink" onClick={handleStartNewRun}>
              Start a new run
            </button>
          </div>
        )}
        {run ? (
          <InvestigationView
            key={run.id}
            id={run.id}
            url={run.url}
            mock={mockMode}
            onState={handleState}
            onFailed={handleFailed}
          />
        ) : (
          <div className="work">
            <section aria-label="Agent steps">
              <p className="lbl">Agent log</p>
              <p className="wait">Paste a product or brand page address, then choose “Investigate”.</p>
            </section>
            <section className="result">
              <p className="wait">Ready when you are. The agents open the page, find its claims and look for the proof.</p>
            </section>
          </div>
        )}
      </main>
      <footer className="foot">
        A review of public evidence on the date checked. Not a judgement of intent. Not legal advice.
      </footer>
    </div>
  );
}
