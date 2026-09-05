import { createHmac, timingSafeEqual } from "crypto";

export const INSTAGRAM_GRAPH_VERSION =
  process.env.INSTAGRAM_GRAPH_VERSION ?? "v22.0";

export interface SendInstagramTextInput {
  igId: string;
  accessToken: string;
  recipientId: string;
  text: string;
}

export async function sendInstagramText({
  igId,
  accessToken,
  recipientId,
  text,
}: SendInstagramTextInput): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const url = `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${igId}/messages`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
    });
    const json = (await res.json().catch(() => null)) as { message_id?: string; error?: { message?: string } } | null;
    if (!res.ok) return { ok: false, error: json?.error?.message ?? `HTTP ${res.status}` };
    return { ok: true, messageId: json?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface SendInstagramImageInput {
  igId: string;
  accessToken: string;
  recipientId: string;
  imageUrl: string;
}

export async function sendInstagramImage({
  igId,
  accessToken,
  recipientId,
  imageUrl,
}: SendInstagramImageInput): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const url = `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${igId}/messages`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: "image",
            payload: { url: imageUrl },
          },
        },
      }),
    });
    const json = (await res.json().catch(() => null)) as { message_id?: string; error?: { message?: string } } | null;
    if (!res.ok) return { ok: false, error: json?.error?.message ?? `HTTP ${res.status}` };
    return { ok: true, messageId: json?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function verifyHubSignature(
  appSecret: string,
  rawBody: string,
  signatureHeader: string | null
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const provided = signatureHeader.replace(/^sha256=/, "");
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}