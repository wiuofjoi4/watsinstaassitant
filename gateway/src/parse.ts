import {
  downloadMediaMessage,
  getContentType,
} from "@whiskeysockets/baileys";
import type { WASocket } from "@whiskeysockets/baileys";
import { logger } from "./logger";

// Parsed inbound message shape — the gateway-side contract handed to the
// platform webhook (M2) and consumed by the delivery layer (M8).
export interface ParsedMessage {
  contentType: "text" | "image" | "voice" | "video";
  text?: string | null;
  mediaBase64?: string;
  mediaMime?: string;
}

export async function handleMessage(
  session: { socket: WASocket },
  m: any
): Promise<ParsedMessage | null> {
  try {
    const msg = m.message;
    if (!msg) return null;
    const type = getContentType(msg);
    if (type === "conversation") return { contentType: "text", text: msg.conversation ?? "" };
    if (type === "extendedTextMessage")
      return { contentType: "text", text: msg.extendedTextMessage?.text ?? "" };

    const isImage = type === "imageMessage";
    const isVideo = type === "videoMessage";
    const isAudio = type === "audioMessage";
    if (isImage || isVideo || isAudio) {
      let buffer: Buffer | undefined;
      try {
        buffer = (await downloadMediaMessage(
          m,
          "buffer",
          {},
          { logger, reuploadRequest: m.upload }
        )) as Buffer | undefined;
      } catch (err) {
        logger.warn(`media download failed: ${String(err)}`);
      }
      const mime =
        msg[type]?.mimetype ??
        (isImage ? "image/jpeg" : isAudio ? "audio/ogg" : "video/mp4");
      if (buffer && buffer.length > 0) {
        return {
          contentType: isImage ? "image" : isAudio ? "voice" : "video",
          mediaBase64: buffer.toString("base64"),
          mediaMime: mime,
          text: null,
        };
      }
      return {
        contentType: isImage ? "image" : isAudio ? "voice" : "video",
        text: isImage ? "[image]" : isAudio ? "[voice]" : "[video]",
      };
    }
    return { contentType: "text", text: JSON.stringify(msg) };
  } catch (err) {
    logger.error(`handleMessage error: ${String(err)}`);
    return null;
  }
}