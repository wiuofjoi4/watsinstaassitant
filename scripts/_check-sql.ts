import postgres from "postgres";

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const t = new Date(String(v));
  return Number.isNaN(t.getTime()) ? null : t;
}

async function main() {
  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, prepare: false });
  const rows = await sql`select activated_at, created_at from repli.restaurants limit 2`;
  for (const r of rows as Array<Record<string, unknown>>) {
    const v = r.activated_at;
    console.log("raw activated_at:", v, "| typeof:", typeof v, "| instanceof Date:", v instanceof Date);
    const d = toDate(v);
    console.log("  toDate →", d, "| getTime ok:", d && !Number.isNaN(d.getTime()));
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });