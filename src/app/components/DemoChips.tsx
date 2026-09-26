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
export function DemoChips({ onPick }: { onPick: (url: string) => void }) {
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
    <div className="demo-chips">
      <span className="demo-chips__label">Try:</span>
      {cases.map((demoCase) => (
        <button
          key={demoCase.id}
          type="button"
          className="chip chip--demo"
          onClick={() => onPick(demoCase.input_url)}
        >
          {demoCase.title}
        </button>
      ))}
    </div>
  );
}
