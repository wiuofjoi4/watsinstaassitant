import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants } from "@/lib/db/schema";
import { first } from "@/lib/db/query";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const restaurant = await first(
    db
      .select()
      .from(restaurants)
      .where(eq(restaurants.linkToken, token))
  );
  if (!restaurant) {
    return NextResponse.json({ error: "Invalid link token" }, { status: 404 });
  }

  const appId = process.env.INSTAGRAM_APP_ID;
  const callbackUrl = igCallbackUrl();
  if (!appId || !process.env.INSTAGRAM_APP_SECRET) {
    return NextResponse.json(
      { error: "Instagram OAuth is not configured yet by the team" },
      { status: 503 }
    );
  }

  const scope = "instagram_business_basic,instagram_manage_messages";
  const authorize = new URL("https://api.instagram.com/oauth/authorize");
  authorize.searchParams.set("client_id", appId);
  authorize.searchParams.set("redirect_uri", callbackUrl);
  authorize.searchParams.set("scope", scope);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", token);

  return NextResponse.redirect(authorize.toString());
}

export function igCallbackUrl(): string {
  return (
    process.env.INSTAGRAM_CALLBACK_URL ??
    `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/instagram/oauth/callback`
  );
}