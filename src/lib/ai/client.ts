import OpenAI from "openai";

let __client: OpenAI | null = null;

export type Provider = "gemini" | "openai";

export function getProvider(): Provider | null {
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
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

export function getAgentModel(): string {
  return getProvider() === "gemini" ? GEMINI_MODEL : AGENT_MODEL;
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

/**
 * Runs a chat completion with a bounded number of attempts. When the provider
 * reports a transient quota/rate-limit (429), it waits for the suggested
 * `retryDelay` and tries again, which smooths bursts on free-tier Gemini
 * keys. Non-quota errors fail immediately.
 */
export async function chatComplete(
  client: OpenAI | null,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParams,
  maxAttempts = 2
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  if (!client) throw new Error("No AI provider configured");
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return (await client.chat.completions.create(
        params
      )) as OpenAI.Chat.Completions.ChatCompletion;
    } catch (err) {
      if (attempt + 1 >= maxAttempts || !isQuotaError(err)) throw err;
      const delay = retryDelayMs(err, 20_000, 35_000);
      if (delay < 300) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("chatComplete exhausted attempts");
}