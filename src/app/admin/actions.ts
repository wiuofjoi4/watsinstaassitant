"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentConfigs, errorLogs, orders, restaurants } from "@/lib/db/schema";
import { buildSystemPrompt } from "@/lib/agent/prompt";
import { adminCookieMaxAge, adminCookieValue, isAdmin } from "@/lib/auth";
import { newId, randomToken } from "@/lib/utils";
import { first } from "@/lib/db/query";

export async function login(_prev: unknown, formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const envPassword = process.env.ADMIN_PASSWORD;
  if (envPassword && password === envPassword) {
    const jar = await cookies();
    jar.set("admin_session", adminCookieValue(envPassword), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: adminCookieMaxAge(),
      path: "/",
    });
    redirect("/admin");
  }
  return { error: "Invalid password." };
}

export async function logout() {
  const jar = await cookies();
  jar.delete("admin_session");
  redirect("/login");
}

async function guard() {
  if (!(await isAdmin())) {
    redirect("/login");
  }
}

export async function createRestaurant(formData: FormData) {
  await guard();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Restaurant name is required.");

  const id = newId();
  const now = new Date();
  await db
    .insert(restaurants)
    .values({
      id,
      name,
      createdAt: now,
      agentEnabled: true,
    });
  await db
    .insert(agentConfigs)
    .values({
      id: newId(),
      restaurantId: id,
      businessName: name,
      updatedAt: now,
    });
  revalidatePath("/admin/restaurants");
  redirect(`/admin/restaurants/${id}?tab=agent`);
}

export async function saveAgentConfig(formData: FormData) {
  await guard();
  const restaurantId = String(formData.get("restaurantId"));
  const restaurant = await first(
    db.select().from(restaurants).where(eq(restaurants.id, restaurantId))
  );
  if (!restaurant) return;
  const existing = await first(
    db.select().from(agentConfigs).where(eq(agentConfigs.restaurantId, restaurantId))
  );

  const update: Partial<typeof agentConfigs.$inferInsert> = {
    businessName: String(formData.get("businessName") ?? "").trim(),
    tone: String(formData.get("tone") ?? "friendly"),
    languages: String(formData.get("languages") ?? "ar,en"),
    hours: String(formData.get("hours") ?? ""),
    deliveryPolicy: String(formData.get("deliveryPolicy") ?? ""),
    menu: String(formData.get("menu") ?? ""),
    policies: String(formData.get("policies") ?? ""),
    customInstructions: String(formData.get("customInstructions") ?? ""),
    temperature: Number(formData.get("temperature") ?? 0.7),
    askPhone: formData.get("askPhone") === "on",
    askAddress: formData.get("askAddress") === "on",
    updatedAt: new Date(),
  };

  const merged: (typeof agentConfigs.$inferSelect) = {
    id: existing?.id ?? newId(),
    restaurantId,
    businessName: update.businessName ?? "",
    tone: update.tone ?? "friendly",
    languages: update.languages ?? "ar,en",
    hours: update.hours ?? "",
    deliveryPolicy: update.deliveryPolicy ?? "",
    menu: update.menu ?? "",
    policies: update.policies ?? "",
    customInstructions: update.customInstructions ?? "",
    systemPrompt: existing?.systemPrompt ?? "",
    temperature: update.temperature ?? 0.7,
    askPhone: update.askPhone ?? true,
    askAddress: update.askAddress ?? true,
    updatedAt: new Date(),
  };
  merged.systemPrompt = buildSystemPrompt({ restaurant, config: merged });

  if (existing) {
    await db
      .update(agentConfigs)
      .set({ ...update, systemPrompt: merged.systemPrompt })
      .where(eq(agentConfigs.restaurantId, restaurantId));
  } else {
    await db
      .insert(agentConfigs)
      .values({ id: newId(), restaurantId, ...update, systemPrompt: merged.systemPrompt });
  }
  revalidatePath(`/admin/restaurants/${restaurantId}`);
}

export async function regeneratePrompt(formData: FormData) {
  await guard();
  const restaurantId = String(formData.get("restaurantId"));
  const config = await first(
    db.select().from(agentConfigs).where(eq(agentConfigs.restaurantId, restaurantId))
  );
  if (!config) return;
  const restaurant = await first(
    db.select().from(restaurants).where(eq(restaurants.id, restaurantId))
  );
  if (!restaurant) return;
  const prompt = buildSystemPrompt({ restaurant, config });
  await db
    .update(agentConfigs)
    .set({ systemPrompt: prompt, updatedAt: new Date() })
    .where(eq(agentConfigs.restaurantId, restaurantId));
  revalidatePath(`/admin/restaurants/${restaurantId}`);
}

export async function toggleAgent(formData: FormData) {
  await guard();
  const restaurantId = String(formData.get("restaurantId"));
  const restaurant = await first(
    db.select().from(restaurants).where(eq(restaurants.id, restaurantId))
  );
  if (!restaurant) return;
  const next = restaurant.agentEnabled ? false : true;
  const data: { agentEnabled: boolean; activatedAt?: Date } = { agentEnabled: next };
  if (next && !restaurant.activatedAt) {
    data.activatedAt = new Date();
  }
  await db.update(restaurants).set(data).where(eq(restaurants.id, restaurantId));
  revalidatePath(`/admin/restaurants/${restaurantId}`);
  revalidatePath("/admin/restaurants");
  revalidatePath("/admin");
}

