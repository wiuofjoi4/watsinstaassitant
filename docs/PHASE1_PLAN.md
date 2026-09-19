# Phase 1 — Task Divider / Architecture Plan (source of truth)

Project: WhatsApp/Instagram restaurant-ordering AI agent. Platform (Next.js 16, Vercel) + gateway (Node/Express/Baileys, Render) + Supabase/PgBouncer (transaction pooler, port 6543, schema `repli`).

This document is the authoritative contract for Phase 2 (10 parallel workers) and Phase 3 (Combiner). Workers act ONLY within their file-ownership boundary and follow the shared schemas frozen below.

---

## 1. Current-system audit

### 1.1 Component map

| Layer | Where it runs | Files | Role |
|---|---|---|---|
| Gateway (WhatsApp) | Render, `gateway/` | `gateway/src/index.ts` (823 lines), `gateway/src/auth.ts` | Baileys sockets per restaurant; QR; health; rate-limit; in-memory dedup; media download; webhook push to platform; delivery + pacing |
| Webhooks (platform) | Vercel | `src/app/api/webhooks/message/route.ts`, `.../status/route.ts`, `.../instagram/route.ts` | Ingest from gateway / Meta; call engine |
| Agent engine | Vercel | `src/lib/agent/engine.ts` (1608 lines) | Monolith: DB profile → conversation upsert → store message → transcribe → condense → LLM → order block parse → telegram push → menu images |
| AI orchestration | Vercel | `src/lib/ai/client.ts` | Multi-key/multi-provider failover (openrouter→gemini→openai), per-model cooldown, windowed circuit breaker, model discovery |
| State | Vercel | `src/lib/agent/summary.ts` | `[ORDER_STATE]` block contract, condensation, sanitizer |
| DB | Supabase | `src/lib/db/raw.ts` + `schema.ts` + `migrate.ts` | postgres.js lazy proxy, pool max=2, `prepare:false` (PgBouncer), `conversation_locks` for per-conversation serialization |
| Alerts/Telegram | Vercel | `src/lib/alerts.ts`, `src/lib/telegram.ts` | Spend alerts + order push to owner bot |
| Admin dashboard (EN, unchanged UI) | Vercel | `src/app/admin/*`, `src/lib/queries.ts`, `actions.ts` | English UI; already uses `unstable_cache` + parallel raw SQL |
| Ops | Vercel | `src/app/api/cron/keepalive/route.ts`, `src/app/api/diag/route.ts`, `src/app/api/sync/route.ts`, `.../ai/models/route.ts` | Warm-up, diagnostics, sync, AI self-test |

### 1.2 Known failure points (from code + git history)

1. **Webhook synchronous binding** — `/api/webhooks/message` runs the whole engine inline; Vercel kills it at 60s, gateway aborts at 55s. Slow AI/DB → dangling fetch → `FALLBACK_REPLY_GENERIC` sent while AI later finishes (wasted tokens) or silence. Root cause of "frequent disconnections/silent failures" class of issues.
2. **In-memory dedup only** (gateway `seenMessageIds`, Instagram `seenIgMids`) — broken the moment >1 instance runs; the IG route even documents this. Wake of retries → double AI calls, double replies, duplicate Telegram pushes.
3. **No durable outbox for replies** — if the socket drops between "reply produced" and "message sent", the customer gets nothing and there is no replay/recovery.
4. **Fixed 5s reconnect**, no jitter/backoff; `DisconnectReason` not fully classified (e.g., `badSession`, `connectionReplaced` all just `shouldRetry=true`); hung-socket watchdog is coarse.
5. **DB connection pressure** — pool max=2 per warm lambda × many warm instances; a DB-down window queues every query and blows function budgets; no shared retry-on-disconnect, no per-query timeout, no global concurrency guard.
6. **Token overconsumption** — every image turn re-sends base64 into the model; no extraction cache; menus partially gated; `messages` table grows unbounded; no session expiry/cleanup.
7. **Memory growth** — in-memory dedup/rate-limit maps (cleaned, but per-process duplicates), no LRU bound on hot contexts.
8. **AI chain** — 429 handling is per-model; no per-key rotation within the same model; breaker thresholds fixed; no `Retry-After` header parsing (regex only).
9. **Race: `ensureSession` loop + `startSession` mutex** mostly fixed; `connection.update` close→retry path can still double-fire with the sync loop for the same restaurant.
10. **Monitoring** — `/health` on gateway is good; platform has no aggregate health, no outage alerting beyond QR re-pair, keys could leak in logs (several `console.error` dump raw errors).
11. **Admin latency** — conversation thread limited 200 but full fetch; `getRestaurantDetail` still does `SELECT *`-style wide rows; several sequential awaits remain.

