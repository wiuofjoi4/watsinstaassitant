import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, prepare: false });

  const e = await sql`select id, created_at, message from repli.error_logs order by created_at desc limit 6`;
  for (const r of e as Array<Record<string, unknown>>) {
    console.log("---", String(r.created_at), "| id:", String(r.id));
    console.log(String(r.message).slice(0, 180));
  }

  const m = await sql`
    select created_at, direction, text from repli.messages
    where created_at >= '2026-09-07T00:00:00Z'
    order by created_at desc limit 6
  `;
  console.log("\n=== latest messages today ===");
  for (const r of m as Array<Record<string, unknown>>) {
    console.log("---", String(r.created_at), "| dir:", String(r.direction));
    console.log(String(r.text ?? "").slice(0, 120));
  }

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });