import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { first } from "@/lib/db/query";
import { newId } from "@/lib/utils";
import {
  conversations,
  errorLogs,
  messages,
  orders,
  restaurants,
  telegramBots,
  telegramOrderDeliveries,
} from "@/lib/db/schema";
import { sendTelegramMessage } from "@/lib/telegram";
import { notifyTelegramOrder } from "@/lib/telegram";
import type { AgentOrderResult } from "@/lib/agent/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authOk(req: Request): boolean {
  const expected = process.env.GATEWAY_SECRET;
  const provided = req.headers.get("x-gateway-secret") ?? "";
  return expected !== undefined && expected !== "" && provided === expected;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const action = req.nextUrl.searchParams.get("action");
  if (action === "cfg") {
    const rows = await db
      .select({
        id: restaurants.id,
        name: restaurants.name,
        agentEnabled: restaurants.agentEnabled,
        autoMenuWhatsapp: restaurants.autoMenuWhatsapp,
        autoMenuInstagram: restaurants.autoMenuInstagram,
      })
      .from(restaurants)
      .limit(10);
    return NextResponse.json({ restaurants: rows });
  }
  if (action === "testAfter") {
    after(async () => {
      await db
        .insert(errorLogs)
        .values({
          id: newId(),
          restaurantId: "seed-restaurant-1",
          source: "diag",
          message: `diag: after() test fired at ${new Date().toISOString()}`,
        })
        .catch(() => {});
    });
    return NextResponse.json({ scheduled: true, at: new Date().toISOString() });
  }
  if (action === "logs") {
    const rows = await db
      .select({
        createdAt: errorLogs.createdAt,
        restaurantId: errorLogs.restaurantId,
        message: errorLogs.message,
        stack: errorLogs.stack,
      })
      .from(errorLogs)
      .orderBy(desc(errorLogs.createdAt))
      .limit(15);
    return NextResponse.json({ errorLogs: rows });
  }
  if (action === "deliveries") {
    const rows = await db
      .select({
        id: telegramOrderDeliveries.id,
        requestedAt: telegramOrderDeliveries.requestedAt,
        restaurantId: telegramOrderDeliveries.restaurantId,
        customerName: telegramOrderDeliveries.customerName,
        phone: telegramOrderDeliveries.phone,
        total: telegramOrderDeliveries.total,
        text: telegramOrderDeliveries.text,
      })
      .from(telegramOrderDeliveries)
      .limit(10);
    return NextResponse.json({ deliveries: rows });
  }
  if (action === "convs") {
    const rows = await db
      .select({
        id: conversations.id,
        restaurantId: conversations.restaurantId,
        status: conversations.status,
        lastMessageAt: conversations.lastMessageAt,
      })
      .from(conversations)
      .orderBy(desc(conversations.lastMessageAt))
      .limit(8);
    return NextResponse.json({ conversations: rows });
  }
  if (action === "messages") {
    const convId = req.nextUrl.searchParams.get("conversation");
    if (!convId) return NextResponse.json({ error: "missing conversation" });
    const rows = await db
      .select({
        direction: messages.direction,
        contentType: messages.contentType,
        text: messages.text,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(desc(messages.createdAt))
      .limit(25);
    return NextResponse.json({ thread: rows.reverse() });
  }

  if (action === "cleanupTest") {
    await db
      .delete(telegramOrderDeliveries)
      .where(eq(telegramOrderDeliveries.customerName, "اختبار فني"))
      .catch(() => {});
    const left = await db
      .select({ count: sql<number>`count(*)` })
      .from(telegramOrderDeliveries);
    return NextResponse.json({ ok: true, remaining: left[0]?.count ?? 0 });
  }

  if (action === "simulateNotify") {
    const sampleOrder: AgentOrderResult = {
      ready: true,
      items: [{ name: "شاورما دجاج", qty: 3, price: 3.5 }],
      total: 10.5,
      phone: "07700000000",
      address: "عنوان اختبار",
      customerName: "اختبار فني",
    };
    try {
      await notifyTelegramOrder("seed-restaurant-1", sampleOrder);
      const rows = await db
        .select({
          id: telegramOrderDeliveries.id,
          requestedAt: telegramOrderDeliveries.requestedAt,
          customerName: telegramOrderDeliveries.customerName,
          total: telegramOrderDeliveries.total,
        })
        .from(telegramOrderDeliveries)
        .orderBy(desc(telegramOrderDeliveries.requestedAt))
        .limit(5);
      return NextResponse.json({ ok: true, rows });
    } catch (err) {
      return NextResponse.json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : null,
      });
    }
  }

  if (action === "testTelegram") {
    const config = await first(
      db.select().from(telegramBots).where(eq(telegramBots.restaurantId, "seed-restaurant-1"))
    ).catch(() => null);
    if (!config || !config.botToken || !config.chatId) {
      return NextResponse.json({ ok: false, error: "no telegram config/chatId" });
    }
    const testText =
      "🧪 <b>اختبار إرسال</b>\nهذه رسالة تحقق من أن تدفق الطلبات يوصل لبوت التلغرام. إذا وصلتك، كل شيء يعمل.";
    try {
      const sent = await sendTelegramMessage(config.botToken, config.chatId, testText, 6000);
      return NextResponse.json({ ok: true, attempted: true, sent });
    } catch (err) {
      return NextResponse.json({
        ok: false,
        attempted: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const convId = req.nextUrl.searchParams.get("conversation");
  const [tables, restList, bots, deliv, errs, convs, orderList, thread] =
    await Promise.all([
    db
      .execute(
        sql`select table_name from information_schema.tables where table_schema='repli' order by table_name`
      )
      .then((r) => r.map((x) => (x as { table_name: string }).table_name))
      .catch(() => null),
    db
      .select({ id: restaurants.id, name: restaurants.name, agentEnabled: restaurants.agentEnabled })
      .from(restaurants)
      .orderBy(desc(restaurants.createdAt))
      .limit(10)
      .catch(() => []),
    db
      .select({
        restaurantId: telegramBots.restaurantId,
        enabled: telegramBots.enabled,
        chatId: telegramBots.chatId,
        hasToken: sql<boolean>`${telegramBots.botToken} <> ''`,
        hasUsername: sql<boolean>`${telegramBots.botUsername} IS NOT NULL`,
        hasSecret: sql<boolean>`${telegramBots.webhookSecret} <> ''`,
        updatedAt: telegramBots.updatedAt,
      })
      .from(telegramBots)
      .catch(() => []),
    db
      .select({
        restaurantId: telegramOrderDeliveries.restaurantId,
        requestedAt: telegramOrderDeliveries.requestedAt,
        customerName: telegramOrderDeliveries.customerName,
        total: telegramOrderDeliveries.total,
        textLen: sql`char_length(${telegramOrderDeliveries.text})`,
      })
      .from(telegramOrderDeliveries)
      .orderBy(desc(telegramOrderDeliveries.requestedAt))
      .limit(6)
      .catch(() => []),
    db
      .select({
        createdAt: errorLogs.createdAt,
        restaurantId: errorLogs.restaurantId,
        message: errorLogs.message,
      })
      .from(errorLogs)
      .orderBy(desc(errorLogs.createdAt))
      .limit(6)
      .catch(() => []),
    db
      .select({
        id: conversations.id,
        restaurantId: conversations.restaurantId,
        status: conversations.status,
        lastMessageAt: conversations.lastMessageAt,
      })
      .from(conversations)
      .orderBy(desc(conversations.lastMessageAt))
      .limit(5)
      .catch(() => []),
    db
      .select({
        restaurantId: orders.restaurantId,
        status: orders.status,
        total: orders.total,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(4)
      .catch(() => []),
    convId
      ? db
          .select({
            direction: messages.direction,
            contentType: messages.contentType,
            text: messages.text,
            status: messages.status,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(eq(messages.conversationId, convId))
          .orderBy(desc(messages.createdAt))
          .limit(12)
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  return NextResponse.json({
    tables,
    restaurants: restList,
    telegrams: bots,
    deliveries: deliv,
    errorLogs: errs,
    conversations: convs,
    orders: orderList,
    thread: thread ? thread.reverse() : undefined,
    now: new Date().toISOString(),
  });
}