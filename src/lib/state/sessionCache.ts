// ---------------------------------------------------------------------------
// M5 in-lambda session cache. A bounded, soft-TTL LRU of condensed conversation
// context, keyed by `${restaurantId}:${channel}:${remoteJid}` — the same key the
// engine's per-conversation lock uses (engine.ts withConversationLock), so the
// Combiner can wire it into the engine's read path without reshaping keys.
//
// Lives at MODULE scope: each lambda instance gets exactly one copy (Next 16
// nodejs runtime — module state is per-instance and does not need globalThis).
// It is a HIT-RATE helper for hot repeat customers, never a consistency
// primitive — the database stays authoritative.
//
// Soft TTL: entries older than SESSION_CACHE_TTL_MS are reported as a miss but
// are NOT eagerly removed. Hard eviction happens via pruneCache (called by the
// cron cleanup route) or via LRU-cap eviction on insert. Memory stays bounded.
// ---------------------------------------------------------------------------
import type { CondensedContext } from "@/lib/agent/summary";
import type { Channel } from "@/lib/agent/engine";

export interface CachedSession {
  context: CondensedContext | null;
  lastMessageAt: number;
}

/** getCachedContext returns the stored value plus the read-time age. */
export interface CachedSessionRead extends CachedSession {
  ageMs: number;
}

const DEFAULT_CACHE_SIZE = 500;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

// Env is read lazily per call so tests can pin SESSION_CACHE_SIZE / TTL and a
// re-deployed lambda picks up a new value without a cold start cycle.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Map preserves insertion order; re-inserting a touched key on read keeps the
// LRU order intact, so the head is always the least-recently-used entry.
const cache = new Map<string, CachedSession>();

/** Builds the engine-compatible session key for a conversation. */
export function sessionKey(
  restaurantId: string,
  channel: Channel,
  remoteJid: string
): string {
  return `${restaurantId}:${channel}:${remoteJid}`;
}

/** Read a session context. Undefined on miss (absent OR older than TTL). */
export function getCachedContext(key: string): CachedSessionRead | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  const ageMs = Date.now() - hit.lastMessageAt;
  if (ageMs > envInt("SESSION_CACHE_TTL_MS", DEFAULT_TTL_MS)) {
    // Soft TTL miss: leave the entry in place (pruneCache will collect it).
    return undefined;
  }
  // Recency bump so the LRU cap evicts the truly-oldest first.
  cache.delete(key);
  cache.set(key, hit);
  return { context: hit.context, lastMessageAt: hit.lastMessageAt, ageMs };
}

/** Insert or overwrite a session context, enforcing the LRU cap. */
export function setCachedContext(key: string, value: CachedSession): void {
  cache.delete(key);
  cache.set(key, {
    context: value.context,
    lastMessageAt: Number.isFinite(value.lastMessageAt)
      ? value.lastMessageAt
      : Date.now(),
  });
  const cap = envInt("SESSION_CACHE_SIZE", DEFAULT_CACHE_SIZE);
  while (cache.size > cap) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearCachedContext(key: string): void {
  cache.delete(key);
}

export function clearAllCachedContext(): void {
  cache.clear();
}

/**
 * Hard-evict entries whose last write is older than olderThanMs. Used by the
 * cron cleanup route (lambdas are ephemeral, so this usually no-ops on the
 * instance that seeded the cache). Returns the number of removed entries.
 */
export function pruneCache(olderThanMs: number): number {
  const cutoff = Date.now() - Math.max(0, olderThanMs);
  let removed = 0;
  for (const [key, entry] of cache) {
    if (entry.lastMessageAt < cutoff) {
      cache.delete(key);
      removed++;
    }
  }
  return removed;
}

/** Number of live entries (diagnostics / selftest). */
export function cacheSize(): number {
  return cache.size;
}