// ---------------------------------------------------------------------------
// M10 admin-dashboard schema. Additive + idempotent ONLY. The Combiner
// concatenates this array into migrate.ts POST_BASELINE_DDL (its
// applyStatements splits on "--> statement-breakpoint"; entries here are
// single IF NOT EXISTS statements).
//
// What is here and why:
//  - "orders_restaurant_status_created_idx" on orders(restaurant_id, status,
//    created_at): serves the status-filtered, created_at-ordered admin scans
//    (dashboard "new orders" counters, orders tab) in one index where the two
//    existing indexes (restaurant_id, created_at) and (restaurant_id, status)
//    each cover only half of that predicate+order. Named per the Phase-1 plan
//    M10 directive.
//  - "error_logs_created_idx" on error_logs(created_at DESC): serves
//    getRecentErrors() (admin dashboard), which orders the WHOLE error_logs
//    table by created_at DESC with no restaurant filter. The existing
//    error_logs indexes (restaurant_id, created_at) and (resolved,
//    created_at DESC) cannot answer that unfiltered recent-first scan without
//    a full sort.
//
// What is deliberately NOT here and why:
//  - messages(conversation_id, created_at DESC) — already exists as
//    "messages_conversation_created_idx" in migrate.ts POST_BASELINE_DDL.
//  - usage_logs(restaurant_id, created_at) — "usage_logs_restaurant_idx"
//    already covers the usage-tab scan (backward index scan for DESC).
// ---------------------------------------------------------------------------
export const ADMIN_DDL: string[] = [
  `CREATE INDEX IF NOT EXISTS "orders_restaurant_status_created_idx" ON "repli"."orders" USING btree ("restaurant_id","status","created_at");`,
  `CREATE INDEX IF NOT EXISTS "error_logs_created_idx" ON "repli"."error_logs" USING btree ("created_at" DESC);`,
];