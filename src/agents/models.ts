// Hosted Workers AI calls and schemas. See docs/ARCHITECTURE.md §2 and §5.
//
// Reasoning parameter: `reasoning_effort` (string | null). Verified via the Workers AI model docs
// (2026-09-26) for both configured models:
//   - @cf/moonshotai/kimi-k2.6            enum: "high" (default) | "none"
//   - @cf/deepseek-ai/deepseek-v4-pro-0813 enum: "max" | "high" | "low" | "none"
//   - @cf/deepseek-ai/deepseek-v4-flash-0731 enum: "max" | "high" | "low" | "none"
// Kimi does NOT support "low": a measured live run showed Kimi K2.6 at reasoning "high" taking 117s
// for a single specialist call, which alone exceeded the whole-run budget. Any caller may still ask
// for reasoning "low" (e.g. a role default or a per-call override); `callJson` maps "low" -> "none"
// for any model id containing "kimi" at the point it actually calls that model (primary or fallback),
// so the mapping is correct even when a Kimi model is only reached as a fallback.
import { z } from "zod";

export type ModelRole = "extractor" | "certification" | "quantitative" | "sourcing" | "action";

/** Thrown when no model call/parse attempt for a role succeeds. `userMessage` is safe to show in UI. */
export class ModelError extends Error {
  userMessage: string;

  constructor(userMessage: string, cause?: unknown) {
    super(userMessage);
    this.name = "ModelError";
    this.userMessage = userMessage;
    if (cause !== undefined) {
      // Keep provider detail out of the thrown message; callers only ever see userMessage.
      this.cause = cause;
    }
  }
}

interface AgentConfigRow {
  role: ModelRole;
  model: string;
  fallback_model: string;
  reasoning: string | null;
  max_tokens: number;
  timeout_ms: number;
}

const ROLES: ModelRole[] = ["extractor", "certification", "quantitative", "sourcing", "action"];

// Hard-coded defaults, identical to seed/0001_seed.sql, used when D1 is unavailable or a role is missing.
const DEFAULTS: Record<ModelRole, AgentConfigRow> = {
  extractor: {
    role: "extractor",
    model: "@cf/moonshotai/kimi-k2.6",
    fallback_model: "@cf/zai-org/glm-5.3",
    reasoning: "none",
    max_tokens: 3000,
    timeout_ms: 45000,
  },
  certification: {
    role: "certification",
    model: "@cf/deepseek-ai/deepseek-v4-pro-0813",
    fallback_model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
    reasoning: "low",
    max_tokens: 3000,
    timeout_ms: 45000,
  },
  quantitative: {
    role: "quantitative",
    model: "@cf/deepseek-ai/deepseek-v4-pro-0813",
    fallback_model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
    reasoning: "low",
    max_tokens: 3000,
    timeout_ms: 45000,
  },
  sourcing: {
    role: "sourcing",
    // Primary is a fast Flash model, not Kimi: a live run measured Kimi K2.6 at reasoning "high"
    // taking 117s for one sourcing plan() call. Kimi stays available as the fallback only.
    model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
    fallback_model: "@cf/moonshotai/kimi-k2.6",
    reasoning: "low",
    max_tokens: 3000,
    timeout_ms: 60000,
  },
  action: {
    role: "action",
    model: "@cf/moonshotai/kimi-k2.6",
    fallback_model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
    reasoning: "none",
    max_tokens: 1500,
    timeout_ms: 45000,
  },
};

// Per-isolate cache, 60s TTL. A fresh isolate always starts with a cold cache and reloads from D1.
let configCache: Map<ModelRole, AgentConfigRow> | null = null;
let configCacheAt = 0;
const CONFIG_TTL_MS = 60_000;

async function loadConfig(env: Env): Promise<Map<ModelRole, AgentConfigRow>> {
  const now = Date.now();
  if (configCache && now - configCacheAt < CONFIG_TTL_MS) return configCache;

  const map = new Map<ModelRole, AgentConfigRow>();
  try {
    const { results } = await env.DB.prepare(
      "SELECT role, model, fallback_model, reasoning, max_tokens, timeout_ms FROM agent_config",
    ).all<AgentConfigRow>();
    for (const row of results ?? []) {
      if (ROLES.includes(row.role)) map.set(row.role, row);
    }
  } catch (err) {
    console.error("[models] failed to load agent_config from D1, using hard-coded defaults", err);
  }
  for (const role of ROLES) {
    if (!map.has(role)) map.set(role, DEFAULTS[role]);
  }
  configCache = map;
  configCacheAt = now;
  return map;
}

async function getConfig(env: Env, role: ModelRole): Promise<AgentConfigRow> {
  const map = await loadConfig(env);
  return map.get(role) ?? DEFAULTS[role];
}

/** The model id actually configured for a role (for trace labels). */
export async function modelFor(env: Env, role: ModelRole): Promise<string> {
  return (await getConfig(env, role)).model;
}

