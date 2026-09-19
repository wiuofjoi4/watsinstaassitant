// ---------------------------------------------------------------------------
// M9 redacting structured logger. Every event is ONE JSON line with a stable
// key order (ts first), and every payload passes through redact() so a
// credential can never reach the Vercel/Render runtime logs. Never throws on
// input that cannot be serialized (cycles, bigint, throwing getters).
//
// Usage: log("info", "webhook.received", { restaurantId }) or the shorthand
// monitor.info("..."). Keep events short and greppable; put detail in fields.
// The caller still owns hygiene (never pass a URL-with-key, never a secret);
// redact() is the last-resort net, not a reason to log secrets.
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

const SECRET_KEY_RE = /(key|secret|token|password|credential|authorization|apikey)/i;

/**
 * Deep copy `input`, masking the VALUE of any key matching the secret-key
 * pattern with "[REDACTED]". Arrays are recursed, plain objects are rebuilt
 * preserving insertion order, and primitives pass through untouched. Never
 * mutates the input.
 */
export function redact(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((v) => redact(v));
  }
  if (input !== null && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return input;
}

function serialize(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown>
): string {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...(redact(fields) as Record<string, unknown>),
    });
    // JSON.stringify(undefined) returns undefined — never emit a bare "undefined".
    return line ?? JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      fields: "[unserializable]",
    });
  } catch {
    // Unstructured input (cycles / throwing getters / bigint) must not kill the
    // logger — degrade to a flagged stub line instead of throwing.
    return JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      fields: "[unserializable]",
    });
  }
}

/** One structured JSON line. Redaction is always applied. Never throws. */
export function log(
  level: LogLevel,
  event: string,
  fields?: Record<string, unknown>
): void {
  const line = serialize(level, event, fields ?? {});
  if (level === "error" || level === "warn") console.error(line);
  else if (level === "debug") console.debug(line);
  else console.log(line);
}

/** Convenience wrapper — monitor.info("order.created", {...}) etc. */
export const monitor = {
  error: (event: string, fields?: Record<string, unknown>) =>
    log("error", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) =>
    log("warn", event, fields),
  info: (event: string, fields?: Record<string, unknown>) =>
    log("info", event, fields),
  debug: (event: string, fields?: Record<string, unknown>) =>
    log("debug", event, fields),
};