import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ModelError, callJson } from "../models";

/** A fake env.AI whose `run()` behaviour is supplied by the test, plus a fake env.DB that always
 * fails so `models.ts` falls back to its hard-coded DEFAULTS (no D1 needed in a unit test). */
function makeEnv(runImpl: (model: string, input: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown>) {
  const calls: Array<{ model: string; input: Record<string, unknown>; opts: Record<string, unknown> }> = [];
  const env = {
    DB: {
      prepare() {
        throw new Error("no D1 in unit tests — models.ts must fall back to its hard-coded defaults");
      },
    },
    AI: {
      run: (model: string, input: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
        calls.push({ model, input, opts });
        return runImpl(model, input, opts);
      },
    },
  } as unknown as Env;
  return { env, calls };
}

const Schema = z.object({ ok: z.boolean() });

function jsonReply(value: unknown) {
  return { choices: [{ message: { content: JSON.stringify(value) } }] };
}

describe("callJson timeout budgeting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start any call when the deadline leaves under 8s of usable budget", async () => {
    const { env, calls } = makeEnv(() => new Promise(() => {}));
    // 5000ms until the deadline, minus the 3000ms buffer callJson reserves, leaves ~2000ms — under
    // the 8000ms floor, so callJson must refuse to start the attempt at all.
    const deadlineMs = Date.now() + 5000;

    await expect(
      callJson(env, "extractor", { system: "s", user: "u", schema: Schema, schemaName: "s", deadlineMs }),
    ).rejects.toThrow(ModelError);
    await expect(
      callJson(env, "extractor", { system: "s", user: "u", schema: Schema, schemaName: "s", deadlineMs }),
    ).rejects.toThrow(/not enough time left/i);
    expect(calls).toHaveLength(0);
  });

  it("on a TIMEOUT, skips the same-model retry and reaches the fallback model, aborting the hung call", async () => {
    const { env, calls } = makeEnv(() => new Promise(() => {})); // every call hangs forever
    const promise = callJson(env, "extractor", {
      system: "s",
      user: "u",
      schema: Schema,
      schemaName: "s",
      overrides: { timeoutMs: 10_000 },
    });
    // Swallow the eventual rejection so an unhandled-rejection warning doesn't leak between the
    // fake-timer advances below and the final `await expect(...).rejects` assertion.
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(10_000); // attempt 1 (primary) times out
    await vi.advanceTimersByTimeAsync(10_000); // attempt 2 (fallback, no retry in between) times out

    await expect(promise).rejects.toThrow(ModelError);
    // Extractor defaults: primary kimi-k2.6, fallback glm-5.3. Exactly two calls — no same-model retry.
    expect(calls.map((c) => c.model)).toEqual(["@cf/moonshotai/kimi-k2.6", "@cf/zai-org/glm-5.3"]);
    expect(calls[0].opts.signal).toBeInstanceOf(AbortSignal);
    expect((calls[0].opts.signal as AbortSignal).aborted).toBe(true);
  });

  it("retries the same model once on a schema/parse failure before returning", async () => {
    let attempt = 0;
    const { env, calls } = makeEnv(async () => {
      attempt += 1;
      return attempt === 1 ? { choices: [{ message: { content: "not json" } }] } : jsonReply({ ok: true });
    });

    const result = await callJson(env, "extractor", { system: "s", user: "u", schema: Schema, schemaName: "s" });

    expect(result).toEqual({ ok: true });
    expect(calls.map((c) => c.model)).toEqual(["@cf/moonshotai/kimi-k2.6", "@cf/moonshotai/kimi-k2.6"]);
  });

  it("skips the same-model retry on a truncated (finish_reason=length) reply and falls back with reasoning none + 1.5x max_tokens", async () => {
    const { env, calls } = makeEnv(async (model) => {
      if (model === "@cf/moonshotai/kimi-k2.6") {
        return { choices: [{ message: { content: "" }, finish_reason: "length" }] };
      }
      return jsonReply({ ok: true });
    });

    const result = await callJson(env, "extractor", {
      system: "s",
      user: "u",
      schema: Schema,
      schemaName: "s",
      overrides: { maxTokens: 1000 },
    });

    expect(result).toEqual({ ok: true });
    expect(calls.map((c) => c.model)).toEqual(["@cf/moonshotai/kimi-k2.6", "@cf/zai-org/glm-5.3"]);
    expect(calls[1].input.max_tokens).toBe(1500); // 1000 * 1.5
    expect(calls[1].input.reasoning_effort).toBe("none"); // forced to "none" for the length-failure fallback
  });

  it("maps reasoning 'low' to 'none' when the model actually called is a kimi model", async () => {
    const { env, calls } = makeEnv(async () => jsonReply({ ok: true }));

    await callJson(env, "extractor", {
      system: "s",
      user: "u",
      schema: Schema,
      schemaName: "s",
      overrides: { reasoning: "low" },
    });

    // Extractor's primary model is kimi-k2.6, which only supports reasoning "none"|"high".
    expect(calls[0].input.reasoning_effort).toBe("none");
  });

  it("does not remap reasoning 'low' for a non-kimi model", async () => {
    const { env, calls } = makeEnv(async () => jsonReply({ ok: true }));

    await callJson(env, "certification", {
      system: "s",
      user: "u",
      schema: Schema,
      schemaName: "s",
      overrides: { reasoning: "low" },
    });

    // Certification's primary model is a DeepSeek model, which does support reasoning "low".
    expect(calls[0].input.reasoning_effort).toBe("low");
  });

  it("clamps the attempt timeout to the deadline budget even when the override timeout is longer", async () => {
    const { env, calls } = makeEnv(() => new Promise(() => {}));
    const deadlineMs = Date.now() + 13_000; // minus 3000ms buffer -> ~10000ms budget, tighter than the 25000ms override
    const promise = callJson(env, "extractor", {
      system: "s",
      user: "u",
      schema: Schema,
      schemaName: "s",
      deadlineMs,
      overrides: { timeoutMs: 25_000 },
    });
    promise.catch(() => {});

    // If the deadline clamp were ignored in favour of the 25000ms override, nothing would happen yet.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.signal).toBeInstanceOf(AbortSignal);
    expect((calls[0].opts.signal as AbortSignal).aborted).toBe(true);

    // By now ~10s of the 13s deadline is spent, leaving under the 8s floor for a fallback attempt.
    await expect(promise).rejects.toThrow(ModelError);
    expect(calls).toHaveLength(1);
  });
});
