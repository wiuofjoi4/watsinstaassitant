// ---------------------------------------------------------------------------
// M6 vision client — extractVisionText + input validation. Single discriminated
// VisionResult so the Combiner/engine can route errors precisely:
//   - unsupported_mime / too_large / malformed → caller decision (no AI call)
//   - not_configured → platform has no AI keys
//   - ai_failed → AI chain threw or returned no usable text
// extractVisionText NEVER throws. The cache is best-effort: a DB hiccup during
// lookup/write degrades to a fresh model call / unsilently-skips caching, it
// never blocks the image turn.
//
// The vision content part reuses the EXACT shape the engine (buildMessages)
// already sends to providers: { type: "image_url", image_url: { url:
// `data:<mime>;base64,<base64>` } } — no new/custom part format.
// ---------------------------------------------------------------------------
import OpenAI from "openai";
import {
  completeWithFallback,
  getAgentModel,
  isAIConfigured,
} from "@/lib/ai/client";
import {
  getCachedVision,
  setCachedVision,
  visionMediaKey,
} from "./cache";

export const VISION_MIME_ALLOWLIST = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type VisionMime = (typeof VISION_MIME_ALLOWLIST)[number];

const VISION_MIME_SET: ReadonlySet<string> = new Set(VISION_MIME_ALLOWLIST);

/** ~3MB decoded budget — mirrors the gateway's own media constant. */
export const VISION_MAX_BASE64_LENGTH = 4_000_000;

/**
 * Model-only instruction (never shown to the customer): ask for a concise
 * Iraqi-dialect description of the menu/food image so the ordering assistant
 * can answer. Output language matches the engine; the prompt itself stays
 * English so no new customer-facing Arabic strings are introduced.
 */
const VISION_SYSTEM_PROMPT =
  "You are an image-understanding helper inside a restaurant-ordering " +
  "assistant. Describe this menu/food image concisely in Iraqi Arabic so the " +
  "assistant can answer the customer about the dishes and visible prices. " +
  "Reply with only the short description, no commentary.";

export type VisionResult =
  | { ok: true; text: string; model: string | null; fromCache: boolean }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "unsupported_mime"
        | "too_large"
        | "malformed"
        | "ai_failed";
      text: null;
    };

export type VisionInputValidation =
  | { ok: true }
  | {
      ok: false;
      reason: "unsupported_mime" | "too_large" | "malformed";
      text: null;
    };

/**
 * Input-only gate: allowlist length, and base64 sanity. Exported for
 * deterministic testing without AI configuration or a network call.
 */
export function validateVisionInput(input: {
  mime: string;
  base64: string;
}): VisionInputValidation {
  if (!VISION_MIME_SET.has(input.mime)) {
    return { ok: false, reason: "unsupported_mime", text: null };
  }
  if (input.base64.length > VISION_MAX_BASE64_LENGTH) {
    return { ok: false, reason: "too_large", text: null };
  }
  try {
    const trimmed = input.base64.trim();
    if (!trimmed || Number.isNaN(input.base64.length)) {
      return { ok: false, reason: "malformed", text: null };
    }
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length === 0) {
      return { ok: false, reason: "malformed", text: null };
    }
  } catch {
    return { ok: false, reason: "malformed", text: null };
  }
  return { ok: true };
}

/**
 * Extract a concise menu/food description from an image. Order of resolution:
 * input validators → not_configured → cache → model call → cache write.
 * Never throws.
 */
export async function extractVisionText(input: {
  restaurantId: string;
  mime: string;
  base64: string;
}): Promise<VisionResult> {
  const valid = validateVisionInput({ mime: input.mime, base64: input.base64 });
  if (!valid.ok) return valid;

  if (!isAIConfigured()) {
    return { ok: false, reason: "not_configured", text: null };
  }

  const mediaKey = visionMediaKey(input);

  try {
    const cached = await getCachedVision(mediaKey);
    if (cached) {
      return {
        ok: true,
        text: cached.description,
        model: cached.model,
        fromCache: true,
      };
    }
  } catch {
    // Cache is an optimization; a DB hiccup must not block vision. Fall
    // through to the model call.
  }

  const model = getAgentModel();
  let reply: string;
  try {
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: "Describe this image." },
      {
        type: "image_url",
        image_url: {
          url: `data:${input.mime};base64,${input.base64}`,
        },
      },
    ];
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: VISION_SYSTEM_PROMPT },
      { role: "user", content: parts },
    ];
    const res = await completeWithFallback(
      {
        model,
        temperature: 0,
        max_tokens: 300,
        messages,
      },
      { budgetMs: 15_000, timeoutMs: 15_000 }
    );
    const content = res.choices?.[0]?.message?.content;
    if (!content || !String(content).trim()) {
      return { ok: false, reason: "ai_failed", text: null };
    }
    reply = String(content).trim();
  } catch {
    return { ok: false, reason: "ai_failed", text: null };
  }

  try {
    await setCachedVision({
      mediaKey,
      restaurantId: input.restaurantId,
      mime: input.mime,
      description: reply,
      model,
    });
  } catch {
    // Caching is best-effort — the extraction still counts.
  }

  return { ok: true, text: reply, model, fromCache: false };
}