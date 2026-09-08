import OpenAI from "openai";

export type Provider = "gemini" | "openai" | "openrouter";

export type KeyLabel =
  | `gemini:${number}`
  | `openai:${number}`
  | `openrouter:${number}`;

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

const PROVIDER_PRIORITY: Provider[] = ["openrouter", "gemini", "openai"];

function providerEnv(p: Provider): string {
  return p === "gemini"
    ? "GEMINI_API_KEY"
    : p === "openrouter"
      ? "OPENROUTER_API_KEY"
      : "OPENAI_API_KEY";
}

function parseKeys(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function activeProviders(): Provider[] {
  return PROVIDER_PRIORITY.filter((p) => {
    return parseKeys(process.env[providerEnv(p)]).length > 0;
  });
}

export function getProvider(): Provider | null {
  const providers = activeProviders();
  return providers[0] ?? null;
}

export function isAIConfigured(): boolean {
  return activeProviders().length > 0;
}

// ---------------------------------------------------------------------------
// Client pool — one OpenAI client per API key, grouped by provider
// ---------------------------------------------------------------------------

type ProviderKey = { provider: Provider; key: string; index: number };

let __pool: Map<string, OpenAI> | null = null;

function buildPool(): Map<string, OpenAI> {
  const pool = new Map<string, OpenAI>();

  for (const provider of activeProviders()) {
    const keys = parseKeys(process.env[providerEnv(provider)]);
    keys.forEach((key, i) => {
      const label: KeyLabel = `${provider}:${i}`;
      pool.set(
        label,
        provider === "gemini"
          ? new OpenAI({
              apiKey: key,
              baseURL:
                "https://generativelanguage.googleapis.com/v1beta/openai/",
            })
          : provider === "openrouter"
            ? new OpenAI({
                apiKey: key,
                baseURL: "https://openrouter.ai/api/v1",
                defaultHeaders: {
                  "HTTP-Referer": openRouterReferer(),
                  "X-Title": "Watsinsta Assistant",
                },
              })
            : new OpenAI({ apiKey: key })
      );
    });
  }
  return pool;
}

function getPool(): Map<string, OpenAI> {
  if (!__pool) __pool = buildPool();
  return __pool;
}

function getPoolKeys(): ProviderKey[] {
  const pool = getPool();
  return Array.from(pool.keys()).map((label) => {
    const [provider, indexStr] = label.split(":") as [Provider, string];
    return { provider, key: "", index: Number(indexStr) };
  });
}

/** Get a random OpenAI client for Whisper transcription (OpenAI-only). */
export function getWhisperClient(): OpenAI | null {
  const keys = parseKeys(process.env.OPENAI_API_KEY);
  if (keys.length === 0) return null;
  // Pick a random key to spread transcription load across keys.
  const i = Math.floor(Math.random() * keys.length);
  return new OpenAI({ apiKey: keys[i] });
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export const AGENT_MODEL = process.env.AGENT_MODEL ?? "gpt-4o-mini";
export const OR_MODEL =
  process.env.OR_MODEL ?? "inclusionai/ling-3.0-flash-sante:free";
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
export const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL ?? "whisper-1";

function openRouterReferer(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://localhost:3000")
  );
}

const GEMINI_FALLBACKS = [
  "gemini-3.5-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
];

function modelChain(provider: Provider): string[] {
  if (provider === "openai") return [AGENT_MODEL];
  if (provider === "openrouter") return [OR_MODEL];

  const explicit = process.env.GEMINI_MODELS;
  let models: string[];
  if (explicit && explicit.trim()) {
    models = explicit
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    models = [...new Set([GEMINI_MODEL, ...GEMINI_FALLBACKS])];
  }
  if (models.length === 0) models = [GEMINI_MODEL];

  // Rotate starting position daily so load spreads across models.
  const now = new Date();
  const dayKey = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  const offset = dayKey % models.length;
  return [...models.slice(offset), ...models.slice(0, offset)];
}

export function getAgentModel(): string {
  const provider = getProvider();
  if (!provider) return AGENT_MODEL;
  if (provider === "openai") return AGENT_MODEL;
  if (provider === "openrouter") return OR_MODEL;
  return GEMINI_MODEL;
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function isQuotaError(err: unknown): boolean {
  const cast = err as { status?: unknown; code?: unknown; message?: string };
  const status = Number(cast?.status ?? cast?.code ?? NaN);
  if (Number.isInteger(status) && status === 429) return true;
  const text = cast?.message ?? String(err);
  return /429|quota|rate limit|RESOURCE_EXHAUSTED|RetryInfo/i.test(text);
}

function isTransientError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|503|502|500/i.test(text);
}

function retryDelayMs(err: unknown, fallbackMs: number, capMs: number): number {
  const text = err instanceof Error ? err.message : String(err);
  const m = /Please retry in (\d+(?:\.\d+)?)s/i.exec(text);
  if (m) return Math.min(Math.round(parseFloat(m[1]) * 1000), capMs);
  return Math.min(fallbackMs, capMs);
}

// ---------------------------------------------------------------------------
// Cooldown — per-model cooldown after a quota hit
// ---------------------------------------------------------------------------

const cooldownUntil = new Map<string, number>();

function pruneCooldowns(now: number): void {
  for (const k of cooldownUntil.keys()) {
    if ((cooldownUntil.get(k) ?? 0) <= now) cooldownUntil.delete(k);
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Available Gemini models (auto-discovered from the API)
// ---------------------------------------------------------------------------

let __modelsCache: string[] | null = null;

async function availableGeminiModels(): Promise<string[]> {
  if (__modelsCache) return __modelsCache;
  const keys = parseKeys(process.env.GEMINI_API_KEY);
  if (keys.length === 0) return [];

  // Use the first key to discover available models.
  const key = keys[0];
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models?: Array<{
        name?: string;
        supportedGenerationMethods?: string[];
      }>;
    };
    const names = (data.models ?? [])
      .filter((m) =>
        (m.supportedGenerationMethods ?? []).includes("generateContent")
      )
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);

    const rank = (n: string) => {
      const niche =
        /image|tts|audio|video|omni|customtools|robotics|computer-use/.test(n);
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

// ---------------------------------------------------------------------------
// Model fail-over + key rotation
// ---------------------------------------------------------------------------

type AttemptLog = { model: string; status: number; msg: string };

async function tryModels(
  params: OpenAI.Chat.Completions.ChatCompletionCreateParams,
  models: string[],
  providersToTry: Provider[],
  budgetEndMs: number,
  timeoutMs: number
): Promise<{
  result: OpenAI.Chat.Completions.ChatCompletion | null;
  keyUsed: KeyLabel | null;
  errored: boolean;
  attempts: AttemptLog[];
}> {
  const attempts: AttemptLog[] = [];
  const pool = getPool();
  const poolKeys = getPoolKeys();
  let lastErrored = false;

  // Hard wall clock: every attempt is aborted when its own time is up AND the
  // whole chain stops the moment the shared budget runs out. This is what
  // guarantees the main reply cannot silently take 20+s (a slow/cold first
  // token, quota waits, or retries all eat the same shared deadline).
  const remaining = () => Math.max(0, budgetEndMs - Date.now());
  const call = (p: typeof params, m: string, client: OpenAI) => {
    const live = Math.min(timeoutMs, remaining());
    if (live <= 0) return Promise.reject(new Error("budget exhausted"));
    return client.chat.completions.create(
      { ...p, model: m },
      { signal: AbortSignal.timeout(live) }
    );
  };

  outer: for (const model of models) {
    if (remaining() <= 0) break;
    // For this model, try every key of every provider in the chain.
    for (const provider of providersToTry) {
      const keyIndices = poolKeys
        .filter((k) => k.provider === provider)
        .map((k) => k.index);
      for (const keyIdx of keyIndices) {
        if (remaining() <= 0) break outer;
        const label: KeyLabel = `${provider}:${keyIdx}`;
        const client = pool.get(label);
        if (!client) continue;

        const now = Date.now();
        const until = cooldownUntil.get(model);
        if (until && until > now) {
          attempts.push({ model, status: 0, msg: "cooldown" });
          continue;
        }

        try {
          const res = (await call(params, model, client)) as OpenAI.Chat.Completions.ChatCompletion;
          return { result: res, keyUsed: label, errored: false, attempts };
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          const status = Number(
            (err as { status?: unknown })?.status ?? NaN
          );
          const timedOut =
            (err instanceof Error && /abort|timeout/i.test(err.name ?? "")) ||
            /abort|timed ?out|timeout/i.test(text);
          const quota = isQuotaError(err);
          const absent =
            status === 404 ||
            status === 400 ||
            /no longer available|not found|model.?doesn.?t exist|invalid model/i.test(
              text
            );
          attempts.push({
            model,
            status,
            msg: `${label}: ${text.slice(0, 120)}`,
          });

          if (/budget exhausted/i.test(text)) break outer;
          // Timeouts/absent models are normal per-model failures — keep trying
          // remaining models/keys while the budget allows.
          if (timedOut || absent) continue;

          if (quota) {
            // Back-off the per-model cooldown (covers all keys for this model;
            // one key hitting 429 means the shared free-tier bucket is empty).
            // Keep the wait SHORT when the budget is running out: during a
            // quota-exhausted window the customer should get the graceful
            // reply in seconds, not after a long silent wait.
            const retryMs = Math.min(
              retryDelayMs(err, 8_000, 20_000),
              remaining()
            );
            if (retryMs > 0 && remaining() > 4_000) {
              cooldownUntil.set(model, Date.now() + retryMs + 1_000);
              await delay(retryMs);
              if (remaining() <= 0) break outer;
              try {
                const res2 = (await call(params, model, client)) as OpenAI.Chat.Completions.ChatCompletion;
                return {
                  result: res2,
                  keyUsed: label,
                  errored: false,
                  attempts,
                };
              } catch (err2) {
                lastErrored = isQuotaError(err2);
                attempts.push({
                  model,
                  status: Number(
                    (err2 as { status?: unknown })?.status ?? NaN
                  ),
                  msg: `${label}: ${(err2 instanceof Error ? err2.message : String(err2)).slice(0, 120)}`,
                });
              }
            } else {
              cooldownUntil.set(model, Date.now() + 2_000);
            }
            // Cooldown exhausted — move to the next key/model.
            break;
          }
          // Non-quota, non-transient → fail immediately.
          return { result: null, keyUsed: null, errored: true, attempts };
        }
      }
    }
  }
  return { result: null, keyUsed: null, errored: lastErrored, attempts };
}

// ---------------------------------------------------------------------------
// Public: completeWithFallback — multi-key, multi-provider fail-over
// ---------------------------------------------------------------------------

/**
 * Runs a chat completion with automatic model fail-over and key rotation.
 *
 * Strategy (in order, per PROVIDER_PRIORITY):
 *  1. OpenRouter keys × OR_MODEL
 *  2. Gemini keys × static model chain (daily rotation)
 *  3. Gemini discovered models (via live API) × all Gemini keys
 *  4. OpenAI key(s) × AGENT_MODEL
 *
 * Within each provider, each model is retried once with back-off on 429.
 * After exhausting a provider, falls through to the next one in priority.
 * The whole chain is bounded by `budgetMs` (time spent retrying/waiting) and
 * each individual API call by `timeoutMs` — a slow quota wait must never eat
 * the webhook budget or the customer would never get a reply.
 */
export interface CompleteOptions {
  budgetMs?: number;
  timeoutMs?: number;
}

export async function completeWithFallback(
  params: OpenAI.Chat.Completions.ChatCompletionCreateParams,
  opts?: CompleteOptions
): Promise<
  OpenAI.Chat.Completions.ChatCompletion & { keyLabel?: string }
> {
  const budgetMs = opts?.budgetMs ?? 20_000;
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  // One shared deadline across every phase so the total chain (Gemini chain +
  // discovered + OpenAI) can never exceed `budgetMs` end-to-end.
  const budgetEndMs = Date.now() + budgetMs;
  const pool = getPool();
  const providers = activeProviders();

  if (providers.length === 0) {
    throw new Error("No AI provider configured — set GEMINI_API_KEY or OPENAI_API_KEY");
  }

  pruneCooldowns(Date.now());

  const geminiModels = providers.includes("gemini")
    ? modelChain("gemini")
    : [];
  const attemptLogs: AttemptLog[] = [];

  // --- Phase 1: OpenRouter (top of PROVIDER_PRIORITY) ---
  if (providers.includes("openrouter")) {
    const openrouterFirst = await tryModels(
      params,
      [OR_MODEL],
      ["openrouter"],
      budgetEndMs,
      timeoutMs
    );
    attemptLogs.push(...(openrouterFirst.attempts ?? []));
    if (openrouterFirst.result) {
      return Object.assign(openrouterFirst.result, {
        keyLabel: openrouterFirst.keyUsed ?? undefined,
      });
    }
  }

  // --- Phase 2: Gemini static chain ---
  if (geminiModels.length > 0) {
    const first = await tryModels(
      params,
      geminiModels,
      ["gemini"],
      budgetEndMs,
      timeoutMs
    );
    attemptLogs.push(...(first.attempts ?? []));
    if (first.result) {
      return Object.assign(first.result, { keyLabel: first.keyUsed ?? undefined });
    }

    // --- Phase 3: Gemini auto-discovered models ---
    // Runs whenever phase 1 produced nothing — including "all static model
    // names invalid/absent" (404). Older builds only ran discovery when the
    // chain *errored*, so stale/renamed default models hid the real ones
    // forever and every turn fell through to a silent apology.
    const discovered = await availableGeminiModels();
    const combined = [
      ...discovered,
      ...geminiModels.filter((m) => !discovered.includes(m)),
    ];
    const second = await tryModels(
      params,
      combined,
      ["gemini"],
      budgetEndMs,
      timeoutMs
    );
    attemptLogs.push(...(second.attempts ?? []));
    if (second.result) {
      return Object.assign(second.result, { keyLabel: second.keyUsed ?? undefined });
    }
  }

  // --- Phase 4: OpenAI ---
  if (providers.includes("openai")) {
    const third = await tryModels(
      params,
      [AGENT_MODEL],
      ["openai"],
      budgetEndMs,
      timeoutMs
    );
    attemptLogs.push(...(third.attempts ?? []));
    if (third.result) {
      return Object.assign(third.result, { keyLabel: third.keyUsed ?? undefined });
    }
  }

  // All providers and keys exhausted.
  const e = new Error(
    "all AI providers and keys exhausted — set new API keys or wait for quota reset"
  ) as Error & { attempts?: AttemptLog[] };
  e.attempts = attemptLogs;
  // Surface last-12 attempts to Vercel logs for remote diagnosis of why the
  // turn fell back to the apology (model-not-found vs quota vs timeout).
  console.error(
    `[AI-FALLBACK] ${e.message}\n` +
      attemptLogs
        .slice(-12)
        .map((a, i) => `  ${i}) ${a.model || "?"} [${a.status}] ${a.msg}`)
        .join("\n")
  );
  throw e;
}
