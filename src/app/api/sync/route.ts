import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { restaurants } from "@/lib/db/schema";

export const runtime = "nodejs";

function validSecret(req: Request): boolean {
  const expected = process.env.GATEWAY_SECRET;
  if (!expected) return true;
  return req.headers.get("x-gateway-secret") === expected;
}

export async function GET(req: Request) {
  if (!validSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select({
      id: restaurants.id,
      name: restaurants.name,
      agentEnabled: restaurants.agentEnabled,
      whatsappStatus: restaurants.whatsappStatus,
      whatsappLinked: restaurants.whatsappLinked,
      whatsappJid: restaurants.whatsappJid,
      instagramStatus: restaurants.instagramStatus,
      instagramLinked: restaurants.instagramLinked,
      instagramUsername: restaurants.instagramUsername,
    })
    .from(restaurants);

  return NextResponse.json({ restaurants: rows });
}