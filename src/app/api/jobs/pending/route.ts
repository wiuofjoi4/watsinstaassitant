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

  const restaurantId = new URL(req.url).searchParams.get("restaurantId");
  if (!restaurantId) {
    return NextResponse.json(
      { error: "restaurantId is required" },
      { status: 400 }
    );
  }

  const rows = await rawClient`
    select * from repli.message_jobs
    where restaurant_id = ${restaurantId} and status = 'ready'
    order by created_at
    limit 20
  `;
  const jobs = rows.map((row) => {
    const job = messageJobFromRow(row);
    return { ...job, result: parseResultJson(job.resultJson) };
  });
  return NextResponse.json({ ok: true, jobs });
}