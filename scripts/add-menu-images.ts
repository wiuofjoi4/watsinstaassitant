import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";

async function main() {
  await db.execute(
    sql`ALTER TABLE repli.restaurants ADD COLUMN IF NOT EXISTS menu_images text DEFAULT '[]' NOT NULL`
  );
  await db.execute(
    sql`ALTER TABLE repli.restaurants ADD COLUMN IF NOT EXISTS auto_menu_whatsapp boolean DEFAULT false NOT NULL`
  );
  await db.execute(
    sql`ALTER TABLE repli.restaurants ADD COLUMN IF NOT EXISTS auto_menu_instagram boolean DEFAULT false NOT NULL`
  );
  console.log("menu columns added");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});