### 1.3 Architecture change (flows stay identical)

Core flow is preserved end-to-end: **QR → WhatsApp/Instagram → AI agent → order → Telegram to owner**. The customer-facing dialect/format is untouched (`prompt.ts` is frozen; emoji-stripping kept; pacing/split-parts kept; graceful Iraqi fallbacks kept).

Two synchronous choke points are replaced by a **fast-ack + durable job queue + outbox**, all DB-backed so it is multi-instance safe:

```
Baileys msg ─▶ gateway parse ─▶ POST /api/webhooks/message ─▶ [M2] validate+dedup ─▶ [M3] enqueueJob ─▶ 202 {jobId}   (fast, <1s)
                                                                          │
                                                                          ▼  (enqueue failed / DB down)
                                                            [M2] SYNC FALLBACK ─▶ engine inline ─▶ reply (legacy path)
gateway worker [M8] ─▶ POST /api/jobs/run (claim) ─▶ [M3] engine ─▶ job.result=reply
gateway [M8] poll GET /api/jobs/result?jobId= ─▶ socket.sendMessage (pacing preserved) ─▶ POST /api/jobs/ack ─▶ job=sent
On socket drop: [M8] resumes `ready/sending` jobs after reconnect (delivery guaranteed).
```

All schema additions are **additive/idempotent** (new tables/indexes/columns via the existing idempotent `POST_BASELINE_DDL` machinery in `migrate.ts`). No breaking migration.

---

## 2. Forced-sequential work detected & resolved

Phase-1 analysis exposed two file-ownership conflicts that would otherwise block parallel execution. They are resolved as follows (NOT silently ignored):

**(A) `gateway/src/index.ts` is one monolith that 4 modules need** (connection, delivery, health). Resolution: the architect performs a **pre-flight MECHANICAL split** (zero logic change) before Phase 2:
- `gateway/src/conn/sessions.ts` — session store + lifecycle primitives (exposes `getSocketRegistry()`, `getSessionsSnapshot()`, `ensureSession()`).
- `gateway/src/conn/backoff.ts` — reconnect backoff policy helpers.
- `gateway/src/deliver.ts` — `deliver()` + `sendFallback()` + fallback texts + pacing (M8 file).
- `gateway/src/routes/health.ts` — `/health` handler (M9 file).
- `gateway/src/index.ts` — Express app + routes + bootstrap, imports the above.

After the split each worker edits only its own file(s); `index.ts` (M1) references frozen exported signatures of M8/M9/M1-conn only.

**(B) `src/lib/agent/engine.ts` is the hub every platform module touches.** Resolution: **Phase-2 workers never edit `engine.ts`** nor `src/lib/agent/prompt.ts` (persona — frozen by hard constraint) nor `src/lib/agent/summary.ts` (order-block dialect contract — frozen). Workers build their modules in NEW files + NEW route handlers. `engine.ts` is refactored ONCE by the Combiner (Phase 3) to call the new modules. `src/lib/db/migrate.ts` is also Combiner-owned: each worker adds schema via its own `src/lib/ddl/<name>.ts` export, which the Combiner concatenates into `POST_BASELINE_DDL`.

