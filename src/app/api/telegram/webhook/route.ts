import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { first } from "@/lib/db/query";
import { restaurants, telegramBots } from "@/lib/db/schema";
import {
  listTelegramOrderDeliveries,
  renderTelegramOrders,
  sendTelegramMessage,
} from "@/lib/telegram";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!secret) return new NextResponse("ok", { status: 200 });
  return NextResponse.json({ ok: true });
}

/**
 * Telegram webhook for every restaurant bot. The per-bot secret in the URL is
 * what ties an update to a restaurant. Any user who messages the bot gets the
 * current confirmed orders (date, order, address) — a public view.
 */
export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret") ?? "";
  if (!secret) {
    return new NextResponse("bad request", { status: 400 });
  }

  const config = await first(
    db
      .select()
      .from(telegramBots)
      .where(
        and(
          eq(telegramBots.webhookSecret, secret),
          eq(telegramBots.enabled, true)
        )
      )
  ).catch(() => null);
  if (!config) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  type TgUpdate = {
    message?: { chat?: { id?: number }; text?: string };
  };
  let update: TgUpdate = {};
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return NextResponse.json({ ok: true });
  }
  const chatId = update?.message?.chat?.id;
  if (typeof chatId !== "number") {
    return NextResponse.json({ ok: true });
  }

  // Remember which chat uses this bot — confirmed orders are pushed there.
  if (config.chatId !== String(chatId)) {
    await db
      .update(telegramBots)
      .set({ chatId: String(chatId), updatedAt: new Date() })
      .where(eq(telegramBots.id, config.id))
      .catch(() => {});
  }

  const restaurant = await first(
    db.select({ name: restaurants.name }).from(restaurants).where(
      eq(restaurants.id, config.restaurantId)
    )
  ).catch(() => null);
  const deliveries = await listTelegramOrderDeliveries(config.restaurantId, 8);
  const text = renderTelegramOrders(restaurant?.name ?? "المطعم", deliveries);

  const ok = await sendTelegramMessage(config.botToken, String(chatId), text);
  // On failure, non-2xx lets Telegram retry with backoff.
  return NextResponse.json({ ok }, { status: ok ? 200 : 500 });
}