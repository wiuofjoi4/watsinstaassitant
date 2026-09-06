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

const GEMINI_FALLBACKS = ["gemini-3.5-flash", "gemini-3.7-flash", "gemini-3.8-flash"];

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

let __modelsCache: string[] | null = null;

/**
 * Lazily asks the Gemini API (via the raw REST endpoint) which models this
 * project/API-key can actually call, so fail-over discovers real model names
 * (e.g. new flash/lite models) instead of guessing. Returns [] on any failure.
 */
async function availableGeminiModels(): Promise<string[]> {
  if (__modelsCache) return __modelsCache;
  const key = process.env.GEMINI_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const names = (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
    const rank = (n: string) => {
      // Deprioritize image/audio/tts/video/omni/customtools variants — they
      // either reject plain chat text or are niche. Clean flash/lite first,
      // then gemma, then pro, then everything else.
      const niche = /image|tts|audio|video|omni|customtools|robotics|computer-use/.test(
        n
      );
      const clean = !niche;
      return clean
        ? n.includes("lite")
          ? 1
          : n.includes("pro")
            ? 3
            : 0
        : n.includes("gemma")
          ? 2
          : 4;
    };
    const ranked = [...new Set(names)].sort(
      (a, b) => rank(a) - rank(b) || a.localeCompare(b)
    );
    __modelsCache = ranked.slice(0, 12);
  } catch {
    __modelsCache = [];
  }
  return __modelsCache ?? [];
}

export function getAgentModel(): string {
  return getProvider() === "openai" ? AGENT_MODEL : GEMINI_MODEL;
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

async function tryModels(
  client: OpenAI,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParams,
  models: string[]
): Promise<{ result: OpenAI.Chat.Completions.ChatCompletion | null; errored: boolean }> {
  const now = Date.now();
  let lastErrored = false;
  for (const model of models) {
    const until = cooldownUntil.get(model);
    if (until && until > now) continue;
    try {
      const res = (await client.chat.completions.create({
        ...params,
        model,
      })) as OpenAI.Chat.Completions.ChatCompletion;
      return { result: res, errored: false };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      const status = Number((err as { status?: unknown })?.status ?? NaN);
      const quota = isQuotaError(err);
      const absent =
        status === 404 ||
        status === 400 ||
        /no longer available|not found|model.?doesn.?t exist|invalid model/i.test(text);
      lastErrored = quota || absent;
      if (quota || absent) {
        const waitMs = quota ? retryDelayMs(err, 60_000, 90_000) + 3_000 : 0;
        if (waitMs > 0) cooldownUntil.set(model, now + waitMs);
        continue;
      }
      return { result: null, errored: true };
    }
  }
  return { result: null, errored: lastErrored };
}

/**
 * Runs a chat completion with automatic model fail-over. When a model returns
 * a quota/rate-limit error (429) it is put into a short cooldown and the next
 * model in the chain is tried. If every configured model is exhausted, the
 * agent asks the Gemini API which models this project can actually call and
 * retries with those (observing per-model free-tier quotas). Non-quota errors
 * fail immediately.
 */
export async function completeWithFallback(
  client: OpenAI | null,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParams
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  if (!client) throw new Error("No AI provider configured");

  pruneCooldowns(Date.now());

  const provider = getProvider();
  const staticModels = provider === "openai" ? [AGENT_MODEL] : modelChain();

  const first = await tryModels(client, params, staticModels);
  if (first.result) return first.result;

  if (provider !== "gemini" || !first.errored) {
    throw new Error(
      first.errored
        ? "all configured models attempted and reached quota/rate limit"
        : "all configured models failed"
    );
  }

  // Static chain exhausted → ask the Gemini API which models this key can
  // actually call and try those (ranked: flash/lite/gemma first), then any
  // static-chain models that were not part of the discovery list. Models put
  // into cooldown moments ago are skipped automatically by tryModels.
  const discovered = await availableGeminiModels();
  const combined = [
    ...discovered,
    ...staticModels.filter((m) => !discovered.includes(m)),
  ];
  const second = await tryModels(client, params, combined);
  if (second.result) return second.result;
  throw new Error("all configured models attempted and reached quota/rate limit");
}