import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { restaurants } from "@/lib/db/schema";
import { gatewaySecretOk } from "@/lib/env";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!gatewaySecretOk(req)) {
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