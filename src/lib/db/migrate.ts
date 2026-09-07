import { SCHEMA_DDL } from "./ddl";
import { rawClient } from "./raw";

let initialized: Promise<void> | null = null;

/**
 * Runs the schema DDL once per deployment (a marker row in
 * repli.schema_migrations prevents re-running on every cold start).
 */
export function migrateNow(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      try {
        const marker = await rawClient`
          select 1 from repli.schema_migrations
          where id = 'baseline' and applied = true
        `;
        if (marker.length > 0) return;
      } catch {
        // table absent — fall through and apply DDL
      }

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

      await rawClient.unsafe(`
        create table if not exists repli.schema_migrations (
          id text primary key,
          applied boolean not null default true,
          applied_at timestamptz not null default now()
        )
      `);
      await rawClient.unsafe(`
        insert into repli.schema_migrations (id)
        values ('baseline')
        on conflict (id) do nothing
      `);
    })().catch((err) => {
      initialized = null;
      throw err;
    });
  }
  return initialized;
}