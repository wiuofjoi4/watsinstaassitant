// ---------------------------------------------------------------------------
// M10 admin-dashboard data-layer selftest.
// Run: npx tsx src/lib/selftest/admin.selftest.ts
//
// 1) Offline (always): subscriptionInfo() expiry/soon math on pure inputs.
// 2) DB-gated (real DATABASE_URL else SKIP, exit 0):
//    - stubs globalThis.__incrementalCache so the unstable_cache-wrapped admin
//      query functions execute their REAL DB callbacks outside of a Next
//      render (no cached entries are ever served or written);
//    - applies ADMIN_DDL twice (idempotence, IF NOT EXISTS);
//    - runs every admin query function against a scratch
//      restaurantId "selftest-<ts>" that has NO rows and asserts the EMPTY /
//      zero result and the return SHAPE (Array vs object vs null) without
//      throwing — this exercises each query's joins, types and column lists;
//    - asserts getConversationThread returns [] and
//      getConversationThreadPage returns [] and that both element types are
//      structurally the same (compile-time cast-check via ConversationThreadRow);
//    - global/aggregate queries (dashboard stats, overview, recent errors) are
//      shape-only — a real production DB may legitimately hold rows, so they
//      assert the return SHAPE instead of emptiness.
// NEVER writes a scratch row, NEVER wipes anything.
// Never prints secrets (no env values, no connection strings).
// ---------------------------------------------------------------------------
import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { rawClient } from "@/lib/db";
import { isPlaceholder } from "@/lib/env";
import { ADMIN_DDL } from "@/lib/ddl/admin";
import type { ConversationThreadRow } from "@/lib/queries";

type Queries = typeof import("@/lib/queries");

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
}

// subscriptionInfo is pure math with no DB — safe anywhere.
function subscriptionTests(q: Queries): void {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const fresh = q.subscriptionInfo(new Date(now - 1 * day), 30);
  assert(
    fresh.daysLeft >= 28 && fresh.daysLeft <= 29,
    `fresh sub: ~29 days left (got ${fresh.daysLeft})`
  );
  assert(fresh.expired === false && fresh.expiresSoon === false, "fresh sub flags off");

  const soon = q.subscriptionInfo(new Date(now - 28 * day), 30);
  assert(
    soon.daysLeft >= 1 && soon.daysLeft <= 2,
    `expiring sub: ~2 days left (got ${soon.daysLeft})`
  );
  assert(soon.expired === false && soon.expiresSoon === true, "expiring sub flags expiresSoon");

  const gone = q.subscriptionInfo(new Date(now - 31 * day), 30);
  assert(gone.daysLeft === 0 && gone.expired === true, "expired sub: 0 days left + expired");

  const never = q.subscriptionInfo(null, 30);
  assert(
    never.daysLeft === 0 && never.expired === false && never.expiresSoon === false,
    "unactivated sub: 0 days left, not expired (matches subscriptionInfo contract)"
  );
  console.log("OFFLINE-OK: subscriptionInfo (fresh / expiresSoon / expired / unactivated)");
}

// Minimal incremental-cache stand-in so unstable_cache-wrapped admin queries
// can be exercised outside of a Next render. Every call MISSES (get →
// undefined) so the real DB callback always runs; cacheNewResult's set() is a
// no-op, so nothing is ever persisted.
function installCacheStub(): void {
  (globalThis as { __incrementalCache?: unknown }).__incrementalCache = {
    generateSimpleCacheKey: async (_key: string) => {
      void _key;
      return "selftest-cache-key";
    },
    get: async () => undefined,
    set: async () => undefined,
    isOnDemandRevalidate: false,
  };
}

