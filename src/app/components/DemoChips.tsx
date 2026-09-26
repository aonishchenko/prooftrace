import { useEffect, useState } from "react";

interface DemoCase {
  id: string;
  title: string;
  input_url: string;
}

function isDemoCaseArray(value: unknown): value is DemoCase[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).title === "string" &&
        typeof (item as Record<string, unknown>).input_url === "string"
    )
  );
}

/** "Try:" chips from GET /api/demo. Clicking one only prefills the input. */
export function DemoChips({ onPick, selectedUrl }: { onPick: (url: string) => void; selectedUrl?: string }) {
  const [cases, setCases] = useState<DemoCase[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/demo", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: unknown) => {
        if (isDemoCaseArray(data)) setCases(data);
      })
      .catch(() => {
        // No demo endpoint yet, or it failed: fail quietly, chips are optional.
      });
    return () => controller.abort();
  }, []);

  if (cases.length === 0) return null;

  return (
    <div className="exs">
      <span className="lbl">Examples</span>
      {cases.map((demoCase) => {
        const [brand, ...rest] = demoCase.title.split(/\s[—–-]\s/);
        return (
          <button
            key={demoCase.id}
            type="button"
            className="ex"
            aria-pressed={selectedUrl === demoCase.input_url}
            onClick={() => onPick(demoCase.input_url)}
          >
            <b>{brand}</b>
            {rest.length > 0 && <span>{rest.join(" — ")}</span>}
          </button>
        );
      })}
    </div>
  );
}