function stripCodeFences(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Remove `<think>...</think>` reasoning blocks some hosted models emit before their JSON reply. */
function stripThinkBlocks(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** A model's reply mapped to its text content and (when reported) finish reason. */
interface RawModelReply {
  content: string | null;
  finishReason?: string;
}

/** Extract the model's textual reply from either observed Workers AI response shape. */
function extractReply(result: unknown): RawModelReply {
  if (result && typeof result === "object") {
    const asChoices = result as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    };
    const choice = asChoices.choices?.[0];
    if (choice) {
      const content = typeof choice.message?.content === "string" ? choice.message.content : null;
      const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
      return { content, finishReason };
    }

    const asResponse = result as { response?: unknown };
    if (typeof asResponse.response === "string") return { content: asResponse.response };
  }
  throw new Error(`Unrecognized Workers AI response shape: ${JSON.stringify(result).slice(0, 500)}`);
}

/** "low" is not a valid reasoning_effort value for Kimi models (only "none"|"high" are). */
function mapReasoningForModel(model: string, reasoning: string | null): string | null {
  if (reasoning === "low" && model.includes("kimi")) return "none";
  return reasoning;
}

/** Rejects with the timeout error and, when a controller is given, aborts the underlying call so a
 * timed-out Workers AI request does not keep running after we have moved on to the fallback model. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, controller?: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function callModelOnce(
  env: Env,
  model: string,
  system: string,
  user: string,
  schemaName: string,
  jsonSchema: unknown,
  maxTokens: number,
  timeoutMs: number,
  reasoningEffort: string | null,
): Promise<RawModelReply> {
  const input: Record<string, unknown> = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: { name: schemaName, schema: jsonSchema } },
    max_tokens: maxTokens,
  };
  if (reasoningEffort) input.reasoning_effort = reasoningEffort;

  // `AiOptions.signal` (worker-configuration.d.ts) lets us cancel an in-flight Workers AI call the
  // moment its timeout fires, instead of leaving a slow reasoning call running in the background
  // after we've already moved on to a retry or fallback model.
  const controller = new AbortController();
  const gatewayOptions: Record<string, unknown> = { signal: controller.signal };
  if (env.AI_GATEWAY_ID) gatewayOptions.gateway = { id: env.AI_GATEWAY_ID };

  // Model ids are not all present in the generated Workers AI union; call through a loosely typed handle.
  const ai = env.AI as unknown as {
    run: (model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
  };

  const result = await withTimeout(
    ai.run(model, input, gatewayOptions),
    timeoutMs,
    `Workers AI call (${model})`,
    controller,
  );
  return extractReply(result);
}

/** Parse a model's text reply into `T`, or return the failure reason for a retry. */
function tryParse<T>(content: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  const candidate = stripCodeFences(stripThinkBlocks(content));
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidate);
  } catch {
    // Fall back to the outermost {...} span in case the model added stray prose around the JSON.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return { ok: false, error: "Response was not valid JSON." };
    }
    try {
      parsedJson = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return { ok: false, error: "Response was not valid JSON." };
    }
  }

  const result = schema.safeParse(parsedJson);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: result.error.message };
}

type AttemptFailureKind = "timeout" | "length" | "schema" | "error";

type AttemptResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: AttemptFailureKind; message: string; rawSnippet?: string };

/** Run one model call end to end: call, then (unless it timed out or came back truncated/empty)
 * parse+validate. Never throws; every failure mode is reported as a discriminated result so the
 * caller can decide whether a same-model retry makes sense. */
async function runAttempt<T>(
  env: Env,
  model: string,
  system: string,
  user: string,
  schemaName: string,
  jsonSchema: unknown,
  maxTokens: number,
  timeoutMs: number,
  reasoning: string | null,
  schema: z.ZodType<T>,
): Promise<AttemptResult<T>> {
  const effectiveReasoning = mapReasoningForModel(model, reasoning);

  let reply: RawModelReply;
  try {
    reply = await callModelOnce(env, model, system, user, schemaName, jsonSchema, maxTokens, timeoutMs, effectiveReasoning);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind: AttemptFailureKind = /timed out/i.test(message) ? "timeout" : "error";
    return { ok: false, kind, message };
  }

  // Reasoning models can come back with a `finish_reason: "length"` (the reply was truncated before
  // completing) or with no content at all; neither is a schema problem a same-model retry would fix.
  if (!reply.content || !reply.content.trim() || reply.finishReason === "length") {
    return { ok: false, kind: "length", message: `Model reply was truncated or empty (finish_reason=${reply.finishReason ?? "n/a"}).` };
  }

  const parsed = tryParse(reply.content, schema);
  if (parsed.ok) return { ok: true, value: parsed.value };
  return { ok: false, kind: "schema", message: parsed.error, rawSnippet: reply.content.slice(0, 500) };
}

/** Minimum time an attempt needs to be worth starting at all. Below this, a call is very unlikely to
 * finish and would just burn the remaining budget for no result. */
const MIN_ATTEMPT_MS = 8000;
/** Reserve this much of the deadline for the caller (Coordinator) to process the result afterwards. */
const DEADLINE_BUFFER_MS = 3000;

