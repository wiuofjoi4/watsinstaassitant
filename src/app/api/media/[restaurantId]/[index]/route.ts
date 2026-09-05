import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants } from "@/lib/db/schema";
import { first } from "@/lib/db/query";

export const runtime = "nodejs";

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
  ctx: { params: Promise<{ restaurantId: string; index: string }> }
) {
  const { restaurantId, index } = await ctx.params;
  const restaurant = await first(
    db.select().from(restaurants).where(eq(restaurants.id, restaurantId))
  );
  if (!restaurant) return new Response("Not found", { status: 404 });

  const images = parseMenuImages(restaurant.menuImages);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= images.length) {
    return new Response("Not found", { status: 404 });
  }

  const img = images[i];
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