export async function generateLink(formData: FormData) {
  await guard();
  const restaurantId = String(formData.get("restaurantId"));
  const token = randomToken();
  await db
    .update(restaurants)
    .set({
      linkToken: token,
      whatsappStatus: "waiting",
      instagramStatus: "waiting",
    })
    .where(eq(restaurants.id, restaurantId));
  revalidatePath(`/admin/restaurants/${restaurantId}`);
}

export async function connectInstagram(formData: FormData) {
  await guard();
  const restaurantId = String(formData.get("restaurantId"));
  const igId = String(formData.get("igId") ?? "").trim();
  const username = String(formData.get("username") ?? "").trim();
  const accessToken = String(formData.get("accessToken") ?? "").trim();
  if (!igId || !accessToken) throw new Error("Instagram account ID and access token are required.");

  await db
    .update(restaurants)
    .set({
      instagramIgId: igId,
      instagramUsername: username || null,
      instagramToken: accessToken,
      instagramLinked: true,
      instagramStatus: "connected",
    })
    .where(eq(restaurants.id, restaurantId));
  revalidatePath(`/admin/restaurants/${restaurantId}`);
}

export async function disconnectInstagram(formData: FormData) {
  await guard();
  const restaurantId = String(formData.get("restaurantId"));
  await db
    .update(restaurants)
    .set({
      instagramIgId: null,
      instagramUsername: null,
      instagramToken: null,
      instagramLinked: false,
      instagramStatus: "disconnected",
    })
    .where(eq(restaurants.id, restaurantId));
  revalidatePath(`/admin/restaurants/${restaurantId}`);
}

export async function setOrderStatus(formData: FormData) {
  await guard();
  const orderId = String(formData.get("orderId"));
  const status = String(formData.get("status")) as
    | "new"
    | "pinned"
    | "preparing"
    | "done"
    | "declined";
  const allowed = ["new", "pinned", "preparing", "done", "declined"] as const;
  if (!allowed.includes(status)) return;
  await db.update(orders).set({ status }).where(eq(orders.id, orderId));
  revalidatePath(`/admin/restaurants/${String(formData.get("restaurantId") ?? "")}?tab=orders`);
}

export async function resolveError(formData: FormData) {
  await guard();
  const errorId = String(formData.get("errorId"));
  await db
    .update(errorLogs)
    .set({ resolved: true })
    .where(eq(errorLogs.id, errorId));
  revalidatePath(`/admin/restaurants/${String(formData.get("restaurantId") ?? "")}?tab=errors`);
}

interface MenuImageRaw {
  id: string;
  mime: string;
  base64: string;
}

function parseMenuImages(raw: string | null | undefined): MenuImageRaw[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as MenuImageRaw[];
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x) => x && typeof x.base64 === "string" && typeof x.mime === "string"
    );
  } catch {
    return [];
  }
}

const MAX_MENU_IMAGES = 8;
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

export async function saveMenuPrefs(formData: FormData) {
  await guard();
  const restaurantId = String(formData.get("restaurantId"));
  await db
    .update(restaurants)
    .set({
      autoMenuWhatsapp: formData.get("autoMenuWhatsapp") === "on",
      autoMenuInstagram: formData.get("autoMenuInstagram") === "on",
    })
    .where(eq(restaurants.id, restaurantId));
  revalidatePath(`/admin/restaurants/${restaurantId}`);
}

export async function addMenuImages(formData: FormData) {
  await guard();
  const restaurantId = String(formData.get("restaurantId"));
  const restaurant = await first(
    db.select().from(restaurants).where(eq(restaurants.id, restaurantId))
  );
  if (!restaurant) return;

  const current = parseMenuImages(restaurant.menuImages);
  const files = formData.getAll("images") as File[];
  const added: MenuImageRaw[] = [];
  for (const file of files) {
    if (current.length + added.length >= MAX_MENU_IMAGES) break;
    if (!file.type.startsWith("image/")) continue;
    if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    added.push({
      id: newId(),
      mime: file.type,
      base64: Buffer.from(bytes).toString("base64"),
    });
  }
  if (added.length === 0) return;

  await db
    .update(restaurants)
    .set({ menuImages: JSON.stringify([...current, ...added]) })
    .where(eq(restaurants.id, restaurantId));
  revalidatePath(`/admin/restaurants/${restaurantId}`);
}

export async function removeMenuImage(formData: FormData) {
  await guard();
  const restaurantId = String(formData.get("restaurantId"));
  const index = Number(formData.get("index"));
  const restaurant = await first(
    db.select().from(restaurants).where(eq(restaurants.id, restaurantId))
  );
  if (!restaurant) return;
  const current = parseMenuImages(restaurant.menuImages);
  if (!Number.isInteger(index) || index < 0 || index >= current.length) return;
  await db
    .update(restaurants)
    .set({ menuImages: JSON.stringify(current.filter((_, i) => i !== index)) })
    .where(eq(restaurants.id, restaurantId));
  revalidatePath(`/admin/restaurants/${restaurantId}`);
}