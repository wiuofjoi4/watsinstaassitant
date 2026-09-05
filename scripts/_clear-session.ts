import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, {
    ssl: { rejectUnauthorized: false },
    prepare: false,
  });

  await sql`delete from repli.gateway_sessions where restaurant_id = 'seed-restaurant-1' and channel = 'whatsapp'`;
  console.log("gateway_sessions row deleted");

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});