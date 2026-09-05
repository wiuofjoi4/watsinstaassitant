import { NextResponse } from "next/server";
import { getRestaurantByLinkToken } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = String(searchParams.get("token") ?? "");
  if (!token) {
    return NextResponse.json({ error: "missing token" }, { status: 400 });
  }

  const restaurant = await getRestaurantByLinkToken(decodeURIComponent(token));
  if (!restaurant) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({
    linked: restaurant.whatsappLinked,
    status: restaurant.whatsappStatus ?? null,
    jid: restaurant.whatsappJid ?? null,
  });
}