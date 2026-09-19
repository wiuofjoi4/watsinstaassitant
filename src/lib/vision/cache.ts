// ---------------------------------------------------------------------------
// M6 vision-cache repository. Durable cache of AI vision extractions backed by
// repli.vision_cache (see src/lib/ddl/vision.ts). Every function throws on a
// DB error — callers decide how to degrade (extractVisionText treats the cache
// as best-effort).
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { rawClient } from "@/lib/db/raw";

/** Longest stored description; longer extractions are truncated on write. */
export const VISION_DESCRIPTION_MAX_LENGTH = 2000;

export interface CachedVision {
  description: string;
  model: string | null;
}

/**
 * Deterministic content-addressable cache key for a media payload:
 * `v1:<sha256(restaurantId:mime:base64)>`. Same image bytes re-delivered for
 * the same restaurant hash to one key, so repeated image turns never pay for a
 * second model call.
 */
export function visionMediaKey(input: {
  restaurantId: string;
  mime: string;
  base64: string;
}): string {
  const h = createHash("sha256")
    .update(`${input.restaurantId}:${input.mime}:${input.base64}`)
    .digest("hex");
  return `v1:${h}`;
}

/** Returns the cached extraction for `mediaKey`, or null when absent. */
export async function getCachedVision(
  mediaKey: string
): Promise<CachedVision | null> {
  const rows = await rawClient`
    select description, model
    from repli.vision_cache
    where media_key = ${mediaKey}
    limit 1
  `;
  if (!rows || rows.length === 0) return null;
  const row = rows[0] as { description: string; model: string | null };
  return {
    description: String(row.description),
    model: row.model == null ? null : String(row.model),
  };
}

export interface SetCachedVisionInput {
  mediaKey: string;
  restaurantId: string;
  mime: string;
  description: string;
  model: string | null;
}

/** Upserts one extraction. Re-posts refresh description/model/created_at. */
export async function setCachedVision(input: SetCachedVisionInput): Promise<void> {
  const description =
    input.description.length > VISION_DESCRIPTION_MAX_LENGTH
      ? input.description.slice(0, VISION_DESCRIPTION_MAX_LENGTH)
      : input.description;
  await rawClient`
    insert into repli.vision_cache (media_key, restaurant_id, mime, description, model)
    values (${input.mediaKey}, ${input.restaurantId}, ${input.mime}, ${description}, ${input.model})
    on conflict (media_key) do update
      set description = excluded.description,
          model = excluded.model,
          created_at = now()
  `;
}

/**
 * Deletes stale cache rows older than `olderThanDays` and returns how many
 * were removed. Default 7d mirrors the gateway cache TTL semantics.
 */
export async function pruneVisionCache(olderThanDays = 7): Promise<number> {
  const rows = await rawClient`
    delete from repli.vision_cache
    where created_at < now() - make_interval(days => ${olderThanDays})
    returning media_key
  `;
  return (rows ?? []).length;
}