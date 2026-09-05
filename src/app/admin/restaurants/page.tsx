import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { getRestaurantsOverview } from "@/lib/queries";
import { formatDateTime, formatMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

function SubBadge({ daysLeft, expired, active }: { daysLeft: number; expired: boolean; active: boolean }) {
  if (!active) return <Badge tone="neutral">Paused</Badge>;
  if (expired) return <Badge tone="bad">Subscription expired</Badge>;
  if (daysLeft <= 7) return <Badge tone="warn">{daysLeft} day(s) left</Badge>;
  return <Badge tone="good">{daysLeft} day(s) left</Badge>;
}

export default async function RestaurantsPage() {
  const rows = await getRestaurantsOverview();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-soft">Restaurants</h1>
          <p className="mt-1 text-sm text-muted">
            Manage each business, train its agent, and watch the counters.
          </p>
        </div>
        <Link
          href="/admin/restaurants/new"
          className="rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent"
        >
          + Add restaurant
        </Link>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                <th className="px-5 py-3 font-medium">Restaurant</th>
                <th className="px-5 py-3 font-medium">Agent</th>
                <th className="px-5 py-3 font-medium">Channels</th>
                <th className="px-5 py-3 font-medium">Subscription</th>
                <th className="px-5 py-3 font-medium">Orders</th>
                <th className="px-5 py-3 font-medium">Spend</th>
                <th className="px-5 py-3 font-medium">Activated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-muted">
                    No restaurants yet. Add your first one.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="transition-colors hover:bg-surface">
                    <td className="px-5 py-3">
                      <Link href={`/admin/restaurants/${r.id}`} className="font-medium text-soft hover:text-primary">
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <SubBadge
                        daysLeft={r.subscription.daysLeft}
                        expired={r.subscription.expired}
                        active={r.agentEnabled}
                      />
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-col gap-1 text-[11px] text-muted">
                        <span>
                          WhatsApp ·{" "}
                          {r.whatsappStatus === "connected" ? (
                            <span className="text-good">connected</span>
                          ) : (
                            <span className="text-muted/70">{r.whatsappStatus}</span>
                          )}
                        </span>
                        <span>
                          Instagram ·{" "}
                          {r.instagramStatus === "connected" ? (
                            <span className="text-good">connected</span>
                          ) : (
                            <span className="text-muted/70">{r.instagramStatus}</span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-col gap-0.5">
                        <span
                          className={`text-xs font-medium ${
                            r.subscription.expired
                              ? "text-bad"
                              : r.subscription.expiresSoon
                                ? "text-warn"
                                : "text-good"
                          }`}
                        >
                          {r.subscription.expired
                            ? "Expired"
                            : `${r.subscription.daysLeft} / ${r.subscription.totalDays} days`}
                        </span>
                        <span className="text-[11px] text-muted/70">auto-renewal off</span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-xs text-muted">
                      {r.newOrders > 0 ? (
                        <span className="font-semibold text-warn">{r.newOrders} new</span>
                      ) : (
                        r.conversationCount
                      )}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-muted">
                      {formatMoney(r.totalSpend, true)}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted">
                      {formatDateTime(r.activatedAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}