// ---------------------------------------------------------------------------
// M2 ingest == durable-dedup selftest. Run: npx tsx src/lib/selftest/ingest.selftest.ts
// Gates on a REAL DATABASE_URL (missing/placeholder → SKIP, exit 0). Applies
// the module DDL idempotently, exercises isDuplicateIngest / dir buildHelpers /
// pruneOldIngest against scratch keys, then wipes every row it created.
// Never prints secrets.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { rawClient } from "@/lib/db";
import { isPlaceholder } from "@/lib/env";
import { INGEST_DDL } from "@/lib/ddl/ingest";
import {
  isDuplicateIngest,
  pruneOldIngest,
  dedupKeyForWhatsApp,
  dedupKeyForInstagram,
} from "@/lib/ingest/dedup";

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl || isPlaceholder(dbUrl)) {
    console.log("SKIP: no real DATABASE_URL (dedup selftest needs a database)");
    return;
  }

  const restaurantId = `selftest-${Date.now()}`;
  const remoteJid = `selftest-jid-${Date.now()}`;
  const keys: string[] = [];

  try {
    // Own schema first (idempotent); the repli schema exists from the baseline.
    await rawClient.unsafe(`create schema if not exists repli`);
    for (const stmt of INGEST_DDL) {
      await rawClient.unsafe(stmt);
    }

    // 1) Duplicate semantics: false first time, true second time (same key).
    const midKey = dedupKeyForWhatsApp({
      messageId: `selftest-mid-${Date.now()}`,
      restaurantId,
      remoteJid,
      text: "hello",
    });
    keys.push(midKey);
    assert(/^wa:/.test(midKey), "mid key carries 'wa:' prefix");
    const first = await isDuplicateIngest(midKey);
    assert(first === false, `first insert is fresh (got ${first})`);
    const second = await isDuplicateIngest(midKey);
    assert(second === true, `re-insert is a duplicate (got ${second})`);

    // 2) Hashed (no-messageId) key scheme for WhatsApp.
    const hashKey = dedupKeyForWhatsApp({
      restaurantId,
      remoteJid,
      text: "mena nishtar",
    });
    keys.push(hashKey);
    const hashTail = hashKey.slice(`wa:${restaurantId}:`.length);
    assert(
      hashKey.startsWith(`wa:${restaurantId}:`) && /^[0-9a-f]{64}$/.test(hashTail),
      `hashed key is 'wa:<restaurantId>:<sha256>' (${hashKey.slice(0, 24)}…)`
    );
    assert(await isDuplicateIngest(hashKey) === false, "hashed key is fresh");

    // 3) Instagram helper uses the 'ig:' scheme (mid + hashed forms).
    const igMidKey = dedupKeyForInstagram({
      messageId: `igmid-${Date.now()}`,
      restaurantId,
      remoteJid,
      text: "hi",
    });
    keys.push(igMidKey);
    assert(igMidKey.startsWith("ig:"), "instagram mid key starts with 'ig:'");
    const igHashKey = dedupKeyForInstagram({
      restaurantId,
      remoteJid,
      text: "مرحبا",
    });
    keys.push(igHashKey);
    assert(igHashKey.startsWith("ig:"), "instagram hashed key starts with 'ig:'");
    assert(await isDuplicateIngest(igMidKey) === false, "instagram mid key is fresh");

    // 4) pruneOldIngest: fresh keys survive, back-dated scratch key is removed.
    const oldKey = dedupKeyForWhatsApp({
      messageId: `prune-${Date.now()}`,
      restaurantId,
      remoteJid,
      text: "prune",
    });
    keys.push(oldKey);
    assert(await isDuplicateIngest(oldKey) === false, "old key inserted fresh");
    await rawClient`
      update repli.ingest_dedup
      set created_at = now() - interval '20 minutes'
      where message_key = ${oldKey}
    `;
    // Window 16 > 15min TTL default but < my 20-min-old scratch row, so fresh
    // production keys (≤15 min) are untouched and stale ones are prune-eligible
    // exactly as normal operation would.
    const deleted = await pruneOldIngest(16);
    assert(deleted >= 1, `pruneOldIngest deleted at least 1 (got ${deleted})`);
    const oldStillThere = await rawClient`
      select 1 from repli.ingest_dedup where message_key = ${oldKey}
    `;
    assert(oldStillThere.length === 0, "back-dated key was pruned");
    const freshStillThere = await rawClient`
      select 1 from repli.ingest_dedup where message_key = ${midKey}
    `;
    assert(freshStillThere.length === 1, "fresh key survived the prune");
  } finally {
    // Wipe every scratch row + key we created (never leaves garbage behind).
    // A cleanup failure propagates and marks the run FAIL.
    await rawClient`
      delete from repli.ingest_dedup
      where message_key = any(${keys}) or restaurant_id like ${`selftest-%`}
    `;
    await rawClient.end();
  }

  console.log(
    `PASS: dedup selftest (restaurantId=${restaurantId} keys=${keys.length})`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});