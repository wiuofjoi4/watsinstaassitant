import { SCHEMA_DDL } from "./ddl";
import { rawClient } from "./raw";

let initialized: Promise<void> | null = null;

/**
 * Schema objects added AFTER the original baseline migration. New deployments
 * never re-run SCHEMA_DDL (guarded by the `baseline` marker row below), so any
 * index or column added later lives here instead — every statement is
 * idempotent (`IF NOT EXISTS`) and is applied on every cold start until it
 * exists, then becomes a no-op.
 */
const POST_BASELINE_DDL = `
CREATE INDEX IF NOT EXISTS "messages_conversation_created_idx" ON "repli"."messages" USING btree ("conversation_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_restaurant_status_idx" ON "repli"."orders" USING btree ("restaurant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_logs_created_idx" ON "repli"."usage_logs" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "error_logs_resolved_idx" ON "repli"."error_logs" USING btree ("resolved","created_at" DESC);
--> statement-breakpoint
ALTER TABLE "repli"."usage_logs" ADD COLUMN IF NOT EXISTS "key_label" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repli"."telegram_bots" (
  "id" text PRIMARY KEY NOT NULL,
  "restaurant_id" text NOT NULL,
  "bot_token" text NOT NULL DEFAULT '',
  "webhook_secret" text NOT NULL DEFAULT '',
  "bot_username" text,
  "chat_id" text,
  "enabled" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_bots_restaurant_idx" ON "repli"."telegram_bots" ("restaurant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repli"."telegram_order_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "restaurant_id" text NOT NULL,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "customer_name" text,
  "phone" text,
  "address" text,
  "items_json" text NOT NULL DEFAULT '[]',
  "total" real,
  "text" text NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_order_deliveries_restaurant_idx" ON "repli"."telegram_order_deliveries" ("restaurant_id","requested_at" DESC);
`;

async function applyStatements(statements: string): Promise<void> {
  const parts = statements
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of parts) {
    try {
      await rawClient.unsafe(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(msg)) {
        throw err;
      }
    }
  }
}

/**
 * Runs the schema DDL once per deployment (a marker row in
 * repli.schema_migrations prevents re-running on every cold start) and applies
 * any post-baseline additions idempotently on every boot so schema objects
 * added after the first deploy still reach existing production databases.
 */
export function migrateNow(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      let baselineApplied = false;
      try {
        const marker = await rawClient`
          select 1 from repli.schema_migrations
          where id = 'baseline' and applied = true
        `;
        baselineApplied = marker.length > 0;
      } catch {
        // table absent — fall through and apply DDL
      }

      if (!baselineApplied) {
        await applyStatements(SCHEMA_DDL);
      }

      // Always-idempotent additions (indexes/columns added after baseline).
      await applyStatements(POST_BASELINE_DDL);

      if (!baselineApplied) {
        await rawClient.unsafe(`
          create table if not exists repli.schema_migrations (
            id text primary key,
            applied boolean not null default true,
            applied_at timestamptz not null default now()
          )
        `);
        await rawClient.unsafe(`
          insert into repli.schema_migrations (id)
          values ('baseline')
          on conflict (id) do nothing
        `);
      }
    })().catch((err) => {
      initialized = null;
      throw err;
    });
  }
  return initialized;
}