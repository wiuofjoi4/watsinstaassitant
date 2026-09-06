import OpenAI from "openai";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentConfigs,
  conversations,
  errorLogs,
  messages,
  restaurants,
  usageLogs,
} from "@/lib/db/schema";
import { newId } from "@/lib/utils";
import { first } from "@/lib/db/query";
import { buildSystemPrompt, type BusinessProfile } from "./prompt";
import {
  completeWithFallback,
  estimateCostUsd,
  getAgentModel,
  getOpenAI,
  getProvider,
  TRANSCRIBE_MODEL,
} from "@/lib/ai/client";

export type Channel = "whatsapp" | "instagram";
export type IncomingContentType = "text" | "image" | "voice" | "video";

export interface IncomingMessageInput {
  restaurantId: string;
  channel: Channel;
  remoteJid: string;
  customerName?: string | null;
  contentType: IncomingContentType;
  text?: string | null;
  mediaUrl?: string | null;
  mediaMime?: string | null;
  mediaBase64?: string | null;
  messageId?: string | null;
}

export interface AgentOrderResult {
  ready: boolean;
  items: { name: string; qty: number; price: number }[];
  total?: number;
  phone?: string | null;
  address?: string | null;
  customerName?: string | null;
}

export interface AgentReply {
  text: string;
  transcribedFromVoice?: string | null;
  order?: AgentOrderResult | null;
  costUsd: number;
  usedModel: string;
}

export interface MenuImage {
  id: string;
  mime: string;
  base64: string;
  url: string;
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

const HISTORY_LIMIT = 24;

async function getBusiness(restaurantId: string): Promise<BusinessProfile | null> {
  const restaurant = await first(
    db.select().from(restaurants).where(eq(restaurants.id, restaurantId))
  );
  if (!restaurant) return null;

  let config = await first(
    db.select().from(agentConfigs).where(eq(agentConfigs.restaurantId, restaurantId))
  );

  if (!config) {
    const id = newId();
    config = {
      id,
      restaurantId,
      businessName: restaurant.name,
      tone: "friendly",
      languages: "ar,en",
      hours: "",
      deliveryPolicy: "",
      menu: "",
      policies: "",
      customInstructions: "",
      systemPrompt: "",
      temperature: 0.7,
      askPhone: true,
      askAddress: true,
      updatedAt: new Date(),
    };
    await db.insert(agentConfigs).values(config);
  }

  return { restaurant, config };
}

async function upsertConversation(
  restaurantId: string,
  channel: Channel,
  remoteJid: string,
  customerName?: string | null
) {
  let conversation = await first(
    db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.restaurantId, restaurantId),
          eq(conversations.channel, channel),
          eq(conversations.remoteJid, remoteJid)
        )
      )
  );

  if (!conversation) {
    const id = newId();
    await db
      .insert(conversations)
      .values({
        id,
        restaurantId,
        channel,
        remoteJid,
        customerName: customerName ?? null,
        status: "open",
        pinned: false,
        lastMessageAt: new Date(),
      });
    conversation = await first(
      db.select().from(conversations).where(eq(conversations.id, id))
    );
  } else if (customerName && conversation.customerName !== customerName) {
    await db
      .update(conversations)
      .set({ customerName, lastMessageAt: new Date() })
      .where(eq(conversations.id, conversation.id));
  } else {
    await db
      .update(conversations)
      .set({ lastMessageAt: new Date() })
      .where(eq(conversations.id, conversation.id));
  }

  return conversation!;
}

async function storeMessage(data: {
  conversationId: string;
  direction: "in" | "out";
  contentType: IncomingContentType;
  text?: string | null;
  mediaUrl?: string | null;
  mediaMime?: string | null;
  transcription?: string | null;
  status?: "sent" | "delivered" | "failed";
  error?: string | null;
}) {
  await db
    .insert(messages)
    .values({
      id: newId(),
      conversationId: data.conversationId,
      direction: data.direction,
      contentType: data.contentType,
      text: data.text ?? null,
      mediaUrl: data.mediaUrl ?? null,
      mediaMime: data.mediaMime ?? null,
      transcription: data.transcription ?? null,
      status: data.status ?? "sent",
      error: data.error ?? null,
    });
}

