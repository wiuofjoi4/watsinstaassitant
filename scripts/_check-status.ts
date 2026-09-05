import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, {
    ssl: { rejectUnauthorized: false },
    prepare: false,
  });

  const rows = await sql`select id, name, whatsapp_status, whatsapp_linked, whatsapp_jid, instagram_status from repli.restaurants order by name`;
  console.log(JSON.stringify(rows, null, 2));

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});