import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants } from "@/lib/db/schema";
import { first } from "@/lib/db/query";
import { VISION_MIME_ALLOWLIST } from "@/lib/vision/client";

export const runtime = "nodejs";

// Served media is immutable restaurant photography, so only allow the browser
//-friendly image types the stored menu_images rows can carry; anything else
// (heic, svg, …) is rejected with 415 instead of being proxied.
const IMAGE_MIME_SET: ReadonlySet<string> = new Set(VISION_MIME_ALLOWLIST);

// Restaurant ids are base64url strings (utils.newId) or uuids — both fall
// inside [A-Za-z0-9_-]. Reject non-matching path junk with 400 before it ever
// becomes a DB lookup.
const RESTAURANT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface MenuImageRaw {
  id: string;
  mime: string;
  base64: string;
}

function parseMenuImages(raw: string | null | undefined): MenuImageRaw[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as MenuImageRaw[];
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x) => x && typeof x.base64 === "string" && typeof x.mime === "string"
    );
  } catch {
    return [];
  }
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ restaurantId: string; imageId: string }> }
) {
  const { restaurantId, imageId } = await ctx.params;
  if (!RESTAURANT_ID_RE.test(restaurantId)) {
    return new Response(JSON.stringify({ error: "Invalid restaurant ID" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const restaurant = await first(
    db.select().from(restaurants).where(eq(restaurants.id, restaurantId))
  );
  if (!restaurant) return new Response("Not found", { status: 404 });

  const images = parseMenuImages(restaurant.menuImages);
  const img = images.find((x) => x.id === imageId);
  if (!img) return new Response("Not found", { status: 404 });
  if (!IMAGE_MIME_SET.has(img.mime)) {
    return new Response(JSON.stringify({ error: "Unsupported media type" }), {
      status: 415,
      headers: { "content-type": "application/json" },
    });
  }
  const buf = Buffer.from(img.base64, "base64");
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": img.mime || "image/jpeg",
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(buf.length),
    },
  });
}