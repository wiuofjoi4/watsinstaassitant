// ---------------------------------------------------------------------------
// M3 job queue self-test. Hermetic: exercises enqueue dedup, the claim/complete
// SQL and the result mapping WITHOUT the live AI (claim -> storeJobResult
// drives the exact SQL the /api/jobs/run route uses on success). Requires a
// real DATABASE_URL; otherwise SKIP + exit 0. All scratch rows are deleted.
//   run: npx tsx src/lib/selftest/queue.selftest.ts
// ---------------------------------------------------------------------------
import "dotenv/config";

import { isPlaceholder } from "@/lib/env";

if (!hasRealDatabaseUrl(process.env.DATABASE_URL)) {
  console.log("SKIP: queue.selftest requires a real DATABASE_URL");
  process.exit(0);
}

import type { IncomingMessageInput } from "@/lib/agent/engine";
import { rawClient } from "@/lib/db";
import { JOBS_DDL } from "@/lib/ddl/jobs";
import {
  enqueueMessageJob,
  parseResultJson,
  queueDepth,
  stuckCount,
} from "@/lib/queue/client";
import {
  acknowledgeJob,
  claimQueuedJob,
  messageJobFromRow,
  storeJobError,
  storeJobResult,
} from "@/lib/queue/rows";

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
 * an environmental SKIP, not a queue defect. */
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
  const text =
    `${codes} ${err instanceof Error ? err.message : ""}`.toLowerCase();
  return /econnrefused|econnreset|etimedout|enotfound|ehostunreach|epipe|connect_timeout/.test(
    text
  );
}

const rid = `selftest-${Date.now()}`;
const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
};

function jobInput(
  messageId: string,
  remoteJid: string,
  text = "selftest"
): IncomingMessageInput {
  return {
    restaurantId: rid,
    channel: "whatsapp",
    remoteJid,
    customerName: null,
    contentType: "text",
    text,
    messageId,
  };
}

async function main(): Promise<void> {
  // DDL is idempotent — run twice. If the DB is unreachable at all, SKIP
  // (connection refused/timeout is environmental, not a queue defect).
  for (const stmt of JOBS_DDL) {
    try {
      await rawClient.unsafe(stmt);
    } catch (err) {
      if (isConnectError(err)) {
        console.log("SKIP: queue.selftest could not reach DATABASE_URL");
        process.exit(0);
      }
      throw err;
    }
  }
  for (const stmt of JOBS_DDL) await rawClient.unsafe(stmt);
  const rel = await rawClient`select to_regclass('repli.message_jobs') as rel`;
  check(rel[0]?.rel != null, "message_jobs table not created");

  const a1 = await enqueueMessageJob(jobInput("mid-1", "964700000000001"));
  check(!a1.duplicate, "first enqueue must insert");
  const a2 = await enqueueMessageJob(jobInput("mid-1", "964700000000001"));
  check(a2.duplicate, "same messageId must dedup");
  check(a2.jobId === a1.jobId, "duplicate must return the same id");

  await enqueueMessageJob(jobInput("mid-2", "964700000000002"));

  const claimed = await claimQueuedJob(rid);
  check(claimed != null, "claim must return a queued job");
  check(claimed?.status === "processing", "claimed must be processing");
  check(claimed?.leaseToken != null, "claimed must carry a lease");

  const ready = await storeJobResult(
    claimed!.id,
    claimed!.leaseToken!,
    JSON.stringify({ replyText: "selftest-reply", model: "selftest" })
  );
  check(ready?.status === "ready", "stored result must be ready");
  check(ready?.attempts === 1, "attempts must increment on success");
  check(ready?.error == null, "error must be cleared on success");

  // Same SQL + mapper the /api/jobs/result endpoint uses.
  const readRows = await rawClient`
    select * from repli.message_jobs where id = ${claimed!.id} limit 1
  `;
  const mapped = messageJobFromRow(readRows[0]);
  const parsed = parseResultJson(mapped.resultJson);
  check(mapped.status === "ready", "result read must see ready");
  check(parsed?.replyText === "selftest-reply", "result read must parse replyText");

  const claimedB = await claimQueuedJob(rid);
  check(claimedB != null, "second claim must return the remaining job");
  const failed = await storeJobError(
    claimedB!.id,
    claimedB!.leaseToken!,
    "selftest: boom"
  );
  check(failed?.status === "failed", "stored error must mark failed");
  check(failed?.error === "selftest: boom", "failed must carry the error text");

  const drained = await claimQueuedJob(rid);
  check(drained == null, "claim with empty queue must return null");
  check((await queueDepth(rid)) === 0, "scratch queue depth must be 0");
  check(typeof (await stuckCount()) === "number", "stuckCount must be a number");

  await enqueueMessageJob(jobInput("mid-3", "964700000000003"));
  const ackJob = await claimQueuedJob(rid);
  await storeJobResult(
    ackJob!.id,
    ackJob!.leaseToken!,
    JSON.stringify({ replyText: "ack me" })
  );
  check(await acknowledgeJob(ackJob!.id, "delivered"), "ack delivered must mutate");
  const sentRows = await rawClient`
    select status from repli.message_jobs where id = ${ackJob!.id}
  `;
  check(sentRows[0]?.status === "sent", "acked job must be sent");
  check(
    !(await acknowledgeJob(ackJob!.id, "delivered")),
    "re-ack on sent must not mutate"
  );
  check(
    !(await acknowledgeJob(ackJob!.id, "expired")),
    "expired ack on sent must not mutate"
  );

  await enqueueMessageJob(jobInput("mid-4", "964700000000004"));
  const expireJob = await claimQueuedJob(rid);
  await storeJobResult(
    expireJob!.id,
    expireJob!.leaseToken!,
    JSON.stringify({ replyText: "expire me" })
  );
  check(
    await acknowledgeJob(expireJob!.id, "expired"),
    "ack expired must mutate ready -> expired"
  );
  check(
    !(await acknowledgeJob(expireJob!.id, "delivered")),
    "delivered ack on expired must not mutate"
  );

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
}

(async () => {
  let ok = false;
  try {
    await main();
    ok = true;
  } catch (err) {
    console.error(
      `FAIL queue.selftest: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    try {
      await rawClient`delete from repli.message_jobs where restaurant_id = ${rid}`;
    } catch {
      // best-effort cleanup
    }
  }
  if (ok) console.log(`PASS queue.selftest (scratch=${rid})`);
  process.exit(ok ? 0 : 1);
})();