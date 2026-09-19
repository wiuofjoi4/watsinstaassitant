// ---------------------------------------------------------------------------
// M5 durable context loader. Mirrors the engine's message-history read +
// condensation path EXACTLY (engine.ts runIncomingMessage): resolve the
// conversation for (restaurant, channel, remoteJid), read the most recent rows
// ordered created_at DESC, reverse to oldest→newest, drop the just-stored
// current message (tail pop), then condense the last CONDENSE_WINDOW rows with
// condenseMessages. The engine's own read path stays INTACT — this helper is a
// read-only twin the Combiner can swap into other call sites frictionlessly.
// It NEVER calls handleIncomingMessage.
// ---------------------------------------------------------------------------
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages } from "@/lib/db/schema";
import { first } from "@/lib/db/query";
import { condenseMessages, type CondensedContext } from "@/lib/agent/summary";
import type { Channel } from "@/lib/agent/engine";

// The engine condenses at most HISTORY_LIMIT (=24) rows per turn (engine.ts).
// Anything fetched beyond that window is only ever served as raw rows.
const CONDENSE_WINDOW = 24;
const DEFAULT_LIMIT_ROWS = 200;

export interface MessageRow {
  role: "user" | "assistant";
  text: string;
  created_at: Date | string;
}

export interface LoadConversationContextResult {
  /** Oldest → newest retained rows (same ordering the engine reverses into). */
  rows: MessageRow[];
  /**
   * condenseMessages over the last CONDENSE_WINDOW rows — semantically the
   * same CondensedContext the engine builds. Null only on a DB-level failure
   * path where the caller should fall back to an empty conversation.
   */
  condensed: CondensedContext | null;
}

export async function loadConversationContext(args: {
  restaurantId: string;
  remoteJid: string;
  channel: Channel;
  limitRows?: number;
}): Promise<LoadConversationContextResult> {
  const limitRows = Math.max(1, args.limitRows ?? DEFAULT_LIMIT_ROWS);

  let conversationId: string | null = null;
  try {
    const conversation = await first(
      db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.restaurantId, args.restaurantId),
            eq(conversations.channel, args.channel),
            eq(conversations.remoteJid, args.remoteJid)
          )
        )
    );
    conversationId = conversation?.id ?? null;
  } catch (err) {
    // Mirrors the engine's "a DB hiccup must not break the turn" behavior:
    // log and hand back an empty conversation instead of throwing.
    console.error(
      `[CONTEXT] conversation lookup failed ${args.restaurantId} ${args.channel}/${args.remoteJid}`,
      err
    );
  }

  if (!conversationId) {
    return { rows: [], condensed: condenseMessages([]) };
  }

  try {
    const historyRows = await db
      .select({
        direction: messages.direction,
        text: messages.text,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(limitRows);

    // Oldest → newest; then drop the most recent row exactly like the engine
    // does after it stores the current incoming message (it must not appear
    // twice — it is sent below as the live user message).
    historyRows.reverse();
    historyRows.pop();

    const rows: MessageRow[] = historyRows.map((r) => ({
      role: r.direction === "out" ? "assistant" : "user",
      text: r.text ?? "",
      created_at: r.createdAt,
    }));

    const condensed = condenseMessages(
      rows.slice(-CONDENSE_WINDOW).map((r) => ({
        direction: r.role === "assistant" ? "out" : "in",
        text: r.text,
      }))
    );

    return { rows, condensed };
  } catch (err) {
    console.error(
      `[CONTEXT] history fetch failed ${args.restaurantId} ${args.channel}/${args.remoteJid} — replying with current message only`,
      err
    );
    return { rows: [], condensed: condenseMessages([]) };
  }
}