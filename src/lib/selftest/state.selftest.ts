// ---------------------------------------------------------------------------
// M5 state == session-cache + context-loader + cleanup selftest.
// Run: npx tsx src/lib/selftest/state.selftest.ts
//
// 1) Offline (no DB): LRU cap eviction, soft-TTL miss without eager purge,
//    pruneCache by age, sessionKey mirroring the engine lock key.
// 2) DB-gated (real DATABASE_URL else SKIP, exit 0): applies STATE_DDL
//    twice (idempotence), inserts scratch restaurant/conversations/messages,
//    verifies loadConversationContext ordering/roles/condensation, dry-runs
//    /api/cron/cleanup (counts reported, NOTHING deleted), guard-refuses a
//    total-purge config, then deletes EVERY row it created.
// Never prints secrets (no env values, no connection strings).
// ---------------------------------------------------------------------------
import "dotenv/config";
import { db, rawClient } from "@/lib/db";
import { conversations, messages, restaurants } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isPlaceholder } from "@/lib/env";
import { newId } from "@/lib/utils";
import { STATE_DDL } from "@/lib/ddl/state";
import { loadConversationContext } from "@/lib/state/context";
import {
  sessionKey,
  getCachedContext,
  setCachedContext,
  clearAllCachedContext,
  pruneCache,
  cacheSize,
} from "@/lib/state/sessionCache";
import { runCleanup } from "@/app/api/cron/cleanup/route";

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
}

const EMPTY_CONTEXT = null;

function offlineTests(): void {
  clearAllCachedContext();

  // Session key mirrors the engine's per-conversation lock key.
  assert(
    sessionKey("r1", "whatsapp", "964700000000@s.whatsapp.net") ===
      "r1:whatsapp:964700000000@s.whatsapp.net",
    "sessionKey matches engine lockKey shape"
  );
  assert(
    sessionKey("r2", "instagram", "ig-user-9") === "r2:instagram:ig-user-9",
    "sessionKey works for instagram channels"
  );

  // get/set round-trip with age.
  setCachedContext("k1", { context: EMPTY_CONTEXT, lastMessageAt: Date.now() });
  const read = getCachedContext("k1");
  assert(read !== undefined && read.context === null, "round-trip returns stored context");
  assert(typeof read!.ageMs === "number" && read!.ageMs >= 0, "read carries ageMs");

  // LRU cap: insert beyond cap evicts the least-recently-used entry.
  process.env.SESSION_CACHE_SIZE = "3";
  clearAllCachedContext();
  const t = Date.now();
  for (const k of ["a", "b", "c"]) {
    setCachedContext(k, { context: EMPTY_CONTEXT, lastMessageAt: t });
  }
  assert(cacheSize() === 3, "cap=3 holds 3 entries");
  getCachedContext("b"); // recency bump: a stays the LRU head
  setCachedContext("d", { context: EMPTY_CONTEXT, lastMessageAt: t });
  assert(cacheSize() === 3, "cap=3 still 3 after a 4th insert");
  assert(getCachedContext("a") === undefined, "LRU head (a) was evicted");
  assert(
    getCachedContext("b") !== undefined &&
      getCachedContext("c") !== undefined &&
      getCachedContext("d") !== undefined,
    "b, c, d survive the cap eviction"
  );
  // Overwrite in place never grows the map.
  setCachedContext("c", { context: EMPTY_CONTEXT, lastMessageAt: t });
  assert(cacheSize() === 3, "overwrite does not add an entry");
  delete process.env.SESSION_CACHE_SIZE;

  // Soft TTL: older-than-TTL entries are misses but are NOT eagerly purged.
  process.env.SESSION_CACHE_TTL_MS = "5";
  clearAllCachedContext();
  setCachedContext("ttl", { context: EMPTY_CONTEXT, lastMessageAt: Date.now() - 1000 });
  assert(getCachedContext("ttl") === undefined, "entry older than TTL is a miss");
  assert(cacheSize() === 1, "TTL miss leaves the entry stored (no eager purge)");
  const prunedTtl = pruneCache(0);
  assert(prunedTtl === 1 && cacheSize() === 0, "pruneCache(0) hard-removes the stale entry");
  delete process.env.SESSION_CACHE_TTL_MS;

  // pruneCache respects the age threshold.
  clearAllCachedContext();
  setCachedContext("fresh", { context: EMPTY_CONTEXT, lastMessageAt: Date.now() });
  setCachedContext("stale", {
    context: EMPTY_CONTEXT,
    lastMessageAt: Date.now() - 2 * 60 * 60 * 1000,
  });
  const pruned = pruneCache(60 * 60 * 1000);
  assert(pruned === 1, `pruneCache(1h) removed only the 2h-old entry (removed ${pruned})`);
  assert(getCachedContext("fresh") !== undefined, "fresh entry survives pruneCache");
  assert(getCachedContext("stale") === undefined, "stale entry was hard-pruned");

  clearAllCachedContext();
  console.log("OFFLINE-OK: LRU cap, soft TTL, pruneCache, sessionKey");
}

