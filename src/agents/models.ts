// Hosted Workers AI calls and schemas. See docs/ARCHITECTURE.md §2 and §5.
//
// Reasoning parameter: `reasoning_effort` (string | null). Verified via the Workers AI model docs
// (2026-09-26) for both configured models:
//   - @cf/moonshotai/kimi-k2.6            enum: "high" (default) | "none"
//   - @cf/deepseek-ai/deepseek-v4-pro-0813 enum: "max" | "high" | "low" | "none"
// The seed data only ever uses "none" or "high", which are valid literal values for both models, so
// it is passed straight through as `reasoning_effort` whenever agent_config.reasoning is non-null.
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
    reasoning: "high",
    max_tokens: 3000,
    timeout_ms: 60000,
  },
  quantitative: {
    role: "quantitative",
    model: "@cf/deepseek-ai/deepseek-v4-pro-0813",
    fallback_model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
    reasoning: "high",
    max_tokens: 3000,
    timeout_ms: 60000,
  },
  sourcing: {
    role: "sourcing",
    model: "@cf/moonshotai/kimi-k2.6",
    fallback_model: "@cf/zai-org/glm-5.3",
    reasoning: "high",
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

/** Extract the model's textual reply from either observed Workers AI response shape. */
function extractContent(result: unknown): string {
  if (result && typeof result === "object") {
    const asChoices = result as { choices?: Array<{ message?: { content?: unknown } }> };
    const fromChoices = asChoices.choices?.[0]?.message?.content;
    if (typeof fromChoices === "string") return fromChoices;

    const asResponse = result as { response?: unknown };
    if (typeof asResponse.response === "string") return asResponse.response;
  }
  throw new Error(`Unrecognized Workers AI response shape: ${JSON.stringify(result).slice(0, 500)}`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
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
): Promise<string> {
  const input: Record<string, unknown> = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: { name: schemaName, schema: jsonSchema } },
    max_tokens: maxTokens,
  };
  if (reasoningEffort) input.reasoning_effort = reasoningEffort;

  const gatewayOptions = env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined;

  // Model ids are not all present in the generated Workers AI union; call through a loosely typed handle.
  const ai = env.AI as unknown as {
    run: (model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
  };

  const result = await withTimeout(ai.run(model, input, gatewayOptions), timeoutMs, `Workers AI call (${model})`);
  return extractContent(result);
}

/** Parse a model's text reply into `T`, or return the failure reason for a retry. */
function tryParse<T>(content: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  const candidate = stripCodeFences(content);
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

/**
 * Call the configured model for `role`, parse+validate the JSON reply against `schema`.
 * Retries once on the same model with the validation error appended, then once on the fallback model,
 * then throws ModelError. Raw provider output is never included in the thrown message (logged instead).
 */
export async function callJson<T>(
  env: Env,
  role: ModelRole,
  args: { system: string; user: string; schema: z.ZodType<T>; schemaName: string },
): Promise<T> {
  const { system, user, schema, schemaName } = args;
  const config = await getConfig(env, role);
  const jsonSchema = z.toJSONSchema(schema);

  const attempts: Array<{ model: string; user: string }> = [
    { model: config.model, user },
  ];

  let lastRawSnippet = "";
  let lastError = "";

  // Attempt 1: primary model, original prompt.
  try {
    const content = await callModelOnce(
      env,
      attempts[0].model,
      system,
      attempts[0].user,
      schemaName,
      jsonSchema,
      config.max_tokens,
      config.timeout_ms,
      config.reasoning,
    );
    const parsed = tryParse(content, schema);
    if (parsed.ok) return parsed.value;
    lastError = parsed.error;
    lastRawSnippet = content.slice(0, 500);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error(`[models] ${role} attempt 1 (${attempts[0].model}) failed`, err);
  }

  // Attempt 2: same model, error appended to the user message.
  try {
    const retryUser = `${user}\n\nYour previous reply could not be used: ${lastError}\nReturn ONLY valid JSON matching the required schema.`;
    const content = await callModelOnce(
      env,
      config.model,
      system,
      retryUser,
      schemaName,
      jsonSchema,
      config.max_tokens,
      config.timeout_ms,
      config.reasoning,
    );
    const parsed = tryParse(content, schema);
    if (parsed.ok) return parsed.value;
    lastError = parsed.error;
    lastRawSnippet = content.slice(0, 500);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error(`[models] ${role} attempt 2 (${config.model}, retry) failed`, err);
  }

  // Attempt 3: fallback model, original prompt.
  try {
    const content = await callModelOnce(
      env,
      config.fallback_model,
      system,
      user,
      schemaName,
      jsonSchema,
      config.max_tokens,
      config.timeout_ms,
      config.reasoning,
    );
    const parsed = tryParse(content, schema);
    if (parsed.ok) return parsed.value;
    lastError = parsed.error;
    lastRawSnippet = content.slice(0, 500);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error(`[models] ${role} attempt 3 (${config.fallback_model}, fallback) failed`, err);
  }

  console.error(`[models] ${role} exhausted all attempts. lastError=${lastError} rawSnippet=${lastRawSnippet}`);
  throw new ModelError(`The ${role} model did not return a usable answer.`, lastError);
}
