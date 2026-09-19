// ---------------------------------------------------------------------------
// M9 monitoring DDL. Additive + idempotent (post-baseline). The Combiner
// concatenates MONITORING_DDL into POST_BASELINE_DDL on every boot — empty
// here BY DESIGN, because everything M9 reads already exists:
//
//   - recent-errors census  → repli.error_logs (created_at) — the baseline
//     table/column the admin "recent errors" queries already use
//     (src/lib/queries.ts getRecentErrors). No new index needed: the count is
//     a full-ish scan over the last hour in a cron, not a hot read path.
//   - platform /api/health  → runtime probes only (getDbStatus, probeAIHealth,
//     gateway fetch, count) — no schema objects.
//   - gateway /health       → in-memory session registry + SELECT 1.
//
// No new tables, columns, or indexes are required.
// ---------------------------------------------------------------------------

export const MONITORING_DDL: string[] = [];