---

## 3. The 10 modules — contracts, ownership, dependencies

### Frozen shared types (created before workers, used identically everywhere)

Do NOT redefine these; import them from their existing modules:

| Type / symbol | Location |
|---|---|
| `IncomingMessageInput`, `Channel`, `IncomingContentType`, `AgentOrderResult`, `MenuImage`, `RunResult`, `handleIncomingMessage()`, `jidToPhone()`, `markOutgoingFailed()` | `@/lib/agent/engine` (engine.ts) |
| `AgentReply`, `BusinessProfile`, `buildSystemPrompt()` | `@/lib/agent/prompt` |
| `CondensedContext`, `parseOrderBlock`, `sanitizeOrder`, `condenseMessages`, `renderContextBlock`, `stripOrderBlock`, `ORDER_STATE_OPEN/CLOSE` | `@/lib/agent/summary` |
| `completeWithFallback`, `getAgentModel`, `getProvider`, `isAIConfigured`, `getWhisperClient`, `estimateCostUsd`, `TRANSCRIBE_MODEL`, `Provider`, `KeyLabel` | `@/lib/ai/client` |

### New frozed contract (defined by M3, used by M2/M8)

```ts
// src/lib/queue/types.ts  (M3-owned)
type JobStatus = "queued" | "processing" | "ready" | "sending" | "sent" | "failed" | "expired";
interface IncomingJob {
  id: string; restaurantId: string; channel: "whatsapp"|"instagram"; remoteJid: string;
  messageId: string | null;              // idempotency key (unique per restaurant+channel)
  payload: IncomingMessageInput;         // frozen engine shape
  attempts: number; nextAttemptAt: string; leaseToken: string | null; leaseExpiresAt: string | null;
  status: JobStatus; resultJson: string | null; error: string | null;
  createdAt: string; updatedAt: string; deliveredAt: string | null;
}
// enqueue (idempotent). Returns existing job if messageId already seen (dedup).
enqueueMessageJob(input: IncomingMessageInput): Promise<{ jobId: string; duplicate: boolean }>;
// claim ONE job for a restaurant (atomic, SKIP LOCKED, lease 45s). null if none.
claimRestaurantJob(restaurantId: string, leaseSeconds?: number): Promise<IncomingJob | null>;
// mark ready (engine result JSON) or failed (terminal / retryable w/ backoff).
completeJob(jobId: string, leaseToken: string, result: RunResult | null, error?: string): Promise<void>;
// HTTP surface: POST /api/jobs/run (claim+engine), GET /api/jobs/result?jobId=, POST /api/jobs/ack
```

### Module ownership matrix (hard rule)

