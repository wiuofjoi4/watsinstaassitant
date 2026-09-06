import OpenAI from "openai";

let __client: OpenAI | null = null;

export type Provider = "gemini" | "openai";

export function getProvider(): Provider | null {
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GEMINI_API_KEY) return "gemini";
  return null;
}

export function getOpenAI(): OpenAI | null {
  const provider = getProvider();
  if (!provider) return null;
  if (!__client) {
    __client =
      provider === "gemini"
        ? new OpenAI({
            apiKey: process.env.GEMINI_API_KEY,
            baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
          })
        : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return __client;
}

export const AGENT_MODEL = process.env.AGENT_MODEL ?? "gpt-4o";
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
export const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL ?? "whisper-1";

const GEMINI_FALLBACKS = ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.0-flash"];

/**
 * Ordered model candidates for the current provider. On Gemini, the chain
 * includes extra free models so that when one model's daily quota is
 * exhausted the agent can fall back to another. The starting position rotates
 * daily so the load spreads across every model instead of one hogging all
 * requests. Override with GEMINI_MODELS (comma-separated).
 */
function modelChain(): string[] {
  const provider = getProvider();
  if (provider === "openai") return [AGENT_MODEL];

  const explicit = process.env.GEMINI_MODELS;
  let models: string[];
  if (explicit && explicit.trim()) {
    models = explicit.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    models = [...new Set([GEMINI_MODEL, ...GEMINI_FALLBACKS])];
  }
  if (models.length === 0) models = [GEMINI_MODEL];

  const now = new Date();
  const dayKey = now.getFullYear() * 10000 + now.getMonth() * 100 + now.getDate();
  const offset = dayKey % models.length;
  return [...models.slice(offset), ...models.slice(0, offset)];
}

export function getAgentModel(): string {
  return modelChain()[0];
}

export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  audioSeconds: number
): number {
  const inPerM = 2.5;
  const outPerM = 10;
  const perSec = 0.006 / 60;
  return (
    (inputTokens / 1_000_000) * inPerM +
    (outputTokens / 1_000_000) * outPerM +
    audioSeconds * perSec
  );
}

function isQuotaError(err: unknown): boolean {
  const cast = err as { status?: unknown; code?: unknown; message?: string };
  const status = Number(cast?.status ?? cast?.code ?? NaN);
  if (Number.isInteger(status) && status === 429) return true;
  const text = cast?.message ?? String(err);
  return /429|quota|rate limit|RESOURCE_EXHAUSTED|RetryInfo/i.test(text);
}

function retryDelayMs(err: unknown, fallbackMs: number, capMs: number): number {
  const text = err instanceof Error ? err.message : String(err);
  const m = /Please retry in (\d+(?:\.\d+)?)s/i.exec(text);
  if (m) return Math.min(Math.round(parseFloat(m[1]) * 1000), capMs);
  return Math.min(fallbackMs, capMs);
}

const cooldownUntil = new Map<string, number>();

function pruneCooldowns(now: number): void {
  for (const k of cooldownUntil.keys()) {
    if ((cooldownUntil.get(k) ?? 0) <= now) cooldownUntil.delete(k);
  }
}

/**
 * Runs a chat completion with automatic model fail-over. When a model returns
 * a quota/rate-limit error (429), it is put into a short cooldown and the next
 * model in the chain is tried, spreading the load across all Gemini models.
 * Non-quota errors fail immediately.
 */
export async function completeWithFallback(
  client: OpenAI | null,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParams
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  if (!client) throw new Error("No AI provider configured");

  const now = Date.now();
  pruneCooldowns(now);
  const models = modelChain();
  let lastErr: unknown = null;

  for (const model of models) {
    const until = cooldownUntil.get(model);
    if (until && until > now) continue;

    try {
      const res = (await client.chat.completions.create({
        ...params,
        model,
      })) as OpenAI.Chat.Completions.ChatCompletion;
      return res;
    } catch (err) {
      lastErr = err;
      const text = err instanceof Error ? err.message : String(err);
      const absentModel = /(?:model|modelName)[^]*?not found|not found[^]*?model/i.test(
        text
      );
      if (isQuotaError(err) || (err as { status?: unknown })?.status === 400 || absentModel) {
        const waitMs = isQuotaError(err)
          ? retryDelayMs(err, 60_000, 90_000) + 3_000
          : 0;
        if (waitMs > 0) cooldownUntil.set(model, now + waitMs);
        continue;
      }
      throw err;
    }
  }

  throw lastErr ?? new Error("all models attempted and reached quota/rate limit");
}