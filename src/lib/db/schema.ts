import { sql } from "drizzle-orm";
import {
  index,
  boolean,
  integer,
  pgSchema,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const repli = pgSchema("repli");

export const restaurants = repli.table(
  "restaurants",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    agentEnabled: boolean("agent_enabled")
      .notNull()
      .default(false),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    subscriptionDays: integer("subscription_days").notNull().default(30),
    whatsappJid: text("whatsapp_jid"),
    whatsappLinked: boolean("whatsapp_linked")
      .notNull()
      .default(false),
    whatsappStatus: text("whatsapp_status").notNull().default("disconnected"),
    instagramUsername: text("instagram_username"),
    instagramLinked: boolean("instagram_linked")
      .notNull()
      .default(false),
    instagramStatus: text("instagram_status").notNull().default("disconnected"),
    instagramToken: text("instagram_token"),
    instagramIgId: text("instagram_ig_id"),
    linkToken: text("link_token"),
    totalSpendUsd: real("total_spend_usd").notNull().default(0),
  },
  (t) => {
    return {
      linkTokenIdx: uniqueIndex("restaurants_link_token_idx").on(t.linkToken),
    };
  }
);

export const agentConfigs = repli.table(
  "agent_configs",
  {
    id: text("id").primaryKey(),
    restaurantId: text("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    businessName: text("business_name").notNull().default(""),
    tone: text("tone").notNull().default("friendly"),
    languages: text("languages").notNull().default("ar,en"),
    hours: text("hours").notNull().default(""),
    deliveryPolicy: text("delivery_policy").notNull().default(""),
    menu: text("menu").notNull().default(""),
    policies: text("policies").notNull().default(""),
    customInstructions: text("custom_instructions").notNull().default(""),
    systemPrompt: text("system_prompt").notNull().default(""),
    temperature: real("temperature").notNull().default(0.7),
    askPhone: boolean("ask_phone").notNull().default(true),
    askAddress: boolean("ask_address")
      .notNull()
      .default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => {
    return {
      restaurantIdx: uniqueIndex("agent_configs_restaurant_idx").on(
        t.restaurantId
      ),
    };
  }
);

export const conversations = repli.table(
  "conversations",
  {
    id: text("id").primaryKey(),
    restaurantId: text("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    remoteJid: text("remote_jid").notNull(),
    customerName: text("customer_name"),
    status: text("status").notNull().default("open"),
    pinned: boolean("pinned").notNull().default(false),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => {
    return {
      restaurantRemoteIdx: uniqueIndex("conversations_restaurant_remote_idx").on(
        t.restaurantId,
        t.channel,
        t.remoteJid
      ),
      lastMessageIdx: index("conversations_last_message_idx").on(
        t.restaurantId,
        t.lastMessageAt
      ),
    };
  }
);

export const messages = repli.table(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    contentType: text("content_type").notNull().default("text"),
    text: text("text"),
    mediaUrl: text("media_url"),
    mediaMime: text("media_mime"),
    transcription: text("transcription"),
    status: text("status").notNull().default("sent"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => {
    return {
      conversationIdx: index("messages_conversation_idx").on(t.conversationId),
    };
  }
);

export const orders = repli.table(
  "orders",
  {
    id: text("id").primaryKey(),
    restaurantId: text("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    customerName: text("customer_name"),
    phone: text("phone"),
    address: text("address"),
    itemsJson: text("items_json").notNull().default("[]"),
    total: real("total"),
    status: text("status").notNull().default("new"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => {
    return {
      restaurantIdx: index("orders_restaurant_idx").on(
        t.restaurantId,
        t.createdAt
      ),
    };
  }
);

export const gatewaySessions = repli.table(
  "gateway_sessions",
  {
    restaurantId: text("restaurant_id").primaryKey(),
    channel: text("channel").notNull().default("whatsapp"),
    credsJson: text("creds_json"),
    keysJson: text("keys_json"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => {
    return {
      restaurantIdx: uniqueIndex("gateway_sessions_restaurant_idx").on(
        t.restaurantId,
        t.channel
      ),
    };
  }
);

export const usageLogs = repli.table(
  "usage_logs",
  {
    id: text("id").primaryKey(),
    restaurantId: text("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    model: text("model").notNull().default(""),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    audioSeconds: integer("audio_seconds").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => {
    return {
      restaurantIdx: index("usage_logs_restaurant_idx").on(
        t.restaurantId,
        t.createdAt
      ),
    };
  }
);

export const errorLogs = repli.table(
  "error_logs",
  {
    id: text("id").primaryKey(),
    restaurantId: text("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("agent"),
    message: text("message").notNull().default(""),
    stack: text("stack"),
    resolved: boolean("resolved").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => {
    return {
      restaurantIdx: index("error_logs_restaurant_idx").on(
        t.restaurantId,
        t.createdAt
      ),
    };
  }
);

export type Restaurant = typeof restaurants.$inferSelect;
export type NewRestaurant = typeof restaurants.$inferInsert;
export type AgentConfig = typeof agentConfigs.$inferSelect;
export type NewAgentConfig = typeof agentConfigs.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type UsageLog = typeof usageLogs.$inferSelect;
export type ErrorLog = typeof errorLogs.$inferSelect;
export type GatewaySession = typeof gatewaySessions.$inferSelect;
export type NewGatewaySession = typeof gatewaySessions.$inferInsert;