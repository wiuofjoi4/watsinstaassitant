// ---------------------------------------------------------------------------
// M3 job queue schema. Additive + idempotent (post-baseline). The Combiner
// concatenates JOBS_DDL into POST_BASELINE_DDL and runs it on every boot.
// ---------------------------------------------------------------------------

export const JOBS_DDL: string[] = [
  `create table if not exists repli.message_jobs (
    id uuid primary key default gen_random_uuid(),
    restaurant_id text not null,
    channel text not null default 'whatsapp',
    remote_jid text not null,
    message_id text,
    payload jsonb not null,
    status text not null default 'queued',
    attempts int not null default 0,
    next_attempt_at timestamptz,
    lease_token uuid,
    lease_expires_at timestamptz,
    result jsonb,
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    delivered_at timestamptz
  )`,
  `create unique index if not exists message_jobs_dedup_key
    on repli.message_jobs (restaurant_id, channel, message_id)
    where message_id is not null`,
  `create index if not exists message_jobs_claim_idx
    on repli.message_jobs (restaurant_id, status, next_attempt_at)
    where status in ('queued', 'processing')`,
  `create index if not exists message_jobs_result_idx
    on repli.message_jobs (status, updated_at)
    where status in ('ready', 'sending')`,
  `create index if not exists message_jobs_restaurant_idx
    on repli.message_jobs (restaurant_id, created_at desc)`,
];