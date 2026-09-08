export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { migrateNow } = await import("@/lib/db/migrate");
  try {
    await migrateNow();
  } catch (err) {
    // Never let a schema-migration hiccup (e.g. briefly unreachable DB on a
    // cold start) crash the whole app — that surfaced as 500s on every admin
    // page. The migration is idempotent and retries on the next cold start;
    // individual queries already degrade gracefully at the page level.
    console.error("[migrate] schema migration failed (will retry next boot):", err);
  }
}