async function transcribeVoice(input: IncomingMessageInput): Promise<string | null> {
  const client = getOpenAI();
  if (!client) return null;

  let fileData: Buffer | null = null;
  if (input.mediaBase64) {
    fileData = Buffer.from(input.mediaBase64, "base64");
  } else if (input.mediaUrl) {
    const res = await fetch(input.mediaUrl);
    if (!res.ok) return null;
    fileData = Buffer.from(await res.arrayBuffer());
  }
  if (!fileData || fileData.length === 0) return null;

  const mime = input.mediaMime ?? "audio/mpeg";
  const format = (mime.split("/")[1] ?? "mpeg").replace("mp4", "m4a");

  try {
    if (getProvider() === "gemini") {
      const res = await completeWithFallback(client, {
        model: getAgentModel(),
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are a speech-to-text engine. Reply with ONLY the exact transcription text, no commentary.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribe this audio." },
              { type: "input_audio", input_audio: { data: fileData.toString("base64"), format } },
            ] as never,
          } as OpenAI.Chat.Completions.ChatCompletionMessageParam,
        ],
      });
      return res.choices[0]?.message?.content?.trim() || null;
    }

    const plain = fileData.buffer.slice(
      fileData.byteOffset,
      fileData.byteOffset + fileData.byteLength
    ) as ArrayBuffer;
    const blob = new Blob([plain], { type: mime });
    const file = new File([blob], `voice.${format}`, {
      type: mime,
    });
    const transcription = await client.audio.transcriptions.create({
      model: TRANSCRIBE_MODEL,
      file,
    });
    return transcription.text || null;
  } catch (err) {
    console.error("transcribe error", err);
    return null;
  }
}

