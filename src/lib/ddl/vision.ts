// ---------------------------------------------------------------------------
// M6 vision-cache schema. Additive + idempotent (post-baseline). The Combiner
// concatenates VISION_DDL into POST_BASELINE_DDL and runs it on every boot.
//
// vision_cache: durable cache of AI vision extractions keyed by a content hash
// (media_key). Extracted descriptions never need to be re-sent to the model —
// the gateway re-delivers the same menu photography repeatedly, and a single
// base64 → model call per unique image is the whole point of the cache.
// ---------------------------------------------------------------------------

export const VISION_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS "repli"."vision_cache" (
    "media_key" text PRIMARY KEY NOT NULL,
    "restaurant_id" text NOT NULL,
    "mime" text NOT NULL,
    "description" text NOT NULL,
    "model" text,
    "created_at" timestamptz NOT NULL DEFAULT now()
  );`,
  `CREATE INDEX IF NOT EXISTS "vision_cache_created_idx" ON "repli"."vision_cache" ("created_at");`,
];