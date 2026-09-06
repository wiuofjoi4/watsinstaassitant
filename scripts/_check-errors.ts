import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, prepare: false });

  const rows = await sql`select source, message, created_at
    from repli.error_logs
    order by created_at desc
    limit 4`;
  for (const r of rows) {
    const m = String(r.message ?? "").replace(/\s+/g, " ").slice(0, 200);
    console.log("---", String(r.created_at), "\n", m);
  }
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});