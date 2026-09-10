// ---------------------------------------------------------------------------
// Env validation — shared by every guarded route (Next) so the auth policy is
// enforced in ONE place, plus a per-process boot banner that logs a clear
// checklist of critical configuration in the first cold start.
// ---------------------------------------------------------------------------

/** True when `v` is empty or still a template placeholder (change-me, xxx…). */
export function isPlaceholder(v: string): boolean {
  const t = v.trim();
  if (t === "") return true;
  return /^(https?:\/\/)?(localhost|0\.0\.0\.0|127\.0\.0\.1)$/i.test(t) ||
    /change[_-]?me|changeme|your[-_]?\w+|xxx+|y{3,}|^\*+$|^=+$|^<.*>$|placeholder|^none$/i.test(
      t
    );
}

/** Configured GATEWAY_SECRET that is non-empty and not a placeholder. */
export function isGatewaySecretConfigured(): boolean {
  return !isPlaceholder(process.env.GATEWAY_SECRET ?? "");
}

/**
 * Strict shared auth for gateway→platform calls. MISSING or placeholder
 * GATEWAY_SECRET is treated as UNCONFIGURED-AUTH and REJECTED (previously the
 * routes fell back to "allow everything" — the audit flagged this as the
 * highest-priority security gap). If you break the gateway↔platform secret,
 * the error is deliberately loud: no silent unauthenticated access.
 */
export function gatewaySecretOk(req: Pick<Request, "headers">): boolean {
  const expected = (process.env.GATEWAY_SECRET ?? "").trim();
  if (!expected || isPlaceholder(expected)) return false;
  return req.headers.get("x-gateway-secret") === expected;
}

function splitKeys(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => !isPlaceholder(s));
}

/**
 * Idempotent per-process startup banner. Each cold lambda prints it once —
 * a short, greppable checklist of what is configured and what is wrong.
 * Never throws; env problems surface in logs, not in crashing requests.
 */
export function logEnvBanner(): void {
  const g = globalThis as { __envBannerLogged?: boolean };
  if (g.__envBannerLogged) return;
  g.__envBannerLogged = true;

  const out: string[] = ["[ENV] --- boot configuration check ---"];

  // Gateway shared secret.
  const secretOk = isGatewaySecretConfigured();
  out.push(
    secretOk
      ? `[ENV] GATEWAY_SECRET ............ OK`
      : `[ENV] GATEWAY_SECRET ............ NOT set (webhook/sync/status routes REJECT everything)`
  );

  // AI providers (multi-key, comma-separated).
  const gemini = splitKeys(process.env.GEMINI_API_KEY ?? "").length;
  const openai = splitKeys(process.env.OPENAI_API_KEY ?? "").length;
  const openrouter = splitKeys(process.env.OPENROUTER_API_KEY ?? "").length;
  out.push(
    gemini + openai + openrouter > 0
      ? `[ENV] AI keys .................. gemini=${gemini} openai=${openai} openrouter=${openrouter}`
      : `[ENV] AI keys .................. NONE (agent replies will always use the graceful apology)`
  );

  // Spend alerts.
  const alertUrl = process.env.ALERT_WEBHOOK_URL ?? "";
  const daily = Number(process.env.DAILY_SPEND_LIMIT_USD ?? 0);
  const monthly = Number(process.env.MONTHLY_SPEND_LIMIT_USD ?? 0);
  out.push(
    alertUrl
      ? `[ENV] Spend alert webhook ...... configured (daily=${daily || "off"} monthly=${monthly || "off"})`
      : `[ENV] Spend alert webhook ...... disabled (set ALERT_WEBHOOK_URL)`
  );

  // Database.
  out.push(
    process.env.DATABASE_URL
      ? `[ENV] DATABASE_URL ............. OK`
      : `[ENV] DATABASE_URL ............. NOT set`
  );

  // Admin login.
  const admin = process.env.ADMIN_PASSWORD ?? "";
  out.push(
    admin && !isPlaceholder(admin)
      ? `[ENV] ADMIN_PASSWORD ........... OK`
      : `[ENV] ADMIN_PASSWORD ........... NOT set / placeholder (admin login disabled)`
  );

  console.error(out.join("\n"));
}