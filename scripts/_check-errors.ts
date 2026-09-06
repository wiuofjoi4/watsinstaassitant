import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, prepare: false });

  const rows = await sql`select source, message, stack, created_at
    from repli.error_logs
    order by created_at desc
    limit 6`;
  console.log(JSON.stringify(rows, null, 2));

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});