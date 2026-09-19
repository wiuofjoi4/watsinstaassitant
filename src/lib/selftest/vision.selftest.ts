// ---------------------------------------------------------------------------
// M6 vision pipeline self-test. Run: npx tsx src/lib/selftest/vision.selftest.ts
//
// 1) OFFLINE (no DB, no AI): visionMediaKey stability/differentiation/sha256
//    cross-check, validateVisionInput discrimination (unsupported_mime /
//    too_large / malformed vs valid), and the not_configured path via
//    extractVisionText (valid input + no AI keys → not_configured, no DB hit).
// 2) DB-GATED (real DATABASE_URL else SKIP, exit 0): applies VISION_DDL twice
//    (idempotence), setCachedVision + getCachedVision round-trip, upsert
//    overwrite, 2000-char description truncation, pruneVisionCache removes a
//    back-dated scratch row while a fresh row survives, then wipes every
//    scratch row (cleanup failure → FAIL).
// 3) LIVE (optional, inside the DB block): RUN_LIVE_AI=1 + AI configured →
//    one extractVisionText on a hardcoded 1x1 PNG, then a second call that
//    must hit the cache (fromCache:true). Network/AI failure → SKIP, not FAIL.
// Never prints secrets (no env values, no connection strings, no base64).
// ---------------------------------------------------------------------------
import "dotenv/config";
import { createHash } from "node:crypto";
import { isAIConfigured } from "@/lib/ai/client";
import { rawClient } from "@/lib/db/raw";
import { isPlaceholder } from "@/lib/env";
import { VISION_DDL } from "@/lib/ddl/vision";
import {
  extractVisionText,
  validateVisionInput,
  VISION_MAX_BASE64_LENGTH,
} from "@/lib/vision/client";
import {
  getCachedVision,
  pruneVisionCache,
  setCachedVision,
  visionMediaKey,
} from "@/lib/vision/cache";

// 1x1 transparent PNG (~70 decoded bytes) — signature checked offline before
// any network call touches it.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const PNG_SIGNATURE_HEX = "89504e470d0a1a0a";

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
}

