// Small formatting helpers shared by the report and log components.

/** "+x.xs" elapsed display for a Step.at (ms since run start). */
export function elapsed(atMs: number): string {
  return `+${(atMs / 1000).toFixed(1)}s`;
}

/** Renders an ISO timestamp as an explicit UTC date/time, e.g. "26 Sep 2026, 14:03 UTC". */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.getUTCDate().toString().padStart(2, "0");
  const month = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  const year = d.getUTCFullYear();
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mm = d.getUTCMinutes().toString().padStart(2, "0");
  return `${day} ${month} ${year}, ${hh}:${mm} UTC`;
}

/** Earliest–latest range across a set of ISO timestamps, formatted as UTC. */
export function formatUtcRange(isoTimestamps: string[]): string | null {
  const valid = isoTimestamps
    .map((s) => new Date(s))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (valid.length === 0) return null;
  const earliest = formatUtc(valid[0].toISOString());
  const latest = formatUtc(valid[valid.length - 1].toISOString());
  return earliest === latest ? earliest : `${earliest} – ${latest}`;
}

/** Truncates a long URL for display while keeping it recognisable. */
export function truncateUrl(url: string, max = 60): string {
  if (url.length <= max) return url;
  return `${url.slice(0, max - 1)}…`;
}

/** Elapsed seconds counter for the status bar, given a run start Date.now() snapshot. */
export function secondsSince(startMs: number, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - startMs) / 1000));
}
