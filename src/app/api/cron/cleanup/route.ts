// ---------------------------------------------------------------------------
// M5 /api/cron/cleanup — Vercel cron: message retention, stale lock pruning,
// in-lambda session-cache prune. Idempotent + conservative: bounded batch
// deletes only, nothing table-widening can ever run, and every mutation is
// preceded by a dry-run-able math step. dry_run=true returns counts without
// deleting (query param on GET, or query param / JSON body on POST).
//
// Guard: rejects unless the caller presents the Vercel Cron bearer secret
// (Authorization: Bearer $CRON_SECRET) or the gateway secret
// (x-gateway-secret) — the same policy as /api/sync. Unconfigured secrets are
// treated as UNCONFIGURED-AUTH and REJECTED (env.ts policy). This route deletes
// rows, so it must never fall back to "allow everything".
// ---------------------------------------------------------------------------
import { NextResponse } from "next/server";
import { rawClient } from "@/lib/db";
import { gatewaySecretOk } from "@/lib/env";
import { pruneCache, cacheSize } from "@/lib/state/sessionCache";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Retention constants (env-overridable, defaults below).
const DEFAULT_MESSAGE_DAYS = 7;
const DEFAULT_LOCK_MINUTES = 60;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

// Bounded batch DELETEs: keeps each statement small (no long-statement stalls
// on the transaction pooler) and caps the whole run.
const BATCH_SIZE = 500;
const MAX_BATCH_ITERATIONS = 200; // 200 × 500 = 100k rows max per cron run
const RETAIN_PER_CONVERSATION = 100;

// The keep-most-recent-N optimization only exists for old rows — anything the
// per-conversation reservation covers is exempt from age-based retention.

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export interface CleanupOptions {
  dryRun?: boolean;
  messageDays?: number;
  lockMinutes?: number;
  retainPerConversation?: number;
  cacheOlderThanMs?: number;
}

export interface CleanupCounts {
  /** Rows the retention math WOULD delete (counted before any delete). */
  deletable: number;
  /** Rows actually deleted (0 on dry-run). */
  deleted: number;
  /** Number of batch iterations that ran. */
  batches: number;
  /** Messages kept per conversation by the reservation. */
  retainedPerConversation: number;
}

export interface RunCleanupResult {
  ok: boolean;
  dryRun: boolean;
  applied: boolean;
  messages: CleanupCounts;
  orderLocks: { tablePresent: boolean; deletable: number; deleted: number };
  conversationLocks: { deleted: number };
  cache: { pruned: number; size: number };
  skipped: string[];
  errors: string[];
}

/**
 * Run the full cleanup pass. Exported so ops tooling and the M5 selftest can
 * drive it without going through HTTP auth — the deletion path is gated by
 * dryRun and the total-purge guard, never by being "internal".
 */
