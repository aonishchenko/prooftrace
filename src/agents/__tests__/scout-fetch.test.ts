import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvidenceScout } from "../evidence-scout";

/**
 * fetchPage is the only place evidence-scout.ts touches the network, so these tests fake both
 * sides of it: `fetch` itself (via vi.stubGlobal) and the two Cloudflare bindings it calls
 * through `env` (D1's `DB` and the headless-browser `BROWSER.quickAction`). No real network or
 * Cloudflare binding is ever touched.
 */
function makeEnv(quickActionImpl: (action: string, options: unknown) => Promise<Response>) {
  const quickAction = vi.fn(quickActionImpl);
  // A single chainable stub covers every `env.DB.prepare(...).bind(...).first()/.run()/.all()`
  // call site in evidence-scout.ts: no cache hits, every write silently "succeeds".
  const dbChain = {
    bind: () => dbChain,
    first: async () => null,
    run: async () => ({}) as unknown,
    all: async () => ({ results: [] }) as unknown,
  };
  const env = {
    DB: { prepare: () => dbChain },
    BROWSER: { quickAction },
  } as unknown as Env;
  return { env, quickAction };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchPage SSRF: redirect to a private address", () => {
  it("blocks a redirect to a loopback address and never falls back to the browser", async () => {
    const { env, quickAction } = makeEnv(async () => {
      throw new Error("the browser must never be invoked for an SSRF-rejected redirect");
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://example.com/redirect-me") {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const scout = createEvidenceScout(env, { investigationId: "t1", onAttempt: () => {} });
    const result = await scout.fetchPage("https://example.com/redirect-me", { allowCache: false });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // FetchOutcome's failure status is only ever "blocked" | "timeout" | "skipped" (never a bespoke
      // "ssrf" value) — the redirect-validation failure surfaces as "blocked", same as any other
      // rejected fetch, but critically without ever reaching the browser fallback below.
      expect(result.status).toBe("blocked");
      expect(result.reason).toContain("Redirect target rejected");
      expect(result.reason).toContain("Loopback addresses are not public");
    }
    expect(quickAction).not.toHaveBeenCalled();
  });
});

describe("fetchPage: drip-fed / stalled response body", () => {
  it("times out within the given budget instead of hanging forever", async () => {
    const { env, quickAction } = makeEnv(async () => {
      throw new Error("the browser must never be invoked when the body-read itself times out");
    });
    const fetchMock = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // One chunk arrives immediately, then the connection stalls forever — the exact shape
          // that a timer cleared "as soon as headers arrive" (the pre-fix bug) would never catch.
          controller.enqueue(new TextEncoder().encode("<html><body>partial and then nothing more"));
          const onAbort = () => controller.error(new DOMException("The operation was aborted.", "AbortError"));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scout = createEvidenceScout(env, { investigationId: "t2", onAttempt: () => {} });
    const startedAt = Date.now();
    const result = await scout.fetchPage("https://example.com/slow", { allowCache: false, timeoutMs: 60 });
    const elapsedMs = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("timeout");
    // The whole call must resolve close to the 60ms budget, not hang until a test-runner kill.
    expect(elapsedMs).toBeLessThan(1000);
    expect(quickAction).not.toHaveBeenCalled();
  });
});

describe("fetchPage: HTTP status handling", () => {
  it("a plain 404 is blocked immediately without ever trying the browser", async () => {
    const { env, quickAction } = makeEnv(async () => {
      throw new Error("the browser must never be invoked for a plain 404");
    });
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("<html><body>Not Found</body></html>", 404)));

    const scout = createEvidenceScout(env, { investigationId: "t3", onAttempt: () => {} });
    const result = await scout.fetchPage("https://example.com/missing", { allowCache: false });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("The page returned HTTP 404.");
    }
    expect(quickAction).not.toHaveBeenCalled();
  });

  it("a 403 falls back to the browser and returns its rendered page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("<html><body>Access Denied</body></html>", 403)));

    const markdownText = "# Real Page\n\n" + "Real rendered content from the browser. ".repeat(20);
    const { env, quickAction } = makeEnv(async (action) => {
      if (action === "markdown") {
        return jsonResponse({ success: true, result: markdownText, meta: { status: 200, title: "Real Page" } });
      }
      if (action === "links") {
        return jsonResponse({ success: true, result: [], meta: { status: 200, title: "Real Page" } });
      }
      throw new Error(`unexpected quickAction "${action}"`);
    });

    const scout = createEvidenceScout(env, { investigationId: "t4", onAttempt: () => {} });
    const result = await scout.fetchPage("https://example.com/blocked", { allowCache: false });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.method).toBe("browser");
      expect(result.page.text).toContain("Real rendered content from the browser.");
    }
    expect(quickAction).toHaveBeenCalled();
  });
});

describe("fetchPage: browser fallback failure after a usable short fetch (defect #7)", () => {
  it("returns the fetched page (method 'fetch') rather than blocking, when its text is non-empty", async () => {
    const shortHtml = "<html><body><p>Short.</p></body></html>"; // well under the 400-char thin-content bar
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(shortHtml, 200)));

    const { env, quickAction } = makeEnv(async (action) => {
      if (action === "markdown") throw new Error("browser rendering backend exploded: raw stack trace at pool.ts:42");
      return jsonResponse({ success: true, result: [] });
    });

    const scout = createEvidenceScout(env, { investigationId: "t5", onAttempt: () => {} });
    const result = await scout.fetchPage("https://example.com/thin", { allowCache: false });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.method).toBe("fetch");
      expect(result.page.text).toContain("Short.");
    }
    expect(quickAction).toHaveBeenCalled(); // the browser fallback was attempted, and failed
  });
});

describe("fetchPage: provider error text never reaches the returned reason (defect #6)", () => {
  it("maps a raw browser-provider error to a fixed, user-readable reason and only logs the raw text", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A 200 page with literally no extractable text (e.g. an empty shell): the fetch path has
    // nothing usable to fall back to, so the final reason comes straight from the browser failure.
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("<html><head></head><body></body></html>", 200)));

    const rawProviderMessage = "INTERNAL: renderer pool exhausted at pool.ts:88, connId=ffa213";
    const { env, quickAction } = makeEnv(async (action) => {
      if (action === "markdown") {
        return jsonResponse({ success: false, errors: [{ message: rawProviderMessage }] }, 429);
      }
      return jsonResponse({ success: true, result: [] });
    });

    const scout = createEvidenceScout(env, { investigationId: "t6", onAttempt: () => {} });
    const result = await scout.fetchPage("https://example.com/empty-shell", { allowCache: false });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("The rendering service is busy; try again later.");
      expect(result.reason).not.toContain("INTERNAL");
      expect(result.reason).not.toContain("pool.ts");
      expect(result.reason).not.toContain(rawProviderMessage);
    }
    expect(quickAction).toHaveBeenCalled();

    // The raw provider detail must still be diagnosable in logs, just never in the returned reason.
    const loggedRawSomewhere = consoleErrorSpy.mock.calls.some((args) =>
      args.some((arg) => {
        try {
          return typeof arg === "string" ? arg.includes(rawProviderMessage) : JSON.stringify(arg).includes(rawProviderMessage);
        } catch {
          return false;
        }
      }),
    );
    expect(loggedRawSomewhere).toBe(true);
  });
});
