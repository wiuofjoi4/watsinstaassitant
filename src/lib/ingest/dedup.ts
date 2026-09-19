// ---------------------------------------------------------------------------
// M2 durable ingest dedup. Replaces the gateway's in-memory seenMessageIds and
// the IG route's in-memory seenIgMids as the multi-instance-safe authority:
// an atomic INSERT ... ON CONFLICT DO NOTHING into repli.ingest_dedup. Keys
// are kept for a short TTL (default 15 minutes) and pruned by
// pruneOldIngest() — no unbounded growth, retries within the window are
// swallowed, re-deliveries after the window are processed again.
//
// Key scheme (both channels):
//   "<wa|ig>:<messageId>"                          when a message id exists
//   "<wa|ig>:<restaurantId>:<sha256(remote:jid+text)>"  otherwise
// Any DB error THROWS — callers decide their own fallback, never swallow.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import type { Channel } from "@/lib/agent/engine";
import { rawClient } from "@/lib/db";

export interface DedupKeyInput {
  messageId?: string | null;
  restaurantId: string;
  remoteJid: string;
  text?: string | null;
}

function hashRemoteJidText(remoteJid: string, text?: string | null): string {
  return createHash("sha256")
    .update(`${remoteJid ?? ""}:${text ?? ""}`)
    .digest("hex");
}

export function dedupKeyForWhatsApp(input: DedupKeyInput): string {
  if (input.messageId) return `wa:${input.messageId}`;
  return `wa:${input.restaurantId}:${hashRemoteJidText(input.remoteJid, input.text)}`;
}

export function dedupKeyForInstagram(input: DedupKeyInput): string {
  if (input.messageId) return `ig:${input.messageId}`;
  return `ig:${input.restaurantId}:${hashRemoteJidText(input.remoteJid, input.text)}`;
}

/**
 * The dedup table stores restaurant_id + channel as informational metadata.
 * Both are recoverable from the key format above: "wa"/"ig" prefix gives the
 * channel, and the hashed form immediately follows a "<restaurantId>:" segment
 * while the message-id form carries no restaurant (the id itself is stored as
 * the marker).
 */
function deriveIngestMeta(
  key: string
): { channel: Channel; restaurantId: string } {
  const firstColon = key.indexOf(":");
  const prefix = firstColon === -1 ? key : key.slice(0, firstColon);
  const rest = firstColon === -1 ? "" : key.slice(firstColon + 1);
  const channel: Channel = prefix === "ig" ? "instagram" : "whatsapp";
  const secondColon = rest.indexOf(":");
  const restaurantId = secondColon === -1 ? rest : rest.slice(0, secondColon);
  return { channel, restaurantId };
}

/**
 * Atomic idempotency insert. Returns false when this key was newly inserted
 * (fresh message → process it) and true when the key already existed (seen
 * recently → duplicate, skip). Never swallows a DB error.
 */
export async function isDuplicateIngest(key: string): Promise<boolean> {
  const { channel, restaurantId } = deriveIngestMeta(key);
  const rows = await rawClient`
    insert into repli.ingest_dedup (message_key, restaurant_id, channel, created_at)
    values (${key}, ${restaurantId}, ${channel}, now())
    on conflict (message_key) do nothing
    returning message_key
  `;
  return rows.length === 0;
}

/**
 * Deletes dedup keys older than `olderThanMinutes` (default 15). Returns the
 * number of rows removed. Errors throw.
 */
export async function pruneOldIngest(olderThanMinutes = 15): Promise<number> {
  const deleted = await rawClient`
    delete from repli.ingest_dedup
    where created_at < now() - make_interval(mins => ${olderThanMinutes})
    returning message_key
  `;
  return deleted.length;
}