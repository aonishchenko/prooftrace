// Worker entry point: Agents SDK routing + the small REST API the page and scripts/e2e.mjs use.
// See docs/ARCHITECTURE.md §3/§5.
//
// The live page talks to the Coordinator directly over WebSocket via `agents/react`'s `useAgent`
// (routed below through `routeAgentRequest`, matching `/agents/coordinator/<id>`). The REST endpoints
// below exist for polling clients (the e2e script) and for the demo/history chips, which don't need a
// live socket. `wrangler.jsonc`'s `assets.run_worker_first` only forwards `/agents/*` and `/api/*` to
// this Worker — every other path is served directly from the built assets, so the fallback 404 below is
// a defensive backstop, not the normal path for the app shell or its static files.

import { getAgentByName, routeAgentRequest } from "agents";

import { Coordinator } from "./agents/coordinator";
import { CertificationSpecialist } from "./agents/certification";
import { QuantitativeSpecialist } from "./agents/quantitative";
import { SourcingSpecialist } from "./agents/sourcing";
import { validatePublicUrl } from "./agents/url-safety";

export { CertificationSpecialist, Coordinator, QuantitativeSpecialist, SourcingSpecialist };

const NOINDEX_HEADERS = { "X-Robots-Tag": "noindex" } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...NOINDEX_HEADERS },
  });
}

function jsonError(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

async function coordinatorStub(env: Env, id: string) {
  return getAgentByName<Env, Coordinator>(env.Coordinator as unknown as DurableObjectNamespace<Coordinator>, id);
}

interface DemoCaseRow {
  id: string;
  title: string;
  input_url: string;
}

interface HistoryRow {
  id: string;
  input_url: string;
  status: string;
  started_at: string;
  finished_at: string | null;
}

async function handleDemo(env: Env): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, title, input_url FROM demo_cases ORDER BY sort",
    ).all<DemoCaseRow>();
    return jsonResponse(results);
  } catch (err) {
    console.error("GET /api/demo failed", err);
    return jsonError("Could not load demo cases.", 500);
  }
}

async function handleHistory(env: Env): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, input_url, status, started_at, finished_at FROM investigations ORDER BY started_at DESC LIMIT 20",
    ).all<HistoryRow>();
    return jsonResponse(results);
  } catch (err) {
    console.error("GET /api/history failed", err);
    return jsonError("Could not load investigation history.", 500);
  }
}

async function handleInvestigate(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be JSON.", 400);
  }
  const url = typeof body === "object" && body !== null ? (body as Record<string, unknown>).url : undefined;
  if (typeof url !== "string" || url.trim() === "") {
    return jsonError("A 'url' field is required.", 400);
  }

  const valid = validatePublicUrl(url);
  if (!valid.ok) {
    return jsonError(valid.reason, 400);
  }

  const id = crypto.randomUUID();
  try {
    const stub = await coordinatorStub(env, id);
    await stub.start({ url, mode: "live" });
  } catch (err) {
    console.error("POST /api/investigate failed to start", id, err);
    return jsonError("Could not start the investigation. Please try again.", 502);
  }
  return jsonResponse({ id }, 202);
}

async function handleGetInvestigation(env: Env, id: string): Promise<Response> {
  try {
    const stub = await coordinatorStub(env, id);
    const snapshot = await stub.snapshot();
    if (snapshot.status === "idle") {
      return jsonError("Investigation not found.", 404);
    }
    return jsonResponse(snapshot);
  } catch (err) {
    console.error("GET /api/investigations/:id failed", id, err);
    return jsonError("Could not load the investigation.", 500);
  }
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = request.method.toUpperCase();

  if (pathname === "/api/demo" && method === "GET") {
    return handleDemo(env);
  }
  if (pathname === "/api/history" && method === "GET") {
    return handleHistory(env);
  }
  if (pathname === "/api/investigate" && method === "POST") {
    return handleInvestigate(request, env);
  }
  const investigationMatch = /^\/api\/investigations\/([^/]+)$/.exec(pathname);
  if (investigationMatch && method === "GET") {
    return handleGetInvestigation(env, decodeURIComponent(investigationMatch[1]));
  }

  return jsonError("Not found.", 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    // Non-API, non-agent paths are served from static assets before reaching the Worker
    // (see `assets.run_worker_first` in wrangler.jsonc). Reaching here means neither router
    // claimed the request.
    return jsonError("Not found.", 404);
  },
} satisfies ExportedHandler<Env>;
