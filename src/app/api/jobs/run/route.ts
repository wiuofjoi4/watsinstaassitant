import { NextResponse } from "next/server";
import { gatewaySecretOk } from "@/lib/env";
import { runNextJob } from "@/lib/queue/run";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!gatewaySecretOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let restaurantId: string;
  let jobId: string | undefined;
  try {
    const body = (await req.json()) as {
      restaurantId?: unknown;
      jobId?: unknown;
    };
    restaurantId =
      typeof body?.restaurantId === "string" ? body.restaurantId.trim() : "";
    jobId = typeof body?.jobId === "string" && body.jobId.trim() ? body.jobId.trim() : undefined;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!restaurantId) {
    return NextResponse.json(
      { error: "restaurantId is required" },
      { status: 400 }
    );
  }

  try {
    const outcome = await runNextJob(restaurantId, jobId);
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    console.error(
      `[JOBS/RUN] claim/execute failed restaurant=${restaurantId} error=${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return NextResponse.json(
      { ok: false, error: "failed to claim and run job" },
      { status: 500 }
    );
  }
}