async function dbTests(q: Queries): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl || isPlaceholder(dbUrl)) {
    console.log("SKIP: no real DATABASE_URL (admin query db tests need a database; exit 0)");
    return;
  }

  installCacheStub();

  const stamp = Date.now();
  const restaurantId = `selftest-${stamp}`;
  const conversationId = `selftest-conv-${stamp}`;

  try {
    // Own DDL first — idempotent (run twice to prove it).
    await rawClient.unsafe("create schema if not exists repli");
    for (const stmt of ADMIN_DDL) await rawClient.unsafe(stmt);
    for (const stmt of ADMIN_DDL) await rawClient.unsafe(stmt);
    console.log("DDL-OK: ADMIN_DDL applied twice idempotently");

    // ── restaurant-scoped query functions (no rows for the scratch id) ────
    const detail = await q.getRestaurantDetail(restaurantId);
    assert(detail === null, "getRestaurantDetail(scratch id) → null (no row)");

    const convos = await q.getRestaurantConversations(restaurantId);
    assert(Array.isArray(convos), "getRestaurantConversations returns an array");
    assert(convos.length === 0, "getRestaurantConversations(scratch id) → []");

    const ordersRes = await q.getRestaurantOrders(restaurantId);
    assert(Array.isArray(ordersRes), "getRestaurantOrders returns an array");
    assert(ordersRes.length === 0, "getRestaurantOrders(scratch id) → []");

    const usage = await q.getRestaurantUsage(restaurantId);
    assert(Array.isArray(usage.logs), "getRestaurantUsage().logs is an array");
    assert(usage.logs.length === 0, "getRestaurantUsage(scratch id).logs → []");
    assert(
      Number(usage.totals.input) === 0 &&
        Number(usage.totals.output) === 0 &&
        Number(usage.totals.cost) === 0 &&
        Number(usage.totals.audio) === 0,
      "getRestaurantUsage(scratch id).totals → all-zero aggregates"
    );

    const errors = await q.getRestaurantErrors(restaurantId);
    assert(Array.isArray(errors), "getRestaurantErrors returns an array");
    assert(errors.length === 0, "getRestaurantErrors(scratch id) → []");

    console.log("SCOPED-OK: detail/conversations/orders/usage/errors all empty for scratch restaurant");

    // ── thread (legacy + paged) — empty + element-shape equality ─────────
    const thread = await q.getConversationThread(conversationId);
    assert(Array.isArray(thread), "getConversationThread returns an array");
    assert(thread.length === 0, "getConversationThread(scratch conv) → []");

    const page = await q.getConversationThreadPage({
      restaurantId,
      conversationId,
      offset: 0,
      limit: 50,
    });
    assert(Array.isArray(page), "getConversationThreadPage returns an array");
    assert(page.length === 0, "getConversationThreadPage(scratch conv) → []");

    // Compile-time shape check: the paged helper's elements are structurally
    // identical to the existing thread function's elements.
    const _legacyRows: ConversationThreadRow[] = thread;
    const _pagedRows: ConversationThreadRow[] = page;
    assert(_legacyRows.length === 0 && _pagedRows.length === 0, "thread + paged both empty");

    // Offset/limit clamping paths must not throw (empty result either way).
    const clamped = await q.getConversationThreadPage({
      restaurantId,
      conversationId,
      offset: -5,
      limit: 100000,
    });
    assert(Array.isArray(clamped) && clamped.length === 0, "clamped offset/limit → [] no throw");
    console.log("THREAD-OK: legacy + paged thread empty, element type structurally identical");

    // ── single-row lookups (no match for scratch values) ─────────────────
    const byToken = await q.getRestaurantByLinkToken(`selftest-token-${stamp}`);
    assert(byToken === undefined, "getRestaurantByLinkToken(scratch) → undefined");
    const byJid = await q.findRestaurantByJid("whatsapp", `selftest-jid-${stamp}`);
    assert(byJid === undefined, "findRestaurantByJid(scratch) → undefined");
    console.log("LOOKUP-OK: link-token + jid lookups miss cleanly");

    // ── global/aggregate queries — SHAPE only (prod DB may hold rows) ─────
    const stats = await q.getDashboardStats();
    assert(
      typeof stats.restaurantCount === "number" &&
        typeof stats.linkedCount === "number" &&
        typeof stats.newOrders === "number" &&
        typeof stats.monthSpend === "number" &&
        typeof stats.openErrors === "number",
      "getDashboardStats returns a {*: number} shape"
    );
    const overview = await q.getRestaurantsOverview();
    assert(Array.isArray(overview), "getRestaurantsOverview returns an array");
    if (overview.length > 0) {
      const r = overview[0];
      assert(
        typeof r.id === "string" && typeof r.name === "string" && typeof r.newOrders === "number",
        "getRestaurantsOverview rows carry the dashboard-required fields"
      );
    }
    const recent = await q.getRecentErrors(5);
    assert(Array.isArray(recent), "getRecentErrors returns an array");
    console.log("GLOBAL-OK: dashboard stats / overview / recent-errors shapes verified");

    console.log(`DB-OK: admin query surface read-only (restaurantId=${restaurantId})`);
  } finally {
    await rawClient.end();
  }
}

async function main(): Promise<void> {
  // Next's unstable_cache reads globalThis.AsyncLocalStorage at module
  // evaluation time; tsx does not expose it as a global (Node 24 only exports
  // it from node:async_hooks), which makes Next install a throwing shim. Set it
  // BEFORE the cache-backed query module is evaluated (hence the dynamic import).
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
  const q: Queries = await import("@/lib/queries");

  subscriptionTests(q);
  await dbTests(q);
  console.log("PASS: admin selftest");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});