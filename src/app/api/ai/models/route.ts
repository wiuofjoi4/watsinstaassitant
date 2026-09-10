import { NextResponse } from "next/server";
import {
  completeWithFallback,
  getAgentModel,
  getProvider,
} from "@/lib/ai/client";
import { gatewaySecretOk } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Diagnostics: lists which Gemini models this project's API key can actually
 * call (name + first supported methods). Guarded by the gateway shared secret
 * so it is not exposed publicly.
 */
export async function GET(req: Request) {
  if (!gatewaySecretOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const key = process.env.GEMINI_API_KEY;
  const provider = getProvider();
  if (!provider) {
    return NextResponse.json({ error: "no AI provider configured" }, { status: 500 });
  }

  // ?ping=1 runs one real completion through the fail-over chain so we can
  // see exactly which model answers today (validates the discovery path).
  if (new URL(req.url).searchParams.get("ping") === "1") {
    try {
      const res = await completeWithFallback({
        model: getAgentModel(),
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
        max_tokens: 200,
      });
      return NextResponse.json({
        provider,
        answeredModel: res.model,
        keyLabel: (res as unknown as { keyLabel?: string }).keyLabel ?? null,
        content: res.choices?.[0]?.message?.content ?? null,
      });
    } catch (err) {
      return NextResponse.json(
        {
          provider,
          error: String(err instanceof Error ? err.message : err),
          attempts: (err as { attempts?: Array<{ model: string; status: number; msg: string }> })
            ?.attempts ?? [],
        },
        { status: 502 }
      );
    }
  }

  if (provider === "openai") {
    return NextResponse.json({ provider: "openai", note: "Gemini key not in use" });
  }
  if (!key) {
    return NextResponse.json({ error: "no GEMINI_API_KEY configured" }, { status: 500 });
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) {
      return NextResponse.json(
        { error: `list models failed: ${res.status}`, body: await res.text() },
        { status: 502 }
      );
    }
    const data = (await res.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const models = (data.models ?? [])
      .map((m) => ({
        name: m.name ?? "",
        generation: (m.supportedGenerationMethods ?? []).includes("generateContent"),
      }))
      .filter((m) => m.name.startsWith("models/gemini-") || m.name.startsWith("models/gemma-"))
      .map((m) => ({ name: m.name.replace(/^models\//, ""), generation: m.generation }));
    return NextResponse.json({ count: models.length, models });
  } catch (err) {
    return NextResponse.json(
      { error: String(err instanceof Error ? err.message : err) },
      { status: 502 }
    );
  }
}