export async function runCleanup(opts: CleanupOptions = {}): Promise<RunCleanupResult> {
  const dryRun = opts.dryRun === true;
  const messageDays = opts.messageDays ?? envInt("CLEANUP_MESSAGE_DAYS", DEFAULT_MESSAGE_DAYS);
  const lockMinutes = opts.lockMinutes ?? envInt("CLEANUP_LOCK_MINUTES", DEFAULT_LOCK_MINUTES);
  const retain = opts.retainPerConversation ?? RETAIN_PER_CONVERSATION;
  const cacheTtl = opts.cacheOlderThanMs ?? envInt("SESSION_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS);

  const result: RunCleanupResult = {
    ok: true,
    dryRun,
    applied: !dryRun,
    messages: {
      deletable: 0,
      deleted: 0,
      batches: 0,
      retainedPerConversation: retain,
    },
    orderLocks: { tablePresent: false, deletable: 0, deleted: 0 },
    conversationLocks: { deleted: 0 },
    cache: { pruned: 0, size: 0 },
    skipped: [],
    errors: [],
  };

  // ── 1) Message retention ─────────────────────────────────────────────
  const totalPurgeRisk = !Number.isFinite(messageDays) || messageDays <= 0;
  const purgeFlag = (process.env.CLEANUP_TOTAL_PURGE_FLAG ?? "").trim();
  if (totalPurgeRisk && purgeFlag !== "yes") {
    // A non-positive retention window would target the whole table (every row
    // is older than now() - 0 days). Refuse unless ops explicitly opted in.
    result.skipped.push(
      `messages: refused retention (CLEANUP_MESSAGE_DAYS=${messageDays}) because CLEANUP_TOTAL_PURGE_FLAG != "yes"`
    );
  } else {
    try {
      const [del] = (await rawClient`
        select count(*)::int as n
        from (
          select id, row_number() over (
            partition by conversation_id order by created_at desc
          ) as rn
          from repli.messages
          where created_at < now() - make_interval(days => ${messageDays})
        ) ranked
        where ranked.rn > ${retain}
      `) as Array<{ n: number }>;
      result.messages.deletable = del?.n ?? 0;

      if (!dryRun && result.messages.deletable > 0) {
        for (let i = 0; i < MAX_BATCH_ITERATIONS; i++) {
          const rows = (await rawClient`
            delete from repli.messages
            where id in (
              select id from (
                select id, row_number() over (
                  partition by conversation_id order by created_at desc
                ) as rn
                from repli.messages
                where created_at < now() - make_interval(days => ${messageDays})
              ) ranked
              where ranked.rn > ${retain}
              limit ${BATCH_SIZE}
            )
            returning id
          `) as Array<{ id: string }>;
          const n = rows.length;
          result.messages.deleted += n;
          result.messages.batches++;
          if (n < BATCH_SIZE) break;
        }

        // Defense-in-depth: the only variant this route ever runs is the
        // bounded batch above. If the math expected rows but the batches
        // dropped 0, never fall through to an unbounded "delete everything"
        // statement unless CLEANUP_TOTAL_PURGE_FLAG is exactly "yes".
        if (result.messages.deleted === 0 && purgeFlag !== "yes") {
          result.skipped.push(
            'messages: retention math dropped 0 rows and CLEANUP_TOTAL_PURGE_FLAG != "yes" — no-batch variant refused (nothing deleted)'
          );
        }
      }
    } catch (err) {
      result.errors.push(`messages retention failed: ${errMsg(err)}`);
      result.ok = false;
    }
  }

  // ── 2) Stale order_locks (table may not exist in this deployment yet) ──
  try {
    const reg = (await rawClient`
      select to_regclass('repli.order_locks') as t
    `) as Array<{ t: string | null }>;
    result.orderLocks.tablePresent = reg[0]?.t != null;
    if (result.orderLocks.tablePresent) {
      const [cnt] = (await rawClient`
        select count(*)::int as n
        from repli.order_locks
        where created_at < now() - make_interval(mins => ${lockMinutes})
      `) as Array<{ n: number }>;
      result.orderLocks.deletable = cnt?.n ?? 0;
      if (!dryRun && result.orderLocks.deletable > 0) {
        for (let i = 0; i < MAX_BATCH_ITERATIONS; i++) {
          const rows = (await rawClient`
            delete from repli.order_locks
            where id in (
              select id from repli.order_locks
              where created_at < now() - make_interval(mins => ${lockMinutes})
              limit ${BATCH_SIZE}
            )
            returning id
          `) as Array<{ id: string }>;
          const n = rows.length;
          result.orderLocks.deleted += n;
          if (n < BATCH_SIZE) break;
        }
      }
    } else {
      result.skipped.push("order_locks: table absent, nothing to prune");
    }
  } catch (err) {
    result.errors.push(`order_locks prune failed: ${errMsg(err)}`);
    result.ok = false;
  }

  // ── 3) Expired conversation_locks (the repo's actual lock table; the
  // engine opportunistically purges on every 100th acquisition, the cron
  // covers the rest from every instance). ────────────────────────────────
  try {
    if (!dryRun) {
      const rows = (await rawClient`
        delete from repli.conversation_locks
        where expires_at < now()
        returning lock_key
      `) as Array<{ lock_key: string }>;
      result.conversationLocks.deleted = rows.length;
    }
  } catch (err) {
    result.errors.push(`conversation_locks prune failed: ${errMsg(err)}`);
    result.ok = false;
  }

  // ── 4) In-lambda session cache (this instance only; usually a no-op
  // because each lambda seeds its own cache). ────────────────────────────
  result.cache.pruned = pruneCache(cacheTtl);
  result.cache.size = cacheSize();

  return result;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── HTTP surface (Vercel cron + manual ops trigger) ─────────────────────

function dryRunFromQuery(url: string): boolean {
  try {
    return new URL(url).searchParams.get("dry_run") === "true";
  } catch {
    return false;
  }
}

function isAuthorized(req: Request): boolean {
  // 1) Vercel Cron: Authorization: Bearer $CRON_SECRET.
  const cronSecret = (process.env.CRON_SECRET ?? "").trim();
  const authHeader = req.headers.get("authorization") ?? "";
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true;
  // 2) Gateway secret so ops can trigger it manually (same as /api/sync).
  if (gatewaySecretOk(req)) return true;
  // Unconfigured secrets = keep the route closed (env.ts policy).
  return false;
}

function unauthorized(): NextResponse {
  console.error("[CLEANUP] unauthorized cleanup attempt rejected");
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  const dryRun = dryRunFromQuery(req.url);
  return respond(await runCleanup({ dryRun }));
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  let dryRun = dryRunFromQuery(req.url);
  try {
    const body = (await req.json()) as { dry_run?: unknown } | null;
    if (body && typeof body === "object" && body.dry_run === true) dryRun = true;
  } catch {
    // no/empty body — query param already handled
  }
  return respond(await runCleanup({ dryRun }));
}

async function respond(result: RunCleanupResult) {
  console.error(
    `[CLEANUP] dryRun=${result.dryRun} ok=${result.ok} ` +
      `messages=${result.messages.deleted}/${result.messages.deletable} ` +
      `orderLocks=${result.orderLocks.deleted} ` +
      `conversationLocks=${result.conversationLocks.deleted} ` +
      `cachePruned=${result.cache.pruned} skipped=${result.skipped.length} errors=${result.errors.length}`
  );
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}