| Module | Owns (writes) | Reads (never writes) |
|---|---|---|
| M1 WhatsApp/Instagram connection layer | `gateway/src/conn/sessions.ts`, `gateway/src/conn/backoff.ts`, `gateway/src/conn/reconnect.ts`, `gateway/src/index.ts` | `gateway/src/deliver.ts` (calls `deliver()`), `gateway/src/routes/health.ts` (mount), `src/lib/agent/engine` types |
| M2 Webhook ingestion & dedup | `src/app/api/webhooks/message/route.ts`, `src/app/api/webhooks/instagram/route.ts`, `src/lib/ingest/dedup.ts` | `@/lib/queue` (`enqueueMessageJob`), `@/lib/agent/engine` (`handleIncomingMessage` sync fallback), `@/lib/env` |
| M3 Job queue / async processing | `src/lib/queue/types.ts`, `src/lib/queue/store.ts`, `src/lib/queue/process.ts`, `src/app/api/jobs/run/route.ts`, `src/app/api/jobs/result/route.ts`, `src/app/api/jobs/ack/route.ts`, `src/lib/ddl/jobs.ts` | `@/lib/db/raw` (rawClient), engine `handleIncomingMessage` (read-only), engine types |
| M4 AI orchestration & model fallback | `src/lib/ai/client.ts`, `src/lib/ddl/ai.ts` (if any index) | env only |
| M5 Conversation/order state mgmt | `src/lib/state/sessionStore.ts`, `src/lib/state/cleanup.ts`, `src/app/api/cron/cleanup/route.ts`, `src/lib/ddl/state.ts` | summary.ts (read), engine types (read), db |
| M6 Image/vision pipeline | `src/lib/vision/pipeline.ts`, `src/lib/vision/cache.ts`, `src/app/api/media/[restaurantId]/[imageId]/route.ts`, `src/lib/ddl/vision.ts` | `@/lib/ai/client` (`completeWithFallback`), engine types, db |
| M7 Database layer reliability | `src/lib/db/raw.ts`, `src/lib/db/reliability.ts`, `src/lib/ddl/reliability.ts` | drizzle, postgres |
| M8 Reply delivery & guaranteed fallback | `gateway/src/deliver.ts`, `gateway/src/queueClient.ts` | `gateway/src/conn/sessions.ts` (`getSocketRegistry`), platform `/api/jobs/*` (HTTP), engine types |
| M9 Monitoring / health / alerting | `src/lib/monitoring/logger.ts`, `src/lib/monitoring/health.ts`, `src/app/api/health/route.ts`, `src/app/api/cron/healthcheck/route.ts`, `gateway/src/routes/health.ts`, `src/lib/ddl/monitoring.ts` (if needed) | `@/lib/alerts` (`sendAlert`), `gateway/src/conn/sessions.ts`, db, `@/lib/ai/client` (`isAIConfigured`) |
| M10 Admin dashboard data layer | `src/lib/queries.ts`, `src/app/admin/actions.ts`, `src/lib/ddl/admin.ts` | db, schema (read) |

**Nobody owns:** `engine.ts`, `migrate.ts`, `summary.ts`, `prompt.ts`, `schema.ts`, `telegram.ts`, `alerts.ts`, `env.ts`, `auth.ts`, `utils.ts`, `query.ts` (Combiner-only). UI files under `src/app/admin/**` and `src/components/**` are **untouched** (hard constraint).

### Inter-dependencies (all satisfied by frozen contracts — no file-level circularity)

```
M1 ─(socket registry)─▶ M8, M9        M1 imports M8.deliver + M9.health (frozen fn signatures)
M2 ─(enqueueMessageJob)─▶ M3          M2 → engine (sync fallback, import-only)
M3 ─(handleIncomingMessage)─▶ engine  M3 → db raw
M4 · self-contained (ai/client.ts)
M5 ──▶ db; reads summary (no edit)
M6 ─(completeWithFallback)─▶ M4       M6 → db (vision_cache)
M7 ─ base infrastructure ─▶ M2,M3,M5,M6,M9,M10 (via db imports)
M8 ─(result/ack endpoints)─▶ M3       M8 → M1 (socket registry)
M9 ─(sessions snapshot)─▶ M1          M9 → db, alert
M10 ──▶ db
```

### DB schema additions (all additive; path = Combiner concatenates each module's `src/lib/ddl/*.ts` into `POST_BASELINE_DDL`)

- M3 `jobs`: `repli.message_jobs(id PK, restaurant_id, channel, remote_jid, message_id, payload jsonb, status, attempts, next_attempt_at, lease_token, lease_expires_at, result jsonb, error text, created_at, updated_at, delivered_at)`, unique `(restaurant_id, channel, message_id)`, index `(status, next_attempt_at)`, index `(restaurant_id, status)`.
- M5 `state`: index on `conversations(last_message_at)` already exists; TTL cleanup is runtime (no column). Add `conversation_settings(restaurant_id, conversation_id, input_mode, untouched_by)` only if needed for expiry — **prefer runtime no-schema** (worker decides; DDL additive only).
- M6 `vision`: `repli.vision_cache(media_key PK text, restaurant_id, mime, description text, model text, created_at)`.
- M7 `reliability`: no new tables; statement-level safeguards; optional helper index `messages(conversation_id, created_at DESC)` already present.
- M10 `admin`: index `orders(restaurant_id, status, created_at)` (idempotent).

