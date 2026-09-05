import { SCHEMA_DDL } from "./ddl";
import { rawClient } from "./raw";

let initialized: Promise<void> | null = null;

export function migrateNow(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      const statements = SCHEMA_DDL.split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of statements) {
        try {
          await rawClient.unsafe(stmt);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/already exists/i.test(msg)) {
            throw err;
          }
        }
      }
    })().catch((err) => {
      initialized = null;
      throw err;
    });
  }
  return initialized;
}