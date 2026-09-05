import { rawClient } from "../src/lib/db/raw";
import { SCHEMA_DDL } from "../src/lib/db/ddl";

const statements = SCHEMA_DDL.split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((s) => s.includes("gateway_sessions"));

async function main() {
  for (const stmt of statements) {
    try {
      await rawClient.unsafe(stmt);
      console.log(`OK: ${stmt.slice(0, 60)}`);
    } catch (err) {
      console.log(`SKIP: ${stmt.slice(0, 60)} → ${(err as Error).message}`);
    }
  }
  await rawClient.end();
  process.exit(0);
}

main();