---

## 4. Testability / independent verification per module

Each worker must ship a self-test script in `src/lib/selftest/<module>.ts` (platform) or `gateway/src/selftest-<module>.ts` (gateway), runnable with `npx tsx`, that exercises ONLY its module with mocked boundaries (e.g., M4: simulate 429 → asserts fallback; M3: enqueue/claim/complete round-trip against a scratch restaurant row; M8: `deliver()` against a mocked socket; M9: `/api/health` shape). Real-network side effects are allowed only on a **scratch restaurant** (`selftest-<ts>`) with cleanup, and on real WhatsApp only when a live session exists (never force one).

### Module 3 — binding HTTP surface (frozen; gateway worker consumes it)

All guarded by `gatewaySecretOk(req)`, `runtime="nodejs"`, `maxDuration=60`.

| Route | Body/Query | Behavior |
|---|---|---|
| `POST /api/jobs/run` | `{ restaurantId }` | Claims next `queued` job for that restaurant (atomic `FOR UPDATE SKIP LOCKED` + 45s lease), runs `handleIncomingMessage(job.payload)`, stores minimal result JSON, returns `{ ok, job }` (job null when queue empty). |
| `GET /api/jobs/result?jobId=` | — | Returns `{ ok, status, result, error, createdAt }`. Used by the gateway poll loop. |
| `POST /api/jobs/ack` | `{ jobId, delivered?: boolean, expired?: boolean }` | `ready/sending → sent` (+`delivered_at`) when delivered; `→ expired` when the gateway gave up (timeout budget hit → fallback already sent). |
| `GET /api/jobs/pending?restaurantId=` | — | Lists up to 20 `ready` jobs per restaurant for outbox resume after reconnect. |

Result JSON stored on a job (frozen shape): `{ replyText, replyParts?, silent?, images?: [{base64,mime}], transcription?, order?, costUsd?, model? }`. When `silent===true` the gateway sends nothing and MUST NOT auto-fallback.

### Scope decision (Phase-1 call, documented)

**Async job queue applies to WhatsApp only.** Instagram stays inline-but-hardened: durable mid-dedup (reuses the dieduplicator in M2), input validation, per-message error isolation, graceful Iraqi fallback. Rationale: IG replies are delivered by the platform route itself via `sendInstagramText` (there is no gateway socket to poll), and parking every restaurant's `instagram_token` inside a shared jobs table is a secret-leak risk the plan refuses to accept.

### Frozen gateway delivery contract (M1↔M8)

**M1** calls `deliver(restaurantId, remoteJid, parsed, messageId?)` (M8-owned) from the `messages.upsert` handler and passes `m.key.id` as `messageId`. **M8** owns the function and runs the fast-ack+poll flow internally: if the platform answers `{ accepted: true, jobId }`, poll `GET /api/jobs/result` until ready (pacing preserved) → send reply → `POST /api/jobs/ack {delivered:true}`; on budget expiry → send graceful fallback + `{expired:true}`; on session drop → leave job `ready` so the outbox resume loop (`GET /api/jobs/pending` scanned every 30s) delivers after reconnect.

## 5. Rollback strategy (placed here by design; executed in Phase 3)

- Feature-flag `platform.webhookMode` (`async` default, `sync` legacy). Rollback = set env `WEBHOOK_MODE=sync`; worker code routed by the flag, gateway falls back to legacy `deliver()` when flag flips. The legacy sync handler is preserved in M2's route (small, tested).
- All DDL additive → `git revert` of the code + (optional) `DROP TABLE` cleanups listed in the Phase-3 report.
- Deploy order: platform first (schema additive via instrumentation), then gateway. Keep-alive + health used as canary.