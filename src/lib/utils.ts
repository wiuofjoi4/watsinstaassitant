import { createHash, randomBytes } from "node:crypto";

export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

export function newId(): string {
  return randomBytes(12).toString("hex");
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

export function formatMoney(centsOrUsd: number, asUsd = false): string {
  if (asUsd) return `$${centsOrUsd.toFixed(2)}`;
  return `$${(centsOrUsd / 100).toFixed(2)}`;
}

export function formatDateTime(ts: Date | null | undefined): string {
  if (!ts) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ts);
}

export function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}