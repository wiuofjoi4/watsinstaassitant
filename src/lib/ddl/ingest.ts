// ---------------------------------------------------------------------------
// M2 ingest-dedup schema. Additive/idempotent only. The Combiner concatenates
// this array into migrate.ts POST_BASELINE_DDL (applyStatements splits git-style
// "statement-breakpoint" separators; entries here are single statements).
// ---------------------------------------------------------------------------
export const INGEST_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS "repli"."ingest_dedup" (
  "message_key" text PRIMARY KEY NOT NULL,
  "restaurant_id" text NOT NULL,
  "channel" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);`,
  `CREATE INDEX IF NOT EXISTS "ingest_dedup_created_at_idx" ON "repli"."ingest_dedup" ("created_at");`,
];