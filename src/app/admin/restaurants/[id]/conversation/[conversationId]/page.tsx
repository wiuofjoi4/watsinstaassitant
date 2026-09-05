import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { Badge, Card } from "@/components/ui";
import { db } from "@/lib/db";
import { conversations, orders } from "@/lib/db/schema";
import { getConversationThread } from "@/lib/queries";
import { formatDateTime } from "@/lib/utils";
import { first } from "@/lib/db/query";

export default async function ConversationPage(
  props: PageProps<"/admin/restaurants/[id]/conversation/[conversationId]">
) {
  const { id, conversationId } = await props.params;

  const conversation = await first(
    db.select().from(conversations).where(eq(conversations.id, conversationId))
  );
  if (!conversation || conversation.restaurantId !== id) notFound();

  const thread = (await getConversationThread(conversationId)).reverse();
  const convOrders = await db
    .select()
    .from(orders)
    .where(eq(orders.conversationId, conversationId));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href={`/admin/restaurants/${id}?tab=conversations`}
          className="text-xs text-muted hover:text-soft"
        >
          ← Back to conversations
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-soft">
            {conversation.customerName ?? conversation.remoteJid}
          </h1>
          <Badge tone="info">{conversation.channel}</Badge>
          <Badge tone={conversation.status === "manual" ? "neutral" : "good"}>
            {conversation.status}
          </Badge>
        </div>
        <p className="mt-1 font-mono text-xs text-muted">{conversation.remoteJid}</p>
      </div>

      {convOrders.length > 0 ? (
        <Card className="p-5">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Orders</p>
          <div className="space-y-2">
            {convOrders.map((o) => (
              <div
                key={o.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3.5 py-2.5"
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs text-soft">{o.itemsJson}</p>
                  <p className="text-[11px] text-muted">
                    {o.phone ? `📞 ${o.phone} · ` : ""}
                    {o.address ? `📍 ${o.address}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {o.total != null ? (
                    <span className="font-mono text-sm text-soft">${o.total.toFixed(2)}</span>
                  ) : null}
                  <Badge tone={o.status === "new" ? "warn" : o.status === "done" ? "good" : "info"}>
                    {o.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-col gap-3 px-5 py-5">
          {thread.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">No messages in this thread.</p>
          ) : (
            thread.map((m) => (
              <div
                key={m.id}
                className={`flex max-w-[85%] flex-col gap-1 rounded-xl border px-3.5 py-2.5 ${
                  m.direction === "in"
                    ? "self-start border-line bg-surface"
                    : "self-end border-primary/30 bg-primary/10"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[10px] font-semibold uppercase tracking-wider ${
                      m.direction === "in" ? "text-muted" : "text-primary"
                    }`}
                  >
                    {m.direction === "in" ? "Customer" : "Agent"}
                  </span>
                  <span className="text-[10px] text-muted/60">{formatDateTime(m.createdAt)}</span>
                </div>
                {m.contentType === "image" || m.contentType === "video" ? (
                  m.mediaUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={m.mediaUrl}
                      alt="customer media"
                      className="mt-1 max-h-48 rounded-lg border border-line object-cover"
                    />
                  ) : (
                    <span className="text-xs text-muted">[{m.contentType}]</span>
                  )
                ) : null}
                {m.text ? <p className="whitespace-pre-wrap text-sm text-soft">{m.text}</p> : null}
                {m.transcription ? (
                  <p className="text-[11px] italic text-muted">
                    🔊 {m.transcription}
                  </p>
                ) : null}
                {m.status === "failed" && m.error ? (
                  <p className="text-[11px] text-bad">⚠ Failed: {m.error}</p>
                ) : null}
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}