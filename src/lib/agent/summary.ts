import type { AgentOrderResult } from "./engine";

export const ORDER_STATE_OPEN = "[ORDER_STATE]";
export const ORDER_STATE_CLOSE = "[/ORDER_STATE]";

export interface CondensedContext {
  items: { name: string; qty: number; price: number }[];
  total: number | null;
  phone: string | null;
  address: string | null;
  customerName: string | null;
  hasOrderMaterial: boolean;
  lastUser: string | null;
  lastAssistant: string | null;
}

/** Lenient JSON recovery: accepts bare JSON, code-fenced JSON, and JSON buried
 * in prose. Returns null when nothing parseable exists. */
function parseJsonSafe(raw: string): unknown | null {
  if (!raw || !raw.trim()) return null;
  const s = raw
    .trim()
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(s);
  } catch {
    // fall through
  }
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(s.slice(firstBrace, lastBrace + 1));
    } catch {
      // fall through
    }
  }
  return null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ORDER_BLOCK_RE = new RegExp(
  `${esc(ORDER_STATE_OPEN)}([\\s\\S]*?)${esc(ORDER_STATE_CLOSE)}`,
  "g"
);
const ORDER_BLOCK_STRIP_RE = new RegExp(
  `${esc(ORDER_STATE_OPEN)}[\\s\\S]*?${esc(ORDER_STATE_CLOSE)}`,
  "g"
);

function toNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Validate/normalize a parsed order object into a safe AgentOrderResult. */
export function sanitizeOrder(raw: unknown): AgentOrderResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const items = (Array.isArray(o.items) ? o.items : [])
    .map((it) => {
      const itm = it as Record<string, unknown>;
      const name = typeof itm.name === "string" ? itm.name.trim().slice(0, 120) : "";
      if (!name) return null;
      const qty = Math.max(0, toNum(itm.qty) ?? 1);
      const price = toNum(itm.price) ?? 0;
      return { name, qty, price };
    })
    .filter((x): x is { name: string; qty: number; price: number } => x !== null);
  const total = toNum(o.total);
  const phone =
    typeof o.phone === "string" && o.phone.trim() ? o.phone.trim() : null;
  const address =
    typeof o.address === "string" && o.address.trim() ? o.address.trim() : null;
  const customerName =
    typeof o.customerName === "string" && o.customerName.trim()
      ? o.customerName.trim()
      : null;
  const itemSum = items.reduce((s, i) => s + i.qty * i.price, 0);
  return {
    // A hallucinated "ready" must never push an empty order: items AND phone
    // are the minimum contract for a delivery. The model's raw intent is kept
    // on rawReady so the engine can still finalize phone-less confirmed orders
    // (WhatsApp lid JIDs) after filling/verifying the number.
    ready: o.ready === true && items.length > 0 && !!phone,
    rawReady: o.ready === true,
    items,
    total: total ?? itemSum,
    phone,
    address,
    customerName,
  };
}

/** Parse the LAST self-describing order block a reply carried. */
export function parseOrderBlock(text: string): AgentOrderResult | null {
  if (!text) return null;
  let last: string | null = null;
  for (const m of text.matchAll(ORDER_BLOCK_RE)) {
    last = m[1];
  }
  if (!last) return null;
  return sanitizeOrder(parseJsonSafe(last));
}

/** Remove [ORDER_STATE] blocks → the clean customer-facing reply body. */
export function stripOrderBlock(text: string): string {
  return text.replace(ORDER_BLOCK_STRIP_RE, "").trim();
}

const PHONE_RE = /(\+?\d[\d\s-]{6,16}\d)/;
const ADDRESS_HINT =
  /(قرب|شارع|حي\s|منطقة|امام|أمام|محافظة|حسبة|محلة|قاطعة|زقاق|طريق|بناية)/;

/** Deterministic, model-agnostic condensation of the raw message log into a
 * compact running state. No LLM, no schema change — works with any model. */
export function condenseMessages(
  rows: { direction: string; text: string | null }[]
): CondensedContext {
  let items: { name: string; qty: number; price: number }[] = [];
  let total: number | null = null;
  let phone: string | null = null;
  let address: string | null = null;
  let customerName: string | null = null;
  let lastUser: string | null = null;
  let lastAssistant: string | null = null;

  for (const row of rows) {
    const raw = row.text ?? "";
    if (row.direction === "out") {
      const order = parseOrderBlock(raw);
      if (order) {
        if (order.items.length > 0) items = order.items;
        if (typeof order.total === "number") total = order.total;
        if (order.phone) phone = order.phone;
        if (order.address) address = order.address;
        if (order.customerName) customerName = order.customerName;
      }
      const clean = stripOrderBlock(raw);
      if (clean) lastAssistant = clean.slice(-220);
    } else {
      const t = raw.trim();
      if (t) lastUser = t.slice(-220);
    }
    if (!phone) {
      const m = PHONE_RE.exec(raw);
      if (m) phone = m[1].trim();
    }
    if (!address && /[^\n]{2,}/.test(raw.trim()) && ADDRESS_HINT.test(raw)) {
      address = raw.trim().slice(-120);
    }
  }

  const hasOrderMaterial = items.length > 0 || !!phone || !!address;
  return {
    items,
    total,
    phone,
    address,
    customerName,
    hasOrderMaterial,
    lastUser,
    lastAssistant,
  };
}

const fmt = (n: number) =>
  Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;

/** Compact "conversation so far" block embedded in the system prompt. */
export function renderContextBlock(c: CondensedContext): string {
  const lines: string[] = ["[ملخص المحادثة حتى الآن]"];
  if (!c.hasOrderMaterial) {
    lines.push("- لا يوجد طلب جارٍ حتى الآن.");
  } else {
    if (c.items.length > 0) {
      lines.push(
        "- الأصناف المؤكدة: " +
          c.items
            .map((i) => `${i.qty}× ${i.name} (${fmt(i.price)})`)
            .join("، ")
      );
    }
    if (c.total !== null) lines.push(`- الإجمالي الحالي: ${fmt(c.total)}`);
    if (c.phone) lines.push(`- هاتف الزبون: ${c.phone}`);
    if (c.address) lines.push(`- عنوان التوصيل: ${c.address}`);
    if (c.customerName) lines.push(`- اسم الزبون: ${c.customerName}`);
  }
  if (c.lastAssistant)
    lines.push(`- آخر رد أرسله البوت: "${c.lastAssistant}"`);
  return lines.join("\n");
}