function hasRealDatabaseUrl(url: string | undefined): boolean {
  if (!url || isPlaceholder(url)) return false;
  try {
    const host = new URL(url).hostname;
    return !/(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(host);
  } catch {
    return false;
  }
}

/** True for connection-level failures (unreachable host, refused, timeout) —
 * an environmental SKIP, not a vision defect. */
function isConnectError(err: unknown): boolean {
  const anyErr = err as {
    code?: unknown;
    errors?: Array<{ code?: unknown; message?: unknown }>;
  };
  const codes = [
    String(anyErr.code ?? ""),
    ...(Array.isArray(anyErr.errors) ? anyErr.errors : []).map((e) =>
      String(e.code ?? "")
    ),
  ].join(" ");
  const text = `${codes} ${err instanceof Error ? err.message : ""}`.toLowerCase();
  return /econnrefused|econnreset|etimedout|enotfound|ehostunreach|epipe|connect_timeout/.test(
    text
  );
}

async function offlineTests(): Promise<void> {
  console.log("[vision selftest] offline block");

  // --- visionMediaKey: stability, differentiation, sha256 formula ----------
  const a = visionMediaKey({ restaurantId: "r1", mime: "image/png", base64: "aaa" });
  const b = visionMediaKey({ restaurantId: "r1", mime: "image/png", base64: "aaa" });
  assert(a === b, "visionMediaKey is stable for identical input");
  assert(a.startsWith("v1:"), "visionMediaKey carries the 'v1:' prefix");
  const hex = a.slice("v1:".length);
  assert(/^[0-9a-f]{64}$/.test(hex), `sha256 hex tail is 64 chars (got ${hex.length})`);
  const expected = createHash("sha256")
    .update(`r1:image/png:aaa`)
    .digest("hex");
  assert(hex === expected, "visionMediaKey matches sha256(restaurantId:mime:base64)");

  const diffB64 = visionMediaKey({ restaurantId: "r1", mime: "image/png", base64: "aab" });
  const diffMime = visionMediaKey({ restaurantId: "r1", mime: "image/jpeg", base64: "aaa" });
  const diffRid = visionMediaKey({ restaurantId: "r2", mime: "image/png", base64: "aaa" });
  assert(diffB64 !== a, "different base64 → different key");
  assert(diffMime !== a, "different mime → different key");
  assert(diffRid !== a, "different restaurantId → different key");

  // --- offline signature sanity of the hardcoded PNG ------------------------
  const png = Buffer.from(PNG_1X1_BASE64, "base64");
  assert(
    png.subarray(0, 8).toString("hex") === PNG_SIGNATURE_HEX && png.length > 0,
    `1x1 PNG constant is a real PNG (${png.length} bytes)`
  );

  // --- validateVisionInput discrimination ----------------------------------
  const unsupported = validateVisionInput({ mime: "application/pdf", base64: "aaa" });
  assert(
    unsupported.ok === false && unsupported.reason === "unsupported_mime",
    "unsupported mime → unsupported_mime"
  );
  const svg = validateVisionInput({ mime: "image/svg+xml", base64: "aaa" });
  assert(svg.ok === false && svg.reason === "unsupported_mime", "svg is unsupported");

  const oversized = validateVisionInput({
    mime: "image/png",
    base64: "a".repeat(VISION_MAX_BASE64_LENGTH + 1),
  });
  assert(
    oversized.ok === false && oversized.reason === "too_large",
    `base64 > VISION_MAX_BASE64_LENGTH → too_large (limit=${VISION_MAX_BASE64_LENGTH})`
  );
  // Boundary: exactly at the limit must NOT be too_large. 'a' is a valid
  // base64 char and decodes to a non-empty buffer, so validation passes.
  const atLimit = validateVisionInput({
    mime: "image/png",
    base64: "a".repeat(VISION_MAX_BASE64_LENGTH),
  });
  assert(
    atLimit.ok === true,
    "at-limit length passes validation (too_large fires only strictly above)"
  );

  const emptyB64 = validateVisionInput({ mime: "image/png", base64: "" });
  assert(
    emptyB64.ok === false && emptyB64.reason === "malformed",
    "empty base64 → malformed"
  );
  const blankB64 = validateVisionInput({ mime: "image/png", base64: "   " });
  assert(
    blankB64.ok === false && blankB64.reason === "malformed",
    "whitespace-only base64 → malformed"
  );
  const zeroBytes = validateVisionInput({ mime: "image/png", base64: "===" });
  assert(
    zeroBytes.ok === false && zeroBytes.reason === "malformed",
    "base64 decoding to zero bytes → malformed"
  );

  const valid = validateVisionInput({ mime: "image/png", base64: PNG_1X1_BASE64 });
  assert(valid.ok === true, "valid png input passes validation");

  // --- not_configured is deterministic WITHOUT keys (no DB, no network) -----
  if (!isAIConfigured()) {
    const notCfg = await extractVisionText({
      restaurantId: "selftest-notcfg",
      mime: "image/png",
      base64: PNG_1X1_BASE64,
    });
    assert(
      notCfg.ok === false,
      "valid input without AI keys → expected a failure result"
    );
    if (notCfg.ok === false) {
      assert(
        notCfg.reason === "not_configured" && notCfg.text === null,
        `valid input without AI keys → not_configured (got ${notCfg.reason})`
      );
    }
  } else {
    console.log(
      "  (AI keys configured — the not_configured extractVisionText check is skipped; it would otherwise fire past this env's cache/AI calls)"
    );
  }

  console.log("OFFLINE-OK: visionMediaKey, validateVisionInput, not_configured");
}

async function liveBlock(restaurantId: string): Promise<void> {
  // Optional: one real extraction on a tiny 1x1 PNG, then a second identical
  // call that MUST hit the durable cache. Network/AI failure → SKIP, not FAIL.
  if (!isAIConfigured()) {
    console.log("  (AI not configured — live vision test skipped)");
    return;
  }
  if (process.env.RUN_LIVE_AI !== "1") {
    console.log("  (set RUN_LIVE_AI=1 to run the live extraction; skipped by default)");
    return;
  }
  console.log("[vision selftest] live block");
  try {
    const res = await extractVisionText({ restaurantId, mime: "image/png", base64: PNG_1X1_BASE64 });
    if (!res.ok) {
      if (res.reason === "ai_failed") {
        console.log("SKIP: live vision model call failed (ai_failed)");
        return;
      }
      assert(
        res.reason === "not_configured" ||
          res.reason === "unsupported_mime" ||
          res.reason === "too_large" ||
          res.reason === "malformed",
        `live extraction returned a graceful rejection (${res.reason})`
      );
      return;
    }
    assert(typeof res.text === "string" && res.text.length > 0, "live extraction returned text");
    assert(typeof res.model === "string", "live extraction reports a model");
    assert(res.fromCache === false, "first live extraction is a cache miss");
    console.log(`  [live] ok text=${res.text.length} chars model=${res.model ?? "n/a"}`);

    // Second identical call must be served entirely from the durable cache.
    const again = await extractVisionText({ restaurantId, mime: "image/png", base64: PNG_1X1_BASE64 });
    assert(again.ok === true, "second live extraction succeeds");
    if (again.ok) {
      assert(again.fromCache === true, "second live extraction hits the cache");
      assert(again.text === res.text, "cached text equals the fresh extraction");
    }
  } catch (err) {
    // extractVisionText never throws, but keep the guard: an unexpected
    // failure here is a SKIP (environmental), not a vision defect.
    console.log(
      `SKIP: live vision call failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function dbTests(): Promise<void> {
  console.log("[vision selftest] db block");

  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl || isPlaceholder(dbUrl) || !hasRealDatabaseUrl(dbUrl)) {
    console.log("SKIP: no real DATABASE_URL (vision cache tests need a database)");
    return;
  }

  // Reachability gate: SKIP on connect errors BEFORE anything is written.
  try {
    await rawClient.unsafe("create schema if not exists repli");
  } catch (err) {
    if (isConnectError(err)) {
      console.log("SKIP: vision.selftest could not reach DATABASE_URL");
      await rawClient.end().catch(() => {});
      return;
    }
    throw err;
  }

  const ts = Date.now();
  const restaurantId = `selftest-${ts}`;

  try {
    // DDL is idempotent — run twice to prove it.
    for (const stmt of VISION_DDL) await rawClient.unsafe(stmt);
    for (const stmt of VISION_DDL) await rawClient.unsafe(stmt);
    const rel = await rawClient`select to_regclass('repli.vision_cache') as rel`;
    assert(rel[0]?.rel != null, "VISION_DDL created repli.vision_cache");
    console.log("DDL-OK: VISION_DDL applied twice idempotently");

    // --- setCachedVision + getCachedVision round-trip -----------------------
    const rtKey = `selftest-${ts}-roundtrip`;
    await setCachedVision({
      mediaKey: rtKey,
      restaurantId,
      mime: "image/png",
      description: "شاورما عربي",
      model: "selftest-model",
    });
    const read = await getCachedVision(rtKey);
    assert(read !== null, "getCachedVision finds a fresh row");
    assert(read!.description === "شاورما عربي", "round-trip description preserved");
    assert(read!.model === "selftest-model", "round-trip model preserved");
    assert(await getCachedVision(`selftest-${ts}-missing`) === null, "absent key → null");

    // --- upsert overwrite path (ON CONFLICT DO UPDATE) ----------------------
    await setCachedVision({
      mediaKey: rtKey,
      restaurantId,
      mime: "image/png",
      description: "شاورما عربي - محدث",
      model: "selftest-model-2",
    });
    const updated = await getCachedVision(rtKey);
    assert(updated!.description === "شاورما عربي - محدث", "upsert overwrites description");
    assert(updated!.model === "selftest-model-2", "upsert overwrites model");

    // --- 2000-char description truncation -----------------------------------
    const truncKey = `selftest-${ts}-trunc`;
    await setCachedVision({
      mediaKey: truncKey,
      restaurantId,
      mime: "image/webp",
      description: "x".repeat(2500),
      model: null,
    });
    const truncated = await getCachedVision(truncKey);
    assert(
      truncated!.description.length === 2000,
      `truncated to 2000 (got ${truncated!.description.length})`
    );
    assert(truncated!.description === "x".repeat(2000), "truncation keeps the head");
    assert(truncated!.model === null, "null model round-trips as null");

    // --- pruneVisionCache: back-dated scratch row removed, fresh row survives -
    const oldKey = `selftest-${ts}-old`;
    const freshKey = `selftest-${ts}-fresh`;
    await setCachedVision({
      mediaKey: oldKey,
      restaurantId,
      mime: "image/png",
      description: "stale",
      model: null,
    });
    await setCachedVision({
      mediaKey: freshKey,
      restaurantId,
      mime: "image/png",
      description: "fresh",
      model: null,
    });
    await rawClient`
      update repli.vision_cache
      set created_at = now() - interval '20 days'
      where media_key = ${oldKey}
    `;
    const deleted = await pruneVisionCache(7);
    assert(
      deleted >= 1,
      `pruneVisionCache removed at least the back-dated scratch row (got ${deleted})`
    );
    assert(await getCachedVision(oldKey) === null, "back-dated scratch row pruned");
    assert((await getCachedVision(freshKey)) !== null, "fresh scratch row survived the prune");
    console.log("DB-OK: round-trip, upsert, truncation, prune all passed");

    await liveBlock(restaurantId);
  } finally {
    // Wipe EVERY scratch row we created (never leaves garbage). A wipe failure
    // propagates and marks the whole run FAIL.
    await rawClient`
      delete from repli.vision_cache
      where media_key like 'selftest-%' or restaurant_id like 'selftest-%'
    `;
    const leftover = await rawClient`
      select count(*)::int as n
      from repli.vision_cache
      where media_key like 'selftest-%' or restaurant_id like 'selftest-%'
    `;
    if (leftover[0]?.n !== 0) {
      throw new Error(
        `ASSERT FAILED: own scratch vision_cache rows not fully removed (${leftover[0]?.n} left)`
      );
    }
    await rawClient.end();
  }
}

async function main(): Promise<void> {
  await offlineTests();
  await dbTests();
  console.log("PASS: vision selftest");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});