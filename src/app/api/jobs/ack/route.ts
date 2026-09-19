import { NextResponse } from "next/server";
import { gatewaySecretOk } from "@/lib/env";
import { acknowledgeJob } from "@/lib/queue/rows";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!gatewaySecretOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { jobId?: unknown; delivered?: unknown; expired?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const jobId = typeof body?.jobId === "string" ? body.jobId.trim() : "";
  const delivered = body?.delivered === true;
  const expired = body?.expired === true;
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }
  if (delivered === expired) {
    return NextResponse.json(
      { error: "exactly one of delivered/expired is required" },
      { status: 400 }
    );
  }

  const ok = await acknowledgeJob(jobId, delivered ? "delivered" : "expired");
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: "job not deliverable" },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}