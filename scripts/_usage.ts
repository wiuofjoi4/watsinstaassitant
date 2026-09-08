import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, {
    ssl: { rejectUnauthorized: false },
    prepare: false,
  });
  const d = await sql`
    select created_at, model, input_tokens, output_tokens
    from repli.usage_logs
    where created_at >= '2026-09-07T00:00:00Z'
    order by created_at
  `;
  console.log("today usage_logs:", d.length);
  for (const r of d as unknown as Array<{ created_at: Date; model: string; input_tokens: number; output_tokens: number }>) {
    console.log(String(r.created_at).slice(0, 19), "|", r.model, "| in:", r.input_tokens, "| out:", r.output_tokens);
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });