import { desc, eq, sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import {
  errorLogs,
  messages,
  orders,
  restaurants,
  usageLogs,
} from "@/lib/db/schema";
import { daysBetween } from "@/lib/utils";
import { first } from "@/lib/db/query";

/**
 * Short-lived in-process cache for admin list queries so that button reloads
 * (which re-render the whole page) do not hit the remote Supabase on every
 * click. Revalidates after `ttl` seconds (15s default).
 */
function cached<A extends unknown[], T>(
  fn: (...args: A) => Promise<T>,
  key: string,
  ttl = 15
): (...args: A) => Promise<T> {
  return unstable_cache(fn, [key], { revalidate: ttl });
}

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
  const rows = (await db.execute(sql`
    select
      (select count(*)::int from repli.restaurants) as "restaurantCount",
      (select count(*)::int from repli.restaurants where whatsapp_linked = true or instagram_linked = true) as "linkedCount",
      (select count(*)::int from repli.orders where status = 'new') as "newOrders",
      (select coalesce(sum(cost_usd), 0)::float8 from repli.usage_logs where created_at >= date_trunc('month', now())) as "monthSpend",
      (select count(*)::int from repli.error_logs where resolved = false) as "openErrors"
  `)) as Array<Record<string, unknown>>;
  const s = rows[0];
  return {
    restaurantCount: Number(s.restaurantCount) || 0,
    linkedCount: Number(s.linkedCount) || 0,
    newOrders: Number(s.newOrders) || 0,
    monthSpend: Number(s.monthSpend) || 0,
    openErrors: Number(s.openErrors) || 0,
  };
}

export async function getRestaurantsOverview() {
  // One query with correlated subselects instead of 1 + 4×N round trips.
  const rows = (await db.execute(sql`
    select
      r.id, r.name, r.created_at as "createdAt",
      r.agent_enabled as "agentEnabled",
      r.activated_at as "activatedAt",
      r.subscription_days as "subscriptionDays",
      r.whatsapp_status as "whatsappStatus",
      r.instagram_status as "instagramStatus",
      r.whatsapp_linked as "whatsappLinked",
      r.instagram_linked as "instagramLinked",
      (select count(*)::int from repli.orders o where o.restaurant_id = r.id and o.status = 'new') as "newOrders",
      (select count(*)::int from repli.conversations c where c.restaurant_id = r.id) as "conversationCount",
      (select count(*)::int from repli.error_logs e where e.restaurant_id = r.id and e.resolved = false) as "openErrors",
      (select coalesce(sum(u.cost_usd), 0)::float8 from repli.usage_logs u where u.restaurant_id = r.id) as "totalSpend"
    from repli.restaurants r
    order by r.created_at desc
  `)) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const activatedAt = r.activatedAt as Date | null;
    const parsed = subscriptionInfo(activatedAt, Number(r.subscriptionDays));
    return {
      id: String(r.id),
      name: String(r.name ?? ""),
      createdAt: r.createdAt as Date,
      agentEnabled: Boolean(r.agentEnabled),
      activatedAt,
      subscriptionDays: Number(r.subscriptionDays) || 30,
      whatsappStatus: String(r.whatsappStatus ?? "disconnected"),
      instagramStatus: String(r.instagramStatus ?? "disconnected"),
      whatsappLinked: Boolean(r.whatsappLinked),
      instagramLinked: Boolean(r.instagramLinked),
      newOrders: Number(r.newOrders) || 0,
      conversationCount: Number(r.conversationCount) || 0,
      openErrors: Number(r.openErrors) || 0,
      totalSpend: Number(r.totalSpend) || 0,
      subscription: parsed,
    };
  });
}

