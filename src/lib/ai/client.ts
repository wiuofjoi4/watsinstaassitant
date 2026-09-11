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

// OpenRouter `:free` models are heavily rate-limited — under load they return
// 429/5xx intermittently, and with ONLY `OR_MODEL` configured the whole turn
// falls back to "عذراً صار خلل بسيط" every time the free model hiccups (the
// #1 cause of intermittent no-replies in production). When OR_MODEL fails we
// fail over to a short list of broadly-available cheap/free models (404/402
// are skipped fast by tryModels, so stale IDs are harmless). Override with the
// `OR_FALLBACK_MODELS` env var (comma-separated).
const OPENROUTER_FALLBACKS = (process.env.OR_FALLBACK_MODELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OR_FALLBACK_LIST = (
  OPENROUTER_FALLBACKS.length > 0
    ? OPENROUTER_FALLBACKS
    : [
        "meta-llama/llama-3.3-70b-instruct:free",
        "qwen/qwen3-235b-a22b:free",
        "deepseek/deepseek-chat-v3-0324:free",
        "google/gemini-2.5-flash",
      ]
).filter((m) => m !== OR_MODEL);
const OPENROUTER_MODELS = [OR_MODEL, ...OR_FALLBACK_LIST];

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
  if (provider === "openrouter") return OPENROUTER_MODELS;

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
  if (Number.isInteger(status) && (status === 429 || status === 402)) return true;
  const text = cast?.message ?? String(err);
  return /429|402|quota|rate limit|insufficient credit|RESOURCE_EXHAUSTED|RetryInfo/i.test(text);
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
// Circuit breaker — global for the whole AI provider chain (per process /
// lambda instance; every Vercel instance keeps its own state, so a breaker
// can never shut down instances it doesn't hold).
// Design is a WINDOWED FAILURE-RATIO, not a bare consecutive counter: a pure
// "3 consecutive failures" counter would trip on 3 random unrelated timeouts
// from 3 different restaurants at peak hours and knock out smart replies for
// every tenant on a healthy platform. Instead we record every full-chain
// attempt (success or failure) in a tumbling 60s window and open the breaker
// only when the chain is failing EN MASSE — >=10 attempts in the window, >=6
// failed, and >=75% failed. Random blips drowned in hundreds of successes
// never trip it; a real outage (provider down or shared-key quota exhausted,
// which by definition hits every restaurant at once) trips it within a few
// seconds of burst traffic. While open, every new call fails fast (<1ms)
// instead of burning the ~20s budget on a broken chain; after the cooldown
// the chain is tried again from a fresh window.
// ---------------------------------------------------------------------------
const CIRCUIT_WINDOW_MS = 60_000; // window over which attempts are tallied
const CIRCUIT_MIN_ATTEMPTS = 10; // need this many attempts before a trip is legal
const CIRCUIT_MIN_FAILURES = 6; // ...and at least this many of them failed
const CIRCUIT_FAIL_RATE = 0.75; // ...and at least 75% of them failed
const CIRCUIT_COOLDOWN_MS = 60_000; // how long the breaker stays open
let circuitWinStart = 0;
let circuitWinTotal = 0;
let circuitWinFailures = 0;
let circuitOpenedAt = 0;

function recordCircuitAttempt(ok: boolean, now: number): void {
  if (circuitOpenedAt) return; // an open breaker never samples its own fast-fails
  if (now - circuitWinStart >= CIRCUIT_WINDOW_MS) {
    circuitWinStart = now;
    circuitWinTotal = 0;
    circuitWinFailures = 0;
  }
  circuitWinTotal++;
  if (!ok) {
    circuitWinFailures++;
    if (
      circuitWinTotal >= CIRCUIT_MIN_ATTEMPTS &&
      circuitWinFailures >= CIRCUIT_MIN_FAILURES &&
      circuitWinFailures / circuitWinTotal >= CIRCUIT_FAIL_RATE
    ) {
      circuitOpenedAt = now;
      console.error(
        `[CIRCUIT] opened for ${(CIRCUIT_COOLDOWN_MS / 1000).toFixed(0)}s — ` +
          `${circuitWinFailures}/${circuitWinTotal} full-chain attempts failed`
      );
    }
  }
}

function circuitShouldFailFast(now: number): boolean {
  if (!circuitOpenedAt) return false;
  if (now - circuitOpenedAt < CIRCUIT_COOLDOWN_MS) return true;
  // Cooldown elapsed — close the breaker and start a fresh tally window.
  circuitOpenedAt = 0;
  circuitWinStart = 0;
  circuitWinTotal = 0;
  circuitWinFailures = 0;
  console.error(`[CIRCUIT] closed after cooldown`);
  return false;
}

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
          const content = res.choices?.[0]?.message?.content;
          if (content && String(content).trim() !== "") {
            return { result: res, keyUsed: label, errored: false, attempts };
          }
          // A 200 with empty content is a FAILED model: reasoning-only models
          // (e.g. some `:free` flash variants) can spend the whole token budget
          // on reasoning and return no customer-facing text. The engine would
          // otherwise reply with the "خلل بسيط" apology every time. Record it
          // and fall through to the next model/key in the chain.
          attempts.push({
            model,
            status: 0,
            msg: `${label}: empty content (no customer-facing text)`,
          });
          continue;
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
                const content2 = res2.choices?.[0]?.message?.content;
                if (content2 && String(content2).trim() !== "") {
                  return {
                    result: res2,
                    keyUsed: label,
                    errored: false,
                    attempts,
                  };
                }
                // Empty content after the quota retry — same handling as above.
                attempts.push({
                  model,
                  status: 0,
                  msg: `${label}: empty content after retry`,
                });
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
          } else if (isTransientError(err)) {
            // 5xx / network hiccup — a server-side blip on THIS model endpoint,
            // not an auth failure. Keep trying the remaining models/keys (this
            // is what makes multi-model failover actually work under a free
            // model overload instead of aborting the whole chain).
            continue;
          }
          // Hard failure (auth 401/403, etc.) — fail this provider fast.
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
  // Fail fast while the circuit breaker is open: the whole chain just failed
  // repeatedly, so don't burn the 20s budget on retries that will fail again.
  if (circuitShouldFailFast(Date.now())) {
    throw new Error("AI circuit breaker open — providers failing");
  }

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
      OPENROUTER_MODELS,
      ["openrouter"],
      budgetEndMs,
      timeoutMs
    );
    attemptLogs.push(...(openrouterFirst.attempts ?? []));
    if (openrouterFirst.result) {
      recordCircuitAttempt(true, Date.now());
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
      recordCircuitAttempt(true, Date.now());
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
      recordCircuitAttempt(true, Date.now());
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
      recordCircuitAttempt(true, Date.now());
      return Object.assign(third.result, { keyLabel: third.keyUsed ?? undefined });
    }
  }

  // All providers and keys exhausted.
  recordCircuitAttempt(false, Date.now());
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
