/**
 * M4 (AI orchestration) — no schema additions.
 *
 * The per-key circuit/cooldown layer lives entirely in memory inside
 * `@/lib/ai/client` (per process, same as the existing circuit breaker), so
 * there is nothing to persist or index. The Combiner concatenates this export
 * into `POST_BASELINE_DDL`; an empty array is a valid no-op.
 */
export const AI_DDL: string[] = [];