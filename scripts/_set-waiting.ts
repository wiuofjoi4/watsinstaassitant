import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, {
    ssl: { rejectUnauthorized: false },
    prepare: false,
  });

  await sql`update repli.restaurants set whatsapp_status = 'waiting', whatsapp_linked = false where id = 'seed-restaurant-1'`;
  console.log("whatsapp_status set to waiting");

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});