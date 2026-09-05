import Link from "next/link";
import { Badge, Card, CardHeader } from "@/components/ui";
import {
  getDashboardStats,
  getRecentErrors,
  getRestaurantsOverview,
} from "@/lib/queries";
import { formatMoney } from "@/lib/utils";

export default async function DashboardPage() {
  const stats = await getDashboardStats();
  const restaurants = await getRestaurantsOverview();
  const recentErrors = await getRecentErrors(6);

  const connected = restaurants.filter(
    (r) => r.whatsappStatus === "connected" || r.instagramStatus === "connected"
  ).length;

  const cards = [
    {
      label: "Restaurants",
      value: String(stats.restaurantCount),
      sub: `${connected} with a connected channel`,
    },
    {
      label: "New orders",
      value: String(stats.newOrders),
      sub: "waiting to be pinned",
      tone: stats.newOrders > 0 ? "good" : "neutral",
    },
    {
      label: "Spent this month",
      value: formatMoney(stats.monthSpend, true),
      sub: "AI API usage (USD)",
    },
    {
      label: "Open issues",
      value: String(stats.openErrors),
      sub: "agent / gateway errors",
      tone: stats.openErrors > 0 ? "bad" : "good",
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-soft">Dashboard</h1>
        <p className="mt-1 text-sm text-muted">
          Overview of every restaurant you manage.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label} className="p-5">
            <p className="text-xs font-medium text-muted">{c.label}</p>
            <p className="mt-2 text-3xl font-bold text-soft">{c.value}</p>
            <p className="mt-1 text-[11px] text-muted/80">{c.sub}</p>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title="Restaurants"
          subtitle="Subscription counter (30 days from activation). Nothing stops automatically."
          action={
            <Link
              href="/admin/restaurants/new"
              className="rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent"
            >
              + Add restaurant
            </Link>
          }
        />
        <div className="divide-y divide-line">
          {restaurants.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-muted">
              No restaurants yet. Add your first one to start training its agent.
            </div>
          ) : (
            restaurants.slice(0, 6).map((r) => {
              const linked =
                r.whatsappStatus === "connected" || r.instagramStatus === "connected";
              return (
                <Link
                  key={r.id}
                  href={`/admin/restaurants/${r.id}`}
                  className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-surface"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-2 w-2 rounded-full ${
                        linked ? "bg-good" : r.agentEnabled ? "bg-warn" : "bg-line2"
                      }`}
                    />
                    <div>
                      <p className="text-sm font-medium text-soft">{r.name}</p>
                      <p className="text-[11px] text-muted">
                        {r.newOrders > 0 ? `${r.newOrders} new order(s) · ` : ""}
                        {r.whatsappStatus === "connected" ? "WhatsApp · " : ""}
                        {r.instagramStatus === "connected" ? "Instagram" : ""}
                      </p>
                    </div>
                  </div>
                  <Badge
                    tone={r.agentEnabled ? "info" : "neutral"}
                  >
                    {r.agentEnabled ? "Active" : "Paused"}
                  </Badge>
                </Link>
              );
            })
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Recent agent errors" subtitle="Last failures across restaurants." />
        <div className="divide-y divide-line">
          {recentErrors.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted">No errors recorded. Great.</div>
          ) : (
            recentErrors.map((e) => (
              <div key={e.id} className="px-5 py-3 text-sm">
                <p className="font-mono text-xs text-bad">{e.source}</p>
                <p className="mt-0.5 text-xs text-soft">{e.message}</p>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}