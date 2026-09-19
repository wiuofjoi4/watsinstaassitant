import type { Request, Response } from "express";
import type { Sql } from "postgres";
import {
  getRecentEvents,
  getReconnectSnapshot,
  getSessionsSnapshot,
  sessions,
} from "../conn/state";

// ---------------------------------------------------------------------------
// M9 /health handler (built on the pre-flight split from index.ts). The expose
// shape is FROZEN for render.yaml's healthCheckPath: the exact keys
//   { ok, db, sessions, connected, uptime, memory, states, recent }
// and their semantics are preserved verbatim — only ADDITIVE keys
// (reconnect, degraded, now) are allowed below, no removals, no renames.
// ---------------------------------------------------------------------------

export interface GatewayHealth {
  ok: boolean;
  db: "ok" | "down";
  sessions: number;
  connected: number;
  uptime: number;
  memory: NodeJS.MemoryUsage;
  states: ReturnType<typeof getSessionsSnapshot>;
  recent: ReturnType<typeof getRecentEvents>;
  reconnect: ReturnType<typeof getReconnectSnapshot>;
  degraded: boolean;
  now: string;
}

// Health route factory (Module 9 contract). The connection layer mounts this
// handler; state comes from the live session registry so it reports REAL
// socket health — not just "process is up".
export function createHealthHandler(deps: { getSql: () => Sql | null }) {
  return async (_req: Request, res: Response): Promise<void> => {
    let db: "ok" | "down" = "ok";
    const sql = deps.getSql();
    if (sql) {
      try {
        await sql`select 1`;
      } catch {
        db = "down";
      }
    }
    const reconnect = getReconnectSnapshot();
    const now = Date.now();
    const degraded =
      db === "down" || reconnect.some((r) => r.pausedUntil > now);
    res.json({
      ok: db === "ok",
      db,
      sessions: sessions.size,
      connected: [...sessions.values()].filter((s) => s.connected).length,
      uptime: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      states: getSessionsSnapshot(),
      recent: getRecentEvents(),
      reconnect,
      degraded,
      now: new Date(now).toISOString(),
    });
  };
}