export async function getRestaurantDetail(id: string) {
  const rows = (await db.execute(sql`
    select
      r.id, r.name, r.created_at as "createdAt",
      r.agent_enabled as "agentEnabled",
      r.activated_at as "activatedAt",
      r.subscription_days as "subscriptionDays",
      r.whatsapp_jid as "whatsappJid",
      r.whatsapp_linked as "whatsappLinked",
      r.whatsapp_status as "whatsappStatus",
      r.instagram_username as "instagramUsername",
      r.instagram_linked as "instagramLinked",
      r.instagram_status as "instagramStatus",
      r.instagram_token as "instagramToken",
      r.instagram_ig_id as "instagramIgId",
      r.menu_images as "menuImages",
      r.auto_menu_whatsapp as "autoMenuWhatsapp",
      r.auto_menu_instagram as "autoMenuInstagram",
      r.link_token as "linkToken",
      r.total_spend_usd as "totalSpendUsd",
      c.id as "c_id",
      c.business_name as "c_businessName",
      c.tone as "c_tone",
      c.languages as "c_languages",
      c.hours as "c_hours",
      c.delivery_policy as "c_deliveryPolicy",
      c.menu as "c_menu",
      c.policies as "c_policies",
      c.custom_instructions as "c_customInstructions",
      c.system_prompt as "c_systemPrompt",
      c.temperature as "c_temperature",
      c.ask_phone as "c_askPhone",
      c.ask_address as "c_askAddress",
      c.updated_at as "c_updatedAt",
      (select count(*)::int from repli.conversations x where x.restaurant_id = r.id) as "conversationCount",
      (select count(*)::int from repli.orders x where x.restaurant_id = r.id) as "orderCount"
    from repli.restaurants r
    left join repli.agent_configs c on c.restaurant_id = r.id
    where r.id = ${id}
  `)) as Array<Record<string, unknown>>;

  const row = rows[0];
  if (!row) return null;
  const config = row.c_id
    ? {
        id: String(row.c_id),
        restaurantId: id,
        businessName: String(row.c_businessName ?? ""),
        tone: String(row.c_tone ?? "friendly"),
        languages: String(row.c_languages ?? "ar,en"),
        hours: String(row.c_hours ?? ""),
        deliveryPolicy: String(row.c_deliveryPolicy ?? ""),
        menu: String(row.c_menu ?? ""),
        policies: String(row.c_policies ?? ""),
        customInstructions: String(row.c_customInstructions ?? ""),
        systemPrompt: String(row.c_systemPrompt ?? ""),
        temperature: Number(row.c_temperature ?? 0.7),
        askPhone: Boolean(row.c_askPhone),
        askAddress: Boolean(row.c_askAddress),
        updatedAt: row.c_updatedAt as Date,
      }
    : null;

  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    createdAt: row.createdAt as Date,
    agentEnabled: Boolean(row.agentEnabled),
    activatedAt: row.activatedAt as Date | null,
    subscriptionDays: Number(row.subscriptionDays) || 30,
    whatsappJid: (row.whatsappJid as string | null) ?? null,
    whatsappLinked: Boolean(row.whatsappLinked),
    whatsappStatus: String(row.whatsappStatus ?? "disconnected"),
    instagramUsername: (row.instagramUsername as string | null) ?? null,
    instagramLinked: Boolean(row.instagramLinked),
    instagramStatus: String(row.instagramStatus ?? "disconnected"),
    instagramToken: (row.instagramToken as string | null) ?? null,
    instagramIgId: (row.instagramIgId as string | null) ?? null,
    menuImages: String(row.menuImages ?? "[]"),
    autoMenuWhatsapp: Boolean(row.autoMenuWhatsapp),
    autoMenuInstagram: Boolean(row.autoMenuInstagram),
    linkToken: (row.linkToken as string | null) ?? null,
    totalSpendUsd: Number(row.totalSpendUsd) || 0,
    agent: config,
    conversationCount: Number(row.conversationCount) || 0,
    orderCount: Number(row.orderCount) || 0,
  };
}

export const getRestaurantConversations = cached(
  async (restaurantId: string) => {
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
  },
  "restaurant-conversations",
  15
);

export async function getConversationThread(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(200);
}

export const getRestaurantOrders = cached(
  async (restaurantId: string) =>
    db
      .select()
      .from(orders)
      .where(eq(orders.restaurantId, restaurantId))
      .orderBy(desc(orders.createdAt)),
  "restaurant-orders",
  15
);

export const getRestaurantUsage = cached(
  async (restaurantId: string) => {
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
  },
  "restaurant-usage",
  15
);

export const getRestaurantErrors = cached(
  async (restaurantId: string) =>
    db
      .select()
      .from(errorLogs)
      .where(eq(errorLogs.restaurantId, restaurantId))
      .orderBy(desc(errorLogs.createdAt))
      .limit(100),
  "restaurant-errors",
  15
);

export const getRecentErrors = cached(
  async (limit: number = 30) =>
    db
      .select()
      .from(errorLogs)
      .orderBy(desc(errorLogs.createdAt))
      .limit(limit),
  "recent-errors",
  15
);

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