function toHistory(rows: { direction: string; text: string | null }[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (const row of rows) {
    if (!row.text) continue;
    history.push(
      row.direction === "in"
        ? { role: "user", content: row.text }
        : { role: "assistant", content: row.text }
    );
  }
  return history;
}

async function buildMessages(
  profile: BusinessProfile,
  conversationId: string,
  input: IncomingMessageInput,
  menuNote?: string
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
  const historyRows = await db
    .select({ direction: messages.direction, text: messages.text })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_LIMIT);

  const history = historyRows.reverse();
  const historyMessages = toHistory(history);

  const systemPrompt =
    (profile.config.systemPrompt || buildSystemPrompt(profile)) +
    (menuNote ? `\n\n${menuNote}` : "");
  const currentUserText = input.text ?? "";

  let content: OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"] =
    currentUserText;

  if (input.contentType === "image" || input.contentType === "video") {
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    parts.push({
      type: "text",
      text: currentUserText || "The customer sent this image/video.",
    });
    if (input.mediaBase64 && input.mediaMime) {
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${input.mediaMime};base64,${input.mediaBase64}`,
        },
      });
    } else if (input.mediaUrl) {
      parts.push({ type: "image_url", image_url: { url: input.mediaUrl } });
    }
    content = parts;
  }

  return [
    { role: "system", content: systemPrompt },
    ...historyMessages,
    { role: "user", content },
  ];
}

export interface RunResult {
  replyText: string;
  transcription?: string | null;
  order?: AgentOrderResult | null;
  costUsd: number;
  model: string;
  menuImages?: MenuImage[];
  createOrderProps?: Partial<{
    customerName: string | null;
    phone: string | null;
    address: string | null;
  }>;
}

async function extractOrder(
  profile: BusinessProfile,
  conversationId: string
): Promise<AgentOrderResult | null> {
  const client = getOpenAI();
  if (!client) return null;

  const historyRows = await db
    .select({ direction: messages.direction, text: messages.text })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(30);
  const historyMessages = toHistory(historyRows.reverse());

  const payload = JSON.stringify({
    ready: false,
    items: [],
    total: null,
    phone: null,
    address: null,
    customerName: null,
  });

  try {
    const res = await completeWithFallback(client, {
      model: getAgentModel(),
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            `You extract order details from a restaurant customer conversation.`,
            `Only set "ready" to true when items AND the customer's phone are confirmed.`,
            `Return strictly this JSON shape: ${payload}`,
            `"items" is an array of {name: string, qty: number, price: number}. Use the menu prices above; if unsure, keep the products the customer agreed on and price=0.`,
            `"total" is the sum. "phone" and "address" may be null if not mentioned.`,
          ].join("\n"),
        },
        ...historyMessages,
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw.startsWith("```") ? raw.replace(/```json|```/g, "").trim() : raw) as AgentOrderResult;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function isOrderMessage(
  profile: BusinessProfile,
  conversationId: string,
  currentText: string
): Promise<boolean> {
  const client = getOpenAI();
  if (!client) return false;
  const trimmed = currentText.trim();
  if (!trimmed) return false;

  const historyRows = await db
    .select({ direction: messages.direction, text: messages.text })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(14);
  const historyMessages = toHistory(historyRows.reverse()).slice(-10);

  try {
    const res = await completeWithFallback(client, {
      model: getAgentModel(),
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            `You classify a restaurant customer's latest message.`,
            `"isOrder": true only when the customer is requesting to PURCHASE/ORDER food items now (e.g. "أريد 2 شاورما", "أبغى برغر كبير", "اطلب لي كولا", "نعم أريد أن أطلب").`,
            `"isOrder": false for questions and small talk (e.g. "مرحبا", "عندكم منيو؟", "كم سعر الشاورما؟", "وش تعملون؟").`,
            `Reply only with JSON: {"isOrder": true or false}.`,
          ].join("\n"),
        },
        ...historyMessages,
        { role: "user", content: trimmed },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(
      raw.startsWith("```") ? raw.replace(/```json|```/g, "").trim() : raw
    ) as { isOrder?: boolean };
    return parsed.isOrder === true;
  } catch {
    return false;
  }
}

