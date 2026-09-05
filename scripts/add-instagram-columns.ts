import { rawClient } from "../src/lib/db/raw";

async function main() {
  const statements = [
    `ALTER TABLE repli.restaurants ADD COLUMN IF NOT EXISTS instagram_token text;`,
    `ALTER TABLE repli.restaurants ADD COLUMN IF NOT EXISTS instagram_ig_id text;`,
  ];
  for (const stmt of statements) {
    try {
      await rawClient.unsafe(stmt);
      console.log(`OK: ${stmt}`);
    } catch (err) {
      console.log(`SKIP: ${stmt} -> ${JSON.stringify(err)}`);
    }
  }
  await rawClient.end();
  process.exit(0);
}

main();