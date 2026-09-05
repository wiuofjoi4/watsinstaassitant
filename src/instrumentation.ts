export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { migrateNow } = await import("@/lib/db/migrate");
  await migrateNow();
}