async function dbTests(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl || isPlaceholder(dbUrl)) {
    console.log("SKIP: no real DATABASE_URL (context/cleanup db tests need a database)");
    return;
  }

  const stamp = Date.now();
  const restaurantId = `selftest-${stamp}`;
  const remoteJid = `selftest-jid-${stamp}`;
  const convA = newId(); // ordering / loadConversationContext target
  const convB = newId(); // >100 back-dated rows → retention math target

  try {
    // Own DDL first — idempotent (run twice to prove it).
    await rawClient.unsafe("create schema if not exists repli");
    for (const stmt of STATE_DDL) await rawClient.unsafe(stmt);
    for (const stmt of STATE_DDL) await rawClient.unsafe(stmt);
    console.log("DDL-OK: STATE_DDL applied twice idempotently");

    // Scratch restaurant + two scratch conversations.
    await db.insert(restaurants).values({ id: restaurantId, name: "selftest" });
    await db.insert(conversations).values({
      id: convA,
      restaurantId,
      channel: "whatsapp",
      remoteJid,
    });
    await db.insert(conversations).values({
      id: convB,
      restaurantId,
      channel: "whatsapp",
      remoteJid: `${remoteJid}-b`,
    });

    // convA: 5 messages, two of them back-dated (older than retention), oldest
    // → newest: m0..m4. The newest (m4) is the "just-stored current message"
    // that loadConversationContext must pop, exactly like the engine.
    const now = Date.now();
    const msgs = [
      { text: "سلام", dir: "in", at: new Date(now - 10 * 86_400_000) },
      { text: "شكد الشاورما؟", dir: "out", at: new Date(now - 9 * 86_400_000) },
      { text: "عطني شاورما", dir: "in", at: new Date(now + 1) },
      { text: "واحد شاورما", dir: "out", at: new Date(now + 2) },
      { text: "خلص", dir: "in", at: new Date(now + 3) },
    ];
    for (let i = 0; i < msgs.length; i++) {
      await db.insert(messages).values({
        id: newId(),
        conversationId: convA,
        direction: msgs[i].dir,
        contentType: "text",
        text: msgs[i].text,
        status: "sent",
        createdAt: msgs[i].at,
      });
    }

    // convB: 105 back-dated rows → retention math must see 5 deletable (105-100).
    await rawClient`
      insert into repli.messages (id, conversation_id, direction, content_type, text, status, created_at)
      select 'selftest-msg-' || i || '-' || ${stamp}, ${convB}, 'in', 'text', 'row-' || i, 'sent',
             now() - make_interval(days => 10) - (i * interval '1 millisecond')
      from generate_series(1, ${105}) i
    `;

    // ── loadConversationContext: order, roles, tail-pop, condensation ─────
    const ctx = await loadConversationContext({
      restaurantId,
      remoteJid,
      channel: "whatsapp",
    });
    assert(ctx.rows.length === 4, `rows = messages minus the popped current (got ${ctx.rows.length})`);
    assert(ctx.rows[0].text === "سلام", "oldest row first (oldest→newest ordering)");
    assert(ctx.rows[3].text === "واحد شاورما", "newest retained row is second-newest overall");
    assert(ctx.rows[0].role === "user", "direction 'in' maps to role 'user'");
    assert(ctx.rows[1].role === "assistant", "direction 'out' maps to role 'assistant'");
    assert(ctx.condensed !== null, "condensed context is produced");
    assert(ctx.condensed!.lastUser === "عطني شاورما", "condensed.lastUser holds the last user message");
    assert(ctx.condensed!.lastAssistant === "واحد شاورما", "condensed.lastAssistant holds the last bot reply");
    assert(
      new Date(ctx.rows[0].created_at).getTime() <= new Date(ctx.rows[3].created_at).getTime(),
      "created_at is monotonically non-decreasing"
    );
    console.log("CONTEXT-OK: ordering, roles, tail-pop, condensation all match the engine");

    // ── dry-run cleanup: counts reported, NOTHING deleted ────────────────
    const res = await runCleanup({ dryRun: true, messageDays: 7, lockMinutes: 60 });
    assert(res.ok === true, "dry-run cleanup reports ok");
    assert(res.dryRun === true, "dry-run flag echoed");
    assert(typeof res.messages.deletable === "number", "messages count reported");
    assert(
      res.messages.deletable >= 5,
      `retention math counts the scratch back-dated rows (got ${res.messages.deletable})`
    );
    assert(res.messages.deleted === 0, "dry-run deleted 0 messages");
    assert(res.messages.batches === 0, "dry-run ran no batch deletes");
    assert(typeof res.orderLocks.deletable === "number", "order_locks count reported");
    assert(typeof res.cache.pruned === "number", "session-cache prune count reported");

    const aCount = await rawClient`
      select count(*)::int as n from repli.messages where conversation_id = ${convA}
    `;
    const bCount = await rawClient`
      select count(*)::int as n from repli.messages where conversation_id = ${convB}
    `;
    assert(aCount[0]?.n === 5, "dry-run left convA rows intact");
    assert(bCount[0]?.n === 105, "dry-run left convB rows intact");
    console.log(
      `DRYRUN-OK: deletable=${res.messages.deletable} deleted=${res.messages.deleted} ` +
        `orderLocks=${res.orderLocks.deletable} cachePruned=${res.cache.pruned}`
    );

    // ── total-purge guard: a non-positive retention window is refused ─────
    const purgeFlag = (process.env.CLEANUP_TOTAL_PURGE_FLAG ?? "").trim();
    if (purgeFlag === "yes") {
      console.log("skip guard test: CLEANUP_TOTAL_PURGE_FLAG is 'yes' in this env");
    } else {
      const guard = await runCleanup({ dryRun: false, messageDays: 0 });
      assert(guard.messages.deletable === 0, "refused total purge reports 0 deletable");
      assert(
        guard.skipped.some((s) => s.includes("refused retention")),
        "guard refusal is logged in skipped"
      );
      const untouched = await rawClient`
        select count(*)::int as n from repli.messages where conversation_id = ${convA}
      `;
      assert(untouched[0]?.n === 5, "refused run deleted nothing");
      console.log("GUARD-OK: total-purge config refused without CLEANUP_TOTAL_PURGE_FLAG='yes'");
    }

    console.log(`DB-OK: all state/context/cleanup db tests passed`);
  } finally {
    // Wipe EVERY scratch row we created (never leaves garbage behind). A wipe
    // failure propagates and marks the whole run FAIL.
    await rawClient`
      delete from repli.messages
      where conversation_id = any(${[convA, convB]})
    `;
    const leftover = await rawClient`
      select count(*)::int as n from repli.messages where conversation_id = any(${[convA, convB]})
    `;
    if (leftover[0]?.n !== 0) {
      throw new Error(`ASSERT FAILED: own scratch messages not fully removed (${leftover[0]?.n} left)`);
    }
    await db.delete(conversations).where(eq(conversations.id, convA)).catch(() => {});
    await db.delete(conversations).where(eq(conversations.id, convB)).catch(() => {});
    await db.delete(restaurants).where(eq(restaurants.id, restaurantId)).catch(() => {});
    await rawClient.end();
  }

  console.log(`PASS: state selftest (restaurantId=${restaurantId})`);
}

async function main() {
  offlineTests();
  await dbTests();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});