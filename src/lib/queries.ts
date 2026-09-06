import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentConfigs,
  conversations,
  errorLogs,
  messages,
  orders,
  restaurants,
  usageLogs,
} from "@/lib/db/schema";
import { daysBetween } from "@/lib/utils";
import { first } from "@/lib/db/query";

export interface SubscriptionInfo {
  daysLeft: number;
  totalDays: number;
  expired: boolean;
  expiresSoon: boolean;
}

export function subscriptionInfo(
  activatedAt: Date | null | undefined,
  subscriptionDays: number
): SubscriptionInfo {
  if (!activatedAt) {
    return { daysLeft: 0, totalDays: subscriptionDays, expired: false, expiresSoon: false };
  }
  const endsAt = new Date(activatedAt.getTime() + subscriptionDays * 24 * 60 * 60 * 1000);
  const daysLeft = Math.max(0, daysBetween(new Date(), endsAt));
  return {
    daysLeft,
    totalDays: subscriptionDays,
    expired: daysLeft <= 0,
    expiresSoon: daysLeft > 0 && daysLeft <= 7,
  };
}

export async function getDashboardStats() {
  const total = await db.select({ n: sql<number>`count(*)::int` }).from(restaurants);
  const linked = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(restaurants)
    .where(sql`(whatsapp_linked = true OR instagram_linked = true)`);
  const newOrders = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.status, "new"));
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthSpendRows = await db
    .select({ total: sql<number>`coalesce(sum(${usageLogs.costUsd}), 0)` })
    .from(usageLogs)
    .where(gte(usageLogs.createdAt, monthStart));
  const openErrors = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(errorLogs)
    .where(eq(errorLogs.resolved, false));

  return {
    restaurantCount: total[0].n,
    linkedCount: linked[0].n,
    newOrders: newOrders[0].n,
    monthSpend: monthSpendRows[0].total,
    openErrors: openErrors[0].n,
  };
}

export async function getRestaurantsOverview() {
  const rows = await db
    .select()
    .from(restaurants)
    .orderBy(desc(restaurants.createdAt));

  const result = [];
  for (const r of rows) {
    const [orderCount, convCount, errCount, spendRows] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(orders)
        .where(and(eq(orders.restaurantId, r.id), eq(orders.status, "new"))),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(conversations)
        .where(eq(conversations.restaurantId, r.id)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(errorLogs)
        .where(and(eq(errorLogs.restaurantId, r.id), eq(errorLogs.resolved, false))),
      db
        .select({ total: sql<number>`coalesce(sum(${usageLogs.costUsd}), 0)` })
        .from(usageLogs)
        .where(eq(usageLogs.restaurantId, r.id)),
    ]);

    const sub = subscriptionInfo(r.activatedAt, r.subscriptionDays);
    result.push({
      ...r,
      newOrders: orderCount[0].n,
      conversationCount: convCount[0].n,
      openErrors: errCount[0].n,
      totalSpend: spendRows[0].total,
      subscription: sub,
    });
  }
  return result;
}

export async function getRestaurantDetail(id: string) {
  const restaurant = await first(
    db.select().from(restaurants).where(eq(restaurants.id, id))
  );
  if (!restaurant) return null;

  const config = await first(
    db.select().from(agentConfigs).where(eq(agentConfigs.restaurantId, id))
  );

  const recentCounts = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(conversations).where(eq(conversations.restaurantId, id)),
    db.select({ n: sql<number>`count(*)::int` }).from(orders).where(eq(orders.restaurantId, id)),
  ]);

  return {
    ...restaurant,
    agent: config ?? null,
    conversationCount: recentCounts[0][0].n,
    orderCount: recentCounts[1][0].n,
  };
}

export async function getRestaurantConversations(restaurantId: string) {
  // Single query instead of N+1: one row per conversation with its last
  // message (lateral join) and new-order count, sorted by last activity.
  const rows = await db.execute(sql`
    select
      c.id,
      c.channel,
      c.remote_jid as "remoteJid",
      c.customer_name as "customerName",
      c.status,
      c.pinned,
      c.last_message_at as "lastMessageAt",
      c.created_at as "createdAt",
      lm.direction as "lm_direction",
      lm.text as "lm_text",
      lm.created_at as "lm_createdAt",
      lm.content_type as "lm_contentType",
      (select count(*)::int from repli.orders o
        where o.conversation_id = c.id and o.status = 'new') as "newOrders"
    from repli.conversations c
    left join lateral (
      select m.direction, m.text, m.created_at, m.content_type
      from repli.messages m
      where m.conversation_id = c.id
      order by m.created_at desc
      limit 1
    ) lm on true
    where c.restaurant_id = ${restaurantId}
    order by c.last_message_at desc
  `);

  const raw = rows as Array<Record<string, unknown>>;
  return raw.map((r) => ({
    id: String(r.id),
    restaurantId,
    channel: String(r.channel),
    remoteJid: String(r.remoteJid),
    customerName: (r.customerName as string | null) ?? null,
    status: String(r.status),
    pinned: Boolean(r.pinned),
    lastMessageAt: r.lastMessageAt as Date | null,
    createdAt: r.createdAt as Date | null,
    newOrders: Number(r.newOrders) || 0,
    lastMessage:
      r.lm_direction ?? r.lm_text ?? r.lm_contentType
        ? {
            direction: String(r.lm_direction),
            text: (r.lm_text as string | null) ?? null,
            contentType: String(r.lm_contentType),
            createdAt: r.lm_createdAt as Date | null,
          }
        : null,
  }));
}

export async function getConversationThread(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(200);
}

export async function getRestaurantOrders(restaurantId: string) {
  return db
    .select()
    .from(orders)
    .where(eq(orders.restaurantId, restaurantId))
    .orderBy(desc(orders.createdAt));
}

export async function getRestaurantUsage(restaurantId: string) {
  const logs = await db
    .select()
    .from(usageLogs)
    .where(eq(usageLogs.restaurantId, restaurantId))
    .orderBy(desc(usageLogs.createdAt))
    .limit(400);
  const total = await db
    .select({
      input: sql<number>`coalesce(sum(${usageLogs.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${usageLogs.outputTokens}), 0)`,
      cost: sql<number>`coalesce(sum(${usageLogs.costUsd}), 0)`,
      audio: sql<number>`coalesce(sum(${usageLogs.audioSeconds}), 0)`,
    })
    .from(usageLogs)
    .where(eq(usageLogs.restaurantId, restaurantId));
  return { logs, totals: total[0] };
}

export async function getRestaurantErrors(restaurantId: string) {
  return db
    .select()
    .from(errorLogs)
    .where(eq(errorLogs.restaurantId, restaurantId))
    .orderBy(desc(errorLogs.createdAt))
    .limit(100);
}

export async function getRecentErrors(limit = 30) {
  return db
    .select()
    .from(errorLogs)
    .orderBy(desc(errorLogs.createdAt))
    .limit(limit);
}

export async function getRestaurantByLinkToken(token: string) {
  return first(db.select().from(restaurants).where(eq(restaurants.linkToken, token)));
}

export async function findRestaurantByJid(
  channel: "whatsapp" | "instagram",
  jid: string
) {
  const where =
    channel === "whatsapp"
      ? eq(restaurants.whatsappJid, jid)
      : eq(restaurants.instagramUsername, jid);
  return first(db.select().from(restaurants).where(where));
}