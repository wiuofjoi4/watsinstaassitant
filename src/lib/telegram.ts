import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { first } from "@/lib/db/query";
import {
  restaurants,
  telegramBots,
  telegramOrderDeliveries,
  type TelegramBot,
  type TelegramOrderDelivery,
} from "@/lib/db/schema";
import { newId } from "@/lib/utils";
import type { AgentOrderResult } from "@/lib/agent/engine";

const TELEGRAM_API = "https://api.telegram.org";

type TgResponse = { ok: boolean; result?: unknown; description?: string };

async function tgCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
  timeoutMs = 8000
): Promise<TgResponse> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate: 0 },
    });
    const data = (await res.json().catch(() => null)) as TgResponse | null;
    return data && typeof data.ok === "boolean"
      ? data
      : { ok: false, description: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      description: err instanceof Error ? err.message : String(err),
    };
  }
}

function publicAppUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

export function escapeHtml(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function getTelegramBotUsername(
  token: string
): Promise<{ ok: boolean; username?: string; description?: string }> {
  const res = await tgCall(token, "getMe", {});
  const username = (res.result as { username?: string } | undefined)?.username;
  return { ok: res.ok, username, description: res.description };
}

export async function setTelegramWebhook(
  token: string,
  secret: string,
  restaurantId: string
): Promise<TgResponse> {
  const url = `${publicAppUrl()}/api/telegram/webhook?secret=${encodeURIComponent(
    secret
  )}&rid=${encodeURIComponent(restaurantId)}`;
  return tgCall(token, "setWebhook", {
    url,
    allowed_updates: ["message"],
    drop_pending_updates: true,
    max_connections: 1,
  });
}

export async function deleteTelegramWebhook(token: string): Promise<void> {
  await tgCall(token, "deleteWebhook", {});
}

export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  timeoutMs = 8000
): Promise<boolean> {
  const res = await tgCall(
    token,
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
    timeoutMs
  );
  return res.ok;
}

export function composeOrderText(
  restaurantName: string,
  requestedAt: Date,
  order: {
    items: { name: string; qty: number; price: number }[];
    total?: number;
    phone?: string | null;
    address?: string | null;
    customerName?: string | null;
  }
): string {
  const lines: string[] = [];
  lines.push(`📦 <b>طلب جديد — ${escapeHtml(restaurantName)}</b>`);
  lines.push(`🕒 التاريخ: ${escapeHtml(formatOrderDateTime(requestedAt))}`);
  if (order.customerName) {
    lines.push(`👤 الاسم: ${escapeHtml(order.customerName)}`);
  }
  if (order.phone) {
    lines.push(`📞 الهاتف: ${escapeHtml(order.phone)}`);
  }
  if (order.address) {
    lines.push(`🏠 العنوان: ${escapeHtml(order.address)}`);
  }
  lines.push("");
  lines.push("🛒 <b>الطلب</b>");
  const items = Array.isArray(order.items) ? order.items : [];
  for (const item of items) {
    const qty = Number(item.qty) || 1;
    const row = `• ${qty}× ${escapeHtml(item.name)}`;
    const price = Number(item.price);
    lines.push(
      price > 0 ? `${row} — ${price.toFixed(2)}` : row
    );
  }
  if (items.length === 0) lines.push("• —");
  const total = Number(order.total);
  if (total > 0) {
    lines.push("");
    lines.push(`💰 <b>الإجمالي: ${total.toFixed(2)}</b>`);
  }
  return lines.join("\n");
}

export function renderTelegramOrders(
  restaurantName: string,
  rows: TelegramOrderDelivery[]
): string {
  if (rows.length === 0) {
    return `📋 <b>${escapeHtml(restaurantName)}</b>\nلا توجد طلبات مؤكدة بعد.`;
  }
  const parts: string[] = [
    `📋 <b>${escapeHtml(restaurantName)} — الطلبات المؤكدة</b>`,
    `أحدث ${rows.length} طلب(طلبات):`,
    "",
  ];
  rows.forEach((row, i) => {
    parts.push(`<b>${i + 1}) تاريخ الطلب:</b> ${escapeHtml(formatOrderDateTime(row.requestedAt))}`);
    if (row.customerName) parts.push(`👤 الاسم: ${escapeHtml(row.customerName)}`);
    if (row.phone) parts.push(`📞 الهاتف: ${escapeHtml(row.phone)}`);
    if (row.address) parts.push(`🏠 العنوان: ${escapeHtml(row.address)}`);
    parts.push(`🛒 الطلب: ${escapeHtml(row.itemsJson)}`);
    const total = Number(row.total);
    if (total > 0) parts.push(`💰 الإجمالي: ${total.toFixed(2)}`);
    parts.push("");
  });
  return parts.join("\n");
}

export function formatOrderDateTime(ts: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ts);
}

/** Public-facing status used by the admin panel. The bot token NEVER leaves the server. */
export async function getTelegramBotStatus(
  restaurantId: string
): Promise<{
  configured: boolean;
  enabled: boolean;
  botUsername?: string | null;
  chatId?: string | null;
} | null> {
  const config = await first(
    db.select().from(telegramBots).where(eq(telegramBots.restaurantId, restaurantId))
  ).catch(() => null);
  if (!config) return null;
  return {
    configured: !!config.botToken,
    enabled: config.enabled,
    botUsername: config.botUsername,
    chatId: config.chatId,
  };
}

/**
 * Called when the agent confirms an order (items + phone + address known).
 * Best-effort and bounded: it must NEVER break or slow the customer's turn —
 * the reply already succeeded before this runs.
 */
export async function notifyTelegramOrder(
  restaurantId: string,
  order: AgentOrderResult
): Promise<void> {
  const config = await first(
    db
      .select()
      .from(telegramBots)
      .where(eq(telegramBots.restaurantId, restaurantId))
  ).catch(() => null);
  if (!config || !config.botToken || !config.enabled) return;

  const restaurant = await first(
    db
      .select({ name: restaurants.name })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
  ).catch(() => null);
  const restaurantName = restaurant?.name ?? "المطعم";

  const requestedAt = new Date();
  const text = composeOrderText(restaurantName, requestedAt, order);

  // Durable log — powers the public "any user can view" replies from the bot.
  await db
    .insert(telegramOrderDeliveries)
    .values({
      id: newId(),
      restaurantId,
      requestedAt,
      customerName: order.customerName ?? null,
      phone: order.phone ?? null,
      address: order.address ?? null,
      itemsJson: JSON.stringify(Array.isArray(order.items) ? order.items : []),
      total: Number(order.total) > 0 ? Number(order.total) : null,
      text,
    })
    .catch(() => {});

  if (config.chatId) {
    await sendTelegramMessage(config.botToken, config.chatId, text, 6000);
  }
}

export async function listTelegramOrderDeliveries(
  restaurantId: string,
  limit = 8
): Promise<TelegramOrderDelivery[]> {
  return db
    .select()
    .from(telegramOrderDeliveries)
    .where(eq(telegramOrderDeliveries.restaurantId, restaurantId))
    .orderBy(desc(telegramOrderDeliveries.requestedAt))
    .limit(limit)
    .catch(() => []);
}