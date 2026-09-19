# PHASE 3 — Combiner Report

Authoritative companion to `docs/PHASE1_PLAN.md`. Records what was integrated, how it was verified, the known ambiguities, and the exact rollback procedure.

## 1. What was delivered

All 10 Phase-2 modules (M1–M10) integrated into the platform and gateway. The architecture now has three new resilience layers:

| Layer | Modules | Files |
|---|---|---|
| Ingestion dedup | M2 | `src/lib/ingest/dedup.ts`, webhook routes, `INGEST_DDL` |
| Durable job queue (WhatsApp only) | M3 | `src/lib/queue/*`, `/api/jobs/{run,result,ack,pending}`, `JOBS_DDL` |
| AI resilience | M4 | `src/lib/ai/client.ts` (per-key cooldown, rotation) |
| State + retention | M5 | `src/lib/state/*`, cron cleanup, `STATE_DDL` |
| Vision cache | M6 | `src/lib/vision/*`, media route, `VISION_DDL` |
| DB reliability | M7 | `src/lib/db/raw.ts` (hardened pool), `db/reliability.ts` |
| Gateway delivery + outbox | M8, M1 | `gateway/src/deliver.ts`, `queueClient.ts`, `conn/*`, health route |
| Monitoring | M9 | `src/lib/monitoring/*`, `/api/health`, `/api/cron/healthcheck` |
| Admin perf | M10 | `src/lib/queries.ts`, `src/app/admin/actions.ts`, `ADMIN_DDL` |

## 2. Integration decisions made by the Combiner

1. **M2→M3 contract** (`src/app/api/webhooks/message/route.ts`): the webhook calls `enqueueMessageJob(buildIncomingMessageInput(body))` — the FLAT payload shape mandated by plan line 103. The one platform typecheck error (wrapped vs flat) was resolved in M2's favor.
2. **Outbox loop** (`gateway/src/index.ts`): `startOutboxLoop(() => sessions)` started in `app.listen`, `cancelOutboxLoop()` in shutdown, timers cleared.
3. **DDL concatenation** (`src/lib/db/migrate.ts`): `MODULE_DDL` now appends all 8 module DDL arrays to `POST_BASELINE_DDL`, applied by `applyModuleStatements()` (idempotent, tolerates `already exists`). `src/instrumentation.ts` runs it on cold start; a migration hiccup logs and does not crash.
4. **Instagram stays inline** (per plan §Scope): only WhatsApp enters the queue.
5. **`engine.ts`, `prompt.ts`, `summary.ts`, `schema.ts`, UI files `src/app/admin/**` + `src/components/**` untouched** (hard constraints honored). No worker edited the engine; only additive modules were built around it.

## 3. Verification results

| Check | Result |
|---|---|
| Platform `npx tsc --noEmit` | EXIT 0 |
| Gateway `npm run typecheck` | EXIT 0 |
| `npm run lint` (platform) | Only pre-existing baseline issues (2 errors in `src/components/**` which are hard-constrained untouchable, + pre-existing warnings in `ai/client.ts:755`, `telegram.ts`); no worker-introduced errors |
| Platform selftests | queue, ingest, state, vision, ai, reliability, admin, monitoring — all PASS against the real Supabase DB |
| Gateway selftests | `selftest-conn.ts` PASS; `selftest-delivery.ts` PASS (cases A literal/branch, ready+poll+ack, failed→fallback+ack, timeout+connected, timeout+socket-down, duplicate) |
| E2E trace (scratch restaurant, mocked AI, real DB) | 17/17 PASS: enqueue accepted → duplicate resend same jobId → claim w/ lease → result stored → poll ready → pending scan → ack delivered→sent → second ack refused → ack expired→expired → fresh messageId enqueues. Scratch rows cleaned up |

A **fix** was applied during integration: `src/lib/selftest/queue.selftest.ts` used `import { config } from "dotenv"; config();` AFTER its imports, so `src/lib/db/raw.ts` read `DATABASE_URL` before dotenv injected it and fell back to `localhost:5432` → persistent false SKIP. Changed to `import "dotenv/config"` (same as all other selftests) — then PASS.

## 4. Known ambiguities / follow-ups

- **Hotfix (post-deploy, production symptom): the job queue had NO executor.** The webhook enqueues and returns `{accepted, jobId}`, but nothing triggered `POST /api/jobs/run` — every job sat `queued` forever, the poll budget (55s) burned out, and every customer saw `FALLBACK_REPLY_GENERIC` ("عذراً صار تعطل بسيط بالخادم…"). Fix (deployed in the following commit):
  - **M3**: `claimQueuedJob(restaurantId, leaseSeconds, jobId?)` + `runNextJob(restaurantId, jobId?)` + `POST /api/jobs/run` now accept an optional targeted `jobId` so the gateway claims the exact job it just enqueued (never an older one).
  - **M8 (gateway)**: `deliverJob` now fires `POST /api/jobs/run {restaurantId, jobId}` whenever the polled job is not yet `processing`/`sending` and the last trigger is stale — a dropped trigger or network blip self-heals instead of stranding the job. `selftest-delivery.ts` gained case G asserting the run trigger fires for a `queued` job.
  - **Outbox**: each sweep now fires a best-effort `POST /api/jobs/run` for connected sessions before scanning `/api/jobs/pending`, so jobs enqueued right before a gateway restart are still executed.
- **Wiring of M5 sessionCache + M6 visionCache into the engine is NOT done.** Both modules are built and self-tested but the engine (`engine.ts`, Combiner-owned) still uses its own context loading. Wiring them is a separate, safe follow-up (additive reads), but it was consciously deferred to avoid touching the frozen engine in this pass. Documented here per plan §progress expectations.
- **M1 flagged**: retryable disconnects reconnect quietly through the new tracker (no status flap) — an intentional interpretation. It makes the health/reconnect surface calmer; if you want status flapping on retryable closes, that is a one-line change in `gateway/src/conn/state.ts`.
- **`WEBHOOK_MODE=sync`** (rollback flag) restores the legacy inline engine call + byte-for-byte response shape; gateway's `deliver()` deals with both shapes. Verified unset in all environment files (async active).

## 5. Rollback procedure

Set on the platform env: `WEBHOOK_MODE=sync` (documented in plan §5). This re-enables the legacy inline path in `src/app/api/webhooks/message/route.ts` — the gateway immediately gets inline replies and the queue is bypassed. All DDL is additive, so a full revert is a `git revert` of the code; optional schema cleanups (new tables/indexes added by this work):

```sql
-- Tables created (module DDL). Drop AFTER code revert if desired:
drop table if exists repli.message_jobs;
drop table if exists repli.vision_cache;
drop table if exists repli.ingest_dedup;

-- Indexes created (additive, non-destructive):
--   repli.messages_expire_idx
--   repli.orders_restaurant_status_created_idx
--   repli.error_logs_created_idx
-- (leave indexes; drop only if the revert removes the queries that use them)
```

Deploy order (as planned): platform first (schema via instrumentation), then gateway. Keep-alive + `/api/health` as canary.