export async function handleIncomingMessage(
  input: IncomingMessageInput
): Promise<RunResult | null> {
  const profile = await getBusiness(input.restaurantId);
  if (!profile) return null;
  if (!profile.restaurant.agentEnabled) return { replyText: "", costUsd: 0, model: getAgentModel() };

  const conversation = await upsertConversation(
    input.restaurantId,
    input.channel,
    input.remoteJid,
    input.customerName
  );

  let transcription: string | null = null;
  let effectiveText = input.text ?? "";
  if (input.contentType === "voice") {
    transcription = await transcribeVoice(input);
    effectiveText = transcription ?? input.text ?? "";
    if (transcription) {
      input.text = effectiveText;
    }
  }

  await storeMessage({
    conversationId: conversation.id,
    direction: "in",
    contentType: input.contentType,
    text: input.text ?? null,
    mediaUrl: input.mediaUrl ?? null,
    mediaMime: input.mediaMime ?? null,
    transcription: input.contentType === "voice" ? transcription : null,
  });

  const client = getOpenAI();
  let replyText = "";
  let costUsd = 0;
  const usedModel = getAgentModel();

  let sendMenuImages = false;
  const rawMenuImages = parseMenuImages(profile.restaurant.menuImages);
  const menuToggle =
    input.channel === "whatsapp"
      ? profile.restaurant.autoMenuWhatsapp
      : profile.restaurant.autoMenuInstagram;
  if (menuToggle && rawMenuImages.length > 0 && client) {
    const lastOut = await first(
      db
        .select({ contentType: messages.contentType })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversation.id),
            eq(messages.direction, "out")
          )
        )
        .orderBy(desc(messages.createdAt))
        .limit(1)
    );
    const alreadySentMenu = lastOut?.contentType === "image";
    if (!alreadySentMenu) {
      const isOrder = await isOrderMessage(
        profile,
        conversation.id,
        effectiveText
      );
      sendMenuImages = !isOrder;
    }
  }

  if (!client || effectiveText.trim() === "") {
    replyText =
      "Sorry, I couldn't process that. Could you send it again as text? 😊";
  } else {
    try {
      const messagesList = await buildMessages(
        profile,
        conversation.id,
        input,
        sendMenuImages
          ? `Note for THIS reply only: you will also send the customer the menu pictures along with your text. Acknowledge in one short line that you are sending the menu, and do NOT repeat the whole menu in text.`
          : undefined
      );
      const res = await completeWithFallback(client, {
        model: getAgentModel(),
        temperature: profile.config.temperature,
        messages: messagesList,
      });
      replyText = res.choices[0]?.message?.content?.trim() ?? "";
      const usage = res.usage;
      const inTok = usage?.prompt_tokens ?? 0;
      const outTok = usage?.completion_tokens ?? 0;
      const audioSec = input.contentType === "voice" ? Math.max(1, Math.round((effectiveText.length ?? 0) / 15)) : 0;
      costUsd = estimateCostUsd(inTok, outTok, audioSec);

      await db
        .insert(usageLogs)
        .values({
          id: newId(),
          restaurantId: input.restaurantId,
          model: usedModel,
          inputTokens: inTok,
          outputTokens: outTok,
          audioSeconds: audioSec,
          costUsd,
        });
      await db
        .update(restaurants)
        .set({ totalSpendUsd: sql`${restaurants.totalSpendUsd} + ${costUsd}` })
        .where(eq(restaurants.id, input.restaurantId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      replyText =
        "Sorry, I hit a small hiccup. Please give me a moment and try again. 🙏";
      await db
        .insert(errorLogs)
        .values({
          id: newId(),
          restaurantId: input.restaurantId,
          source: "agent",
          message: `OpenAI error: ${message}`,
          stack: err instanceof Error ? err.stack ?? null : null,
        });
    }
  }

  if (replyText) {
    await db
      .insert(messages)
      .values({
        id: newId(),
        conversationId: conversation.id,
        direction: "out",
        contentType: "text",
        text: replyText,
        status: "sent",
      });
  }

  const menuImages: MenuImage[] = [];
  if (sendMenuImages) {
    const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const base = new Date().getTime();
    for (let i = 0; i < rawMenuImages.length; i++) {
      const img = rawMenuImages[i];
      if (!img.base64) continue;
      const url = `${appBase}/api/media/${profile.restaurant.id}/${img.id}`;
      menuImages.push({
        id: img.id,
        mime: img.mime,
        base64: img.base64,
        url,
      });
      await db.insert(messages).values({
        id: newId(),
        conversationId: conversation.id,
        direction: "out",
        contentType: "image",
        mediaUrl: url,
        mediaMime: img.mime,
        status: "sent",
        createdAt: new Date(base + i + 1),
      });
    }
  }

  if (conversation.status === "manual") {
    return {
      replyText: "",
      costUsd,
      model: usedModel,
      transcription,
      order: null,
      menuImages,
    };
  }

  const order = await extractOrder(profile, conversation.id);
  if (order && order.ready) {
    await db
      .update(conversations)
      .set({ status: "order_pending" })
      .where(eq(conversations.id, conversation.id));
  }

  return {
    replyText,
    transcription,
    order,
    costUsd,
    model: usedModel,
    menuImages,
  };
}

export async function markOutgoingFailed(
  restaurantId: string,
  conversationId: string,
  error: string
): Promise<void> {
  await db
    .insert(errorLogs)
    .values({
      id: newId(),
      restaurantId,
      source: "gateway",
      message: error,
    });
  const lastOut = await first(
    db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.direction, "out")
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(1)
  );
  if (lastOut) {
    await db
      .update(messages)
      .set({ status: "failed", error })
      .where(eq(messages.id, lastOut.id));
  }
}