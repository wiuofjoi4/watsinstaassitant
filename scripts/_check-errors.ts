import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, prepare: false });
  const cols = await sql`select column_name from information_schema.columns where table_schema='repli' and table_name='error_logs' order by ordinal_position`;
  console.log("columns:", cols.map((c) => String((c as { column_name: unknown }).column_name)).join(", "));
  const logs = await sql`select * from repli.error_logs order by created_at desc limit 12`;
  for (const l of logs as Array<Record<string, unknown>>) {
    console.log("---");
    console.log("at:", l.created_at);
    console.log("src:", l.source, "| lvl:", l.level ?? l.severity, "| code:", l.code);
    console.log("msg:", String(l.message).slice(0, 500));
  }
  const convs = await sql`
    select c.whatsapp_jid, c.direction, c.text, c.created_at
    from repli.conversations c
    where c.whatsapp_jid is not null
    order by c.created_at desc
    limit 5
  `;
  console.log("\n=== recent conversations ===");
  for (const l of convs as Array<Record<string, unknown>>) {
    console.log("---");
    console.log("at:", l.created_at, "| dir:", l.direction);
    console.log("text:", String(l.text).slice(0, 300));
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });