import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants } from "@/lib/db/schema";
import { first } from "@/lib/db/query";
import { igCallbackUrl } from "../start/route";

export const runtime = "nodejs";
export const maxDuration = 30;

const GRAPH = "https://graph.instagram.com";

interface TokenResponse {
  access_token?: string;
  user_id?: number | string;
  expires_in?: number;
  error?: { message?: string; code?: number };
}

function redirectHome(state: string, ig: string): NextResponse {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const target = new URL(`/link/${encodeURIComponent(state)}`, base);
  target.searchParams.set("ig", ig);
  return NextResponse.redirect(target.toString());
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;

  if (!code || !state) {
    return redirectHome(state ?? "", "error");
  }
  if (!appId || !appSecret) {
    return redirectHome(state, "error");
  }

  const restaurant = await first(
    db
      .select()
      .from(restaurants)
      .where(eq(restaurants.linkToken, state))
  );
  if (!restaurant) {
    return redirectHome(state, "error");
  }

  try {
    const short = await exchangeCode(appId, appSecret, code);
    if (!short.access_token) {
      return redirectHome(state, "error");
    }

    const long = await exchangeForLongLived(appSecret, short.access_token);
    const token = long.access_token ?? short.access_token;

    const profile = await fetchIgProfile(String(short.user_id ?? ""), token);
    const igId = String(short.user_id ?? profile?.id ?? "");
    const username = profile?.username ?? null;

    if (!igId) {
      return redirectHome(state, "error");
    }

    await db
      .update(restaurants)
      .set({
        instagramIgId: igId,
        instagramUsername: username,
        instagramToken: token,
        instagramLinked: true,
        instagramStatus: "connected",
      })
      .where(eq(restaurants.id, restaurant.id));

    return redirectHome(state, "connected");
  } catch (err) {
    console.error("instagram oauth callback error", err);
    return redirectHome(state, "error");
  }
}

async function exchangeCode(
  appId: string,
  appSecret: string,
  code: string
): Promise<TokenResponse> {
  const res = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "authorization_code",
      redirect_uri: igCallbackUrl(),
      code,
    }),
  });
  return (await res.json()) as TokenResponse;
}

async function exchangeForLongLived(
  appSecret: string,
  accessToken: string
): Promise<TokenResponse> {
  const res = await fetch(`${GRAPH}/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: appSecret,
      access_token: accessToken,
    }),
  });
  return (await res.json()) as TokenResponse;
}

async function fetchIgProfile(
  igId: string,
  token: string
): Promise<{ id?: string; username?: string } | null> {
  if (!igId) return null;
  const url = new URL(`${GRAPH}/v22.0/${igId}`);
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", token);
  const res = await fetch(url.toString());
  if (!res.ok) return null;
  return (await res.json()) as { id?: string; username?: string };
}