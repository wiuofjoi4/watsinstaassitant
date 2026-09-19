// ---------------------------------------------------------------------------
// M5 state/index schema. Additive + idempotent ONLY. The Combiner concatenates
// this array into migrate.ts POST_BASELINE_DDL (its applyStatements splits on
// "--> statement-breakpoint"; entries here are single IF NOT EXISTS statements).
//
// What is here and why:
//  - "messages_expire_idx" on messages(created_at): serves the cron retention
//    DELETE (/api/cron/cleanup), which scans by created_at ACROSS all
//    conversations. No existing index can serve that predicate.
//
// What is deliberately NOT here and why:
//  - The plan's messages_conv_recent_idx (conversation_id, created_at DESC) is
//    ALREADY covered by "messages_conversation_created_idx" in migrate.ts
//    POST_BASELINE_DDL (exact same column set/order). Creating a second
//    equivalent index would double write cost for zero read benefit.
// ---------------------------------------------------------------------------
export const STATE_DDL: string[] = [
  `CREATE INDEX IF NOT EXISTS "messages_expire_idx" ON "repli"."messages" ("created_at");`,
];