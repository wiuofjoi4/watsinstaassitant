// ---------------------------------------------------------------------------
// M7 reliability DDL. Additive + idempotent (post-baseline). The Combiner
// concatenates RELIABILITY_DDL into POST_BASELINE_DDL on every boot — empty
// here BY DESIGN, because everything this module needs already exists:
//
//   - The "recent usage per restaurant" query pattern
//     (restaurant_id, created_at DESC) is ALREADY served by the baseline
//     index "usage_logs_restaurant_idx" on repli.usage_logs
//     (restaurant_id, created_at) declared in schema.ts / the baseline DDL
//     (src/lib/db/ddl.ts). A Postgres btree with equality on the leading
//     column is read BACKWARD to satisfy a DESC second column, so creating a
//     second (restaurant_id, created_at DESC) index would be a pure
//     duplicate — never done.
//   - The optional "recent messages" helper mentioned in the plan
//     (conversation_id, created_at DESC) is likewise already present as
//     "messages_conversation_created_idx" in POST_BASELINE_DDL (migrate.ts).
//   - All remaining M7 safeguards (retry / query-timeout / concurrency cap /
//     pool tuning / health probe) are statement-level runtime behaviour in
//     src/lib/db/raw.ts and src/lib/db/reliability.ts and need no schema
//     objects.
// ---------------------------------------------------------------------------

export const RELIABILITY_DDL: string[] = [];