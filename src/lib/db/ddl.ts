export const SCHEMA_DDL = `
CREATE SCHEMA IF NOT EXISTS repli;
--> statement-breakpoint
CREATE TABLE "repli"."agent_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"restaurant_id" text NOT NULL,
	"business_name" text DEFAULT '' NOT NULL,
	"tone" text DEFAULT 'friendly' NOT NULL,
	"languages" text DEFAULT 'ar,en' NOT NULL,
	"hours" text DEFAULT '' NOT NULL,
	"delivery_policy" text DEFAULT '' NOT NULL,
	"menu" text DEFAULT '' NOT NULL,
	"policies" text DEFAULT '' NOT NULL,
	"custom_instructions" text DEFAULT '' NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"temperature" real DEFAULT 0.7 NOT NULL,
	"ask_phone" boolean DEFAULT true NOT NULL,
	"ask_address" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repli"."conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"restaurant_id" text NOT NULL,
	"channel" text NOT NULL,
	"remote_jid" text NOT NULL,
	"customer_name" text,
	"status" text DEFAULT 'open' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repli"."error_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"restaurant_id" text NOT NULL,
	"source" text DEFAULT 'agent' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"stack" text,
	"resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repli"."messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"direction" text NOT NULL,
	"content_type" text DEFAULT 'text' NOT NULL,
	"text" text,
	"media_url" text,
	"media_mime" text,
	"transcription" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repli"."orders" (
	"id" text PRIMARY KEY NOT NULL,
	"restaurant_id" text NOT NULL,
	"conversation_id" text,
	"customer_name" text,
	"phone" text,
	"address" text,
	"items_json" text DEFAULT '[]' NOT NULL,
	"total" real,
	"status" text DEFAULT 'new' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repli"."restaurants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_enabled" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"subscription_days" integer DEFAULT 30 NOT NULL,
	"whatsapp_jid" text,
	"whatsapp_linked" boolean DEFAULT false NOT NULL,
	"whatsapp_status" text DEFAULT 'disconnected' NOT NULL,
	"instagram_username" text,
	"instagram_linked" boolean DEFAULT false NOT NULL,
	"instagram_status" text DEFAULT 'disconnected' NOT NULL,
	"instagram_token" text,
	"instagram_ig_id" text,
	"link_token" text,
	"total_spend_usd" real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repli"."gateway_sessions" (
	"restaurant_id" text PRIMARY KEY NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"creds_json" text,
	"keys_json" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repli"."usage_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"restaurant_id" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"audio_seconds" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repli"."agent_configs" ADD CONSTRAINT "agent_configs_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "repli"."restaurants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repli"."conversations" ADD CONSTRAINT "conversations_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "repli"."restaurants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repli"."error_logs" ADD CONSTRAINT "error_logs_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "repli"."restaurants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repli"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "repli"."conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repli"."orders" ADD CONSTRAINT "orders_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "repli"."restaurants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repli"."orders" ADD CONSTRAINT "orders_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "repli"."conversations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repli"."usage_logs" ADD CONSTRAINT "usage_logs_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "repli"."restaurants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_configs_restaurant_idx" ON "repli"."agent_configs" USING btree ("restaurant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_restaurant_remote_idx" ON "repli"."conversations" USING btree ("restaurant_id","channel","remote_jid");
--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_sessions_restaurant_idx" ON "repli"."gateway_sessions" USING btree ("restaurant_id","channel");
--> statement-breakpoint
CREATE INDEX "conversations_last_message_idx" ON "repli"."conversations" USING btree ("restaurant_id","last_message_at");
--> statement-breakpoint
CREATE INDEX "error_logs_restaurant_idx" ON "repli"."error_logs" USING btree ("restaurant_id","created_at");
--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "repli"."messages" USING btree ("conversation_id");
--> statement-breakpoint
CREATE INDEX "orders_restaurant_idx" ON "repli"."orders" USING btree ("restaurant_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "restaurants_link_token_idx" ON "repli"."restaurants" USING btree ("link_token");
--> statement-breakpoint
ALTER TABLE "repli"."restaurants" ADD COLUMN IF NOT EXISTS "instagram_token" text;
--> statement-breakpoint
ALTER TABLE "repli"."restaurants" ADD COLUMN IF NOT EXISTS "instagram_ig_id" text;
--> statement-breakpoint
ALTER TABLE "repli"."restaurants" ADD COLUMN IF NOT EXISTS "menu_images" text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE "repli"."restaurants" ADD COLUMN IF NOT EXISTS "auto_menu_whatsapp" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "repli"."restaurants" ADD COLUMN IF NOT EXISTS "auto_menu_instagram" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX "usage_logs_restaurant_idx" ON "repli"."usage_logs" USING btree ("restaurant_id","created_at");
`;