function computeAttemptTimeout(configTimeoutMs: number, overrideTimeoutMs: number | undefined, deadlineMs: number | undefined): number {
  let timeout = configTimeoutMs;
  if (overrideTimeoutMs !== undefined) timeout = Math.min(timeout, overrideTimeoutMs);
  if (deadlineMs !== undefined) timeout = Math.min(timeout, deadlineMs - Date.now() - DEADLINE_BUFFER_MS);
  return timeout;
}

/** Per-call overrides for one `callJson` invocation, on top of the role's D1/default config. */
export interface CallOverrides {
  reasoning?: "none" | "low" | "high";
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Call the configured model for `role`, parse+validate the JSON reply against `schema`.
 *
 * `deadlineMs` (absolute epoch ms, optional) bounds every attempt this call makes, including its
 * retry and fallback: each attempt's timeout is `min(config timeout, overrides.timeoutMs,
 * deadlineMs - now - 3000)`. When that computed budget is under 8s, the attempt is not started at
 * all and this throws `ModelError("Not enough time left for the <role> model.")` instead.
 *
 * Retry/fallback policy:
 * - A TIMEOUT skips the same-model retry and goes straight to the fallback model (if time remains).
 * - A truncated/empty reply (`finish_reason === "length"` or no content) skips the same-model retry
 *   too, and falls back with `reasoning: "none"` and 1.5x `max_tokens` (a reasoning model that ran
 *   out of budget mid-thought needs less reasoning and more room, not another identical attempt).
 * - Only a schema/parse failure gets a same-model retry (with the validation error appended), before
 *   falling back to the fallback model with the original prompt and settings.
 *
 * Raw provider output is never included in the thrown message (logged instead).
 */
export async function callJson<T>(
  env: Env,
  role: ModelRole,
  args: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaName: string;
    /** Absolute epoch-ms deadline for this whole call (all attempts). */
    deadlineMs?: number;
    /** Per-call overrides on top of the role's configured model/reasoning/tokens/timeout. */
    overrides?: CallOverrides;
  },
): Promise<T> {
  const { system, user, schema, schemaName, deadlineMs, overrides } = args;
  const config = await getConfig(env, role);
  const jsonSchema = z.toJSONSchema(schema);

  const maxTokens = overrides?.maxTokens ?? config.max_tokens;
  const reasoning: string | null = overrides?.reasoning ?? config.reasoning;

  const ensureTime = (): number => {
    const t = computeAttemptTimeout(config.timeout_ms, overrides?.timeoutMs, deadlineMs);
    if (t < MIN_ATTEMPT_MS) {
      throw new ModelError(`Not enough time left for the ${role} model.`);
    }
    return t;
  };

  let lastError = "";
  let lastRawSnippet = "";

  // Attempt 1: primary model, original prompt.
  const t1 = ensureTime();
  const r1 = await runAttempt(env, config.model, system, user, schemaName, jsonSchema, maxTokens, t1, reasoning, schema);
  if (r1.ok) return r1.value;
  lastError = r1.message;
  lastRawSnippet = r1.rawSnippet ?? "";
  console.error(`[models] ${role} attempt 1 (${config.model}) failed [${r1.kind}]: ${r1.message}`);

  let fallbackKind: AttemptFailureKind = r1.kind;

  // Attempt 2: same model, error appended — ONLY for a schema/parse failure. A timeout or a
  // truncated/empty reply goes straight to the fallback model instead.
  if (r1.kind === "schema") {
    const t2 = ensureTime();
    const retryUser = `${user}\n\nYour previous reply could not be used: ${lastError}\nReturn ONLY valid JSON matching the required schema.`;
    const r2 = await runAttempt(env, config.model, system, retryUser, schemaName, jsonSchema, maxTokens, t2, reasoning, schema);
    if (r2.ok) return r2.value;
    lastError = r2.message;
    lastRawSnippet = r2.rawSnippet ?? "";
    fallbackKind = r2.kind;
    console.error(`[models] ${role} attempt 2 (${config.model}, retry) failed [${r2.kind}]: ${r2.message}`);
  }

  // Attempt 3: fallback model. A truncated/empty reply gets a lighter, longer-budget fallback call;
  // every other failure kind falls back with the original prompt and settings.
  const t3 = ensureTime();
  const fallbackMaxTokens = fallbackKind === "length" ? Math.round(maxTokens * 1.5) : maxTokens;
  const fallbackReasoning = fallbackKind === "length" ? "none" : reasoning;
  const r3 = await runAttempt(
    env,
    config.fallback_model,
    system,
    user,
    schemaName,
    jsonSchema,
    fallbackMaxTokens,
    t3,
    fallbackReasoning,
    schema,
  );
  if (r3.ok) return r3.value;
  lastError = r3.message;
  lastRawSnippet = r3.rawSnippet ?? "";
  console.error(`[models] ${role} attempt 3 (${config.fallback_model}, fallback) failed [${r3.kind}]: ${r3.message}`);

  console.error(`[models] ${role} exhausted all attempts. lastError=${lastError} rawSnippet=${lastRawSnippet}`);
  throw new ModelError(`The ${role} model did not return a usable answer.`, lastError);
}
