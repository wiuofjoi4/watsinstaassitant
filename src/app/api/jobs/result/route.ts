import { NextResponse } from "next/server";
import { gatewaySecretOk } from "@/lib/env";
import { rawClient } from "@/lib/db";
import { messageJobFromRow } from "@/lib/queue/rows";
import { parseResultJson } from "@/lib/queue/client";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!gatewaySecretOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobId = new URL(req.url).searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const rows = await rawClient`
    select * from repli.message_jobs where id = ${jobId} limit 1
  `;
  if (rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "job not found" },
      { status: 404 }
    );
  }

  const job = messageJobFromRow(rows[0]);
  return NextResponse.json({
    ok: true,
    status: job.status,
    result: parseResultJson(job.resultJson),
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
}