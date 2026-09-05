import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addMenuImages,
  connectInstagram,
  disconnectInstagram,
  generateLink,
  removeMenuImage,
  resolveError,
  saveAgentConfig,
  saveMenuPrefs,
  setOrderStatus,
  toggleAgent,
} from "@/app/admin/actions";
import { Badge, Card, CardHeader, EmptyState, Field, Input, Select, Textarea, Toggle } from "@/components/ui";
import {
  getRestaurantConversations,
  getRestaurantDetail,
  getRestaurantErrors,
  getRestaurantOrders,
  getRestaurantUsage,
} from "@/lib/queries";
import { formatDateTime, formatMoney } from "@/lib/utils";

const TABS = ["overview", "agent", "conversations", "orders", "errors", "usage"] as const;

export default async function RestaurantDetailPage(
  props: PageProps<"/admin/restaurants/[id]">
) {
  const { id } = await props.params;
  const search = await props.searchParams;
  const tab = (TABS as readonly string[]).includes(String(search.tab))
    ? String(search.tab)
    : "overview";

  const restaurant = await getRestaurantDetail(id);
  if (!restaurant) notFound();

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const linkUrl = restaurant.linkToken
    ? `${appUrl}/link/${restaurant.linkToken}`
    : null;

  const menuImages = parseMenuImages(restaurant.menuImages);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <Link href="/admin/restaurants" className="text-xs text-muted hover:text-soft">
          ← Restaurants
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-soft">{restaurant.name}</h1>
      </div>

      {/* Status + actions bar */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-6">
            <StatusChip
              label="Agent"
              ok={restaurant.agentEnabled}
              okText="Active"
              badText="Paused"
            />
            <StatusChip
              label="WhatsApp"
              ok={restaurant.whatsappStatus === "connected"}
              okText={restaurant.whatsappStatus}
              badText={restaurant.whatsappStatus ?? "disconnected"}
              badTone={restaurant.whatsappStatus === "waiting" ? "warn" : "neutral"}
            />
            <StatusChip
              label="Instagram"
              ok={restaurant.instagramStatus === "connected"}
              okText={restaurant.instagramStatus}
              badText={restaurant.instagramStatus ?? "disconnected"}
              badTone={restaurant.instagramStatus === "waiting" ? "warn" : "neutral"}
            />
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted">Activated</p>
              <p className="text-sm text-soft">{formatDateTime(restaurant.activatedAt)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted">Lifetime spend</p>
              <p className="font-mono text-sm text-soft">{formatMoney(restaurant.totalSpendUsd, true)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <form action={toggleAgent}>
              <input type="hidden" name="restaurantId" value={restaurant.id} />
              <button
                type="submit"
                className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                  restaurant.agentEnabled
                    ? "border border-bad/30 bg-bad/15 text-bad hover:bg-bad/25"
                    : "border border-good/30 bg-good/15 text-good hover:bg-good/25"
                }`}
              >
                {restaurant.agentEnabled ? "⏸ Pause agent" : "▶ Resume agent"}
              </button>
            </form>
            <form action={generateLink}>
              <input type="hidden" name="restaurantId" value={restaurant.id} />
              <button
                type="submit"
                className="rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent"
              >
                {restaurant.linkToken ? "↻ New link" : "Generate QR link"}
              </button>
            </form>
          </div>
        </div>
        {linkUrl ? (
          <div className="mt-4 rounded-lg border border-primary/25 bg-primary/5 px-3.5 py-2.5">
            <p className="text-[11px] uppercase tracking-wider text-primary">Linking link — send this to the owner</p>
            <p className="mt-0.5 break-all font-mono text-xs text-soft">{linkUrl}</p>
          </div>
        ) : null}
      </Card>

      {/* Instagram channel */}
      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-soft">Instagram channel</p>
            <p className="mt-0.5 text-xs text-muted">
              Connect a Meta professional account — the agent replies to DMs via the official
              Instagram API once you&apos;ve configured the Meta webhook.
            </p>
          </div>
          <StatusChip
            label="Status"
            ok={restaurant.instagramStatus === "connected"}
            okText={restaurant.instagramStatus}
            badText={restaurant.instagramStatus ?? "disconnected"}
            badTone={restaurant.instagramStatus === "waiting" ? "warn" : "neutral"}
          />
        </div>

        {restaurant.instagramLinked && restaurant.instagramIgId ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-line bg-surface/60 p-3">
                <p className="text-[11px] uppercase tracking-wider text-muted">Account ID</p>
                <p className="mt-0.5 break-all font-mono text-xs text-soft">{restaurant.instagramIgId}</p>
              </div>
              <div className="rounded-lg border border-line bg-surface/60 p-3">
                <p className="text-[11px] uppercase tracking-wider text-muted">Username</p>
                <p className="mt-0.5 text-xs text-soft">{restaurant.instagramUsername ?? "—"}</p>
              </div>
            </div>
            <p className="text-xs text-muted">
              Token stored (redacted). To receive DMs, point Meta&apos;s Webhooks app to{" "}
              <code className="font-mono text-muted/80">
                {appUrl}/api/webhooks/instagram
              </code>{" "}
              with verify token <code className="font-mono text-muted/80">INSTAGRAM_VERIFY_TOKEN</code>.
            </p>
            <form action={disconnectInstagram}>
              <input type="hidden" name="restaurantId" value={restaurant.id} />
              <button
                type="submit"
                className="rounded-lg border border-bad/30 bg-bad/15 px-3.5 py-2 text-sm font-medium text-bad transition-colors hover:bg-bad/25"
              >
                Disconnect Instagram
              </button>
            </form>
          </div>
        ) : (
          <form action={connectInstagram} className="space-y-4">
            <input type="hidden" name="restaurantId" value={restaurant.id} />
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Instagram account ID" hint="Numeric IG ID of the professional account.">
                <Input name="igId" placeholder="17841400000000000" required />
              </Field>
              <Field label="Username" hint="e.g. your.restaurant (optional).">
                <Input name="username" placeholder="your.restaurant" />
              </Field>
              <Field label="Access token" hint="Meta long-lived token with instagram_business_basic + instagram_manage_messages.">
                <Input name="accessToken" type="password" placeholder="EAA..." required />
              </Field>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent"
              >
                Save Instagram connection
              </button>
            </div>
          </form>
        )}
      </Card>

      {/* Menu images + auto-send */}
      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-soft">Menu images & auto-send</p>
            <p className="mt-0.5 text-xs text-muted">
              Upload the menu pictures. When enabled for a channel, the agent will
              send them to any customer message that is not a direct order.
            </p>
          </div>
        </div>

        <form action={saveMenuPrefs} className="mb-5 flex flex-wrap items-center gap-6 rounded-lg border border-line bg-surface/60 p-4">
          <input type="hidden" name="restaurantId" value={restaurant.id} />
          <label className="flex items-center gap-2.5 text-sm text-soft">
            <Toggle key={`mw-${restaurant.autoMenuWhatsapp}`} checked={restaurant.autoMenuWhatsapp} name="autoMenuWhatsapp" />
            Auto-send on WhatsApp
          </label>
          <label className="flex items-center gap-2.5 text-sm text-soft">
            <Toggle key={`mi-${restaurant.autoMenuInstagram}`} checked={restaurant.autoMenuInstagram} name="autoMenuInstagram" />
            Auto-send on Instagram
          </label>
          <button
            type="submit"
            className="ml-auto rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent"
          >
            Save preferences
          </button>
        </form>

        <div className="space-y-4">
          <form action={addMenuImages} className="flex flex-wrap items-end gap-3" encType="multipart/form-data">
            <input type="hidden" name="restaurantId" value={restaurant.id} />
            <input
              type="file"
              name="images"
              multiple
              accept="image/*"
              className="block w-full max-w-sm text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-primary/10 file:px-3 file:py-2 file:text-xs file:font-medium file:text-primary"
            />
            <button
              type="submit"
              className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-soft transition-colors hover:bg-surface"
            >
              Add images
            </button>
          </form>

          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
            {menuImages.length === 0 ? (
              <p className="col-span-full text-xs text-muted">No menu images uploaded yet.</p>
            ) : (
              menuImages.map((img, i) => (
                <div key={img.id} className="group relative overflow-hidden rounded-lg border border-line">
                  <img
                    src={`${appUrl}/api/media/${restaurant.id}/${i}`}
                    alt={`Menu ${i + 1}`}
                    className="aspect-square w-full object-cover"
                  />
                  <form action={removeMenuImage} className="absolute right-1 top-1">
                    <input type="hidden" name="restaurantId" value={restaurant.id} />
                    <input type="hidden" name="index" value={i} />
                    <button
                      type="submit"
                      title="Remove image"
                      className="rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white opacity-0 transition-opacity hover:bg-bad group-hover:opacity-100"
                    >
                      ✕
                    </button>
                  </form>
                </div>
              ))
            )}
          </div>
        </div>
      </Card>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <Link
            key={t}
            href={`/admin/restaurants/${restaurant.id}?tab=${t}`}
            className={`rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
              tab === t
                ? "border-b-2 border-primary text-soft"
                : "text-muted hover:text-soft"
            }`}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </Link>
        ))}
      </div>

      {tab === "overview" ? (
        <OverviewTab restaurant={restaurant} />
      ) : tab === "agent" ? (
        <AgentTab restaurant={restaurant} />
      ) : tab === "conversations" ? (
        <ConversationsTab restaurantId={restaurant.id} />
      ) : tab === "orders" ? (
        <OrdersTab restaurantId={restaurant.id} />
      ) : tab === "errors" ? (
        <ErrorsTab restaurantId={restaurant.id} />
      ) : (
        <UsageTab restaurantId={restaurant.id} />
      )}
    </div>
  );
}

interface MenuImageRaw {
  id: string;
  mime: string;
  base64: string;
}

function parseMenuImages(raw: string | null | undefined): MenuImageRaw[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as MenuImageRaw[];
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x) => x && typeof x.base64 === "string" && typeof x.mime === "string"
    );
  } catch {
    return [];
  }
}

function StatusChip({
  label,
  ok,
  okText,
  badText,
  badTone = "neutral",
}: {
  label: string;
  ok: boolean;
  okText: string;
  badText: string;
  badTone?: "neutral" | "warn" | "bad";
}) {
  const tone = ok ? "good" : badTone;
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
      <Badge tone={ok ? "good" : tone}>
        <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-good" : badTone === "warn" ? "bg-warn" : "bg-line2"}`} />
        {ok ? okText : badText}
      </Badge>
    </div>
  );
}

function OverviewTab({ restaurant }: { restaurant: NonNullable<Awaited<ReturnType<typeof getRestaurantDetail>>> }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card className="p-5">
        <p className="text-xs text-muted">Conversations handled</p>
        <p className="mt-1 text-2xl font-bold text-soft">{restaurant.conversationCount}</p>
      </Card>
      <Card className="p-5">
        <p className="text-xs text-muted">Orders captured</p>
        <p className="mt-1 text-2xl font-bold text-soft">{restaurant.orderCount}</p>
      </Card>
      <Card className="p-5">
        <p className="text-xs text-muted">WhatsApp session</p>
        <p className="mt-1 text-sm text-soft">{restaurant.whatsappJid ?? "Not linked yet"}</p>
      </Card>
      <Card className="p-5">
        <p className="text-xs text-muted">Agent training</p>
        <p className="mt-1 text-sm text-soft">
          {restaurant.agent?.menu ? "Menu loaded ✓" : "Menu not loaded yet — go to Agent tab."}
        </p>
      </Card>
    </div>
  );
}

function AgentTab({ restaurant }: { restaurant: NonNullable<Awaited<ReturnType<typeof getRestaurantDetail>>> }) {
  const a = restaurant.agent;
  return (
    <Card>
      <CardHeader
        title="Train the agent"
        subtitle="This data builds the restaurant's unique AI assistant. One shared model, one unique agent per restaurant."
      />
      <form action={saveAgentConfig} className="space-y-6 p-6">
        <input type="hidden" name="restaurantId" value={restaurant.id} />
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Business name" hint="How the agent introduces itself.">
            <Input name="businessName" defaultValue={a?.businessName ?? restaurant.name} />
          </Field>
          <Field label="Tone">
            <Select name="tone" defaultValue={a?.tone ?? "friendly"}>
              <option value="friendly">Friendly</option>
              <option value="formal">Formal</option>
              <option value="casual">Casual</option>
            </Select>
          </Field>
          <Field label="Languages" hint="Comma separated, e.g. ar,en">
            <Input name="languages" defaultValue={a?.languages ?? "ar,en"} />
          </Field>
          <Field label="Temperature" hint="0 = strict, 1 = creative.">
            <Input type="number" min={0} max={1} step={0.1} name="temperature" defaultValue={a?.temperature ?? 0.7} />
          </Field>
          <Field label="Opening hours" hint="e.g. Daily 10:00–00:00">
            <Input name="hours" defaultValue={a?.hours ?? ""} />
          </Field>
          <Field label="Delivery policy" hint="e.g. Free delivery over $20, 30 min zone.">
            <Input name="deliveryPolicy" defaultValue={a?.deliveryPolicy ?? ""} />
          </Field>
        </div>

        <Field
          label="Menu (name — price, one per line)"
          hint="Include specials, sides, drinks and delivery fees. The agent never invents prices."
        >
          <Textarea
            name="menu"
            rows={10}
            className="font-mono text-xs"
            placeholder={`Chicken shawarma — $3.50\nBeef burger — $4.00\nFries — $1.50\nCola — $1.00\n...`}
            defaultValue={a?.menu ?? ""}
          />
        </Field>

        <Field label="Policies" hint="Minimum order, deposit, packaging, bulk/party orders...">
          <Textarea name="policies" rows={4} defaultValue={a?.policies ?? ""} />
        </Field>

        <Field label="Additional instructions" hint="Anything the agent must always remember.">
          <Textarea name="customInstructions" rows={4} defaultValue={a?.customInstructions ?? ""} />
        </Field>

        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2.5 text-sm text-soft">
            <Toggle key={`phone-${a?.askPhone}`} checked={a?.askPhone ?? true} name="askPhone" />
            Ask for phone number
          </label>
          <label className="flex items-center gap-2.5 text-sm text-soft">
            <Toggle key={`addr-${a?.askAddress}`} checked={a?.askAddress ?? true} name="askAddress" />
            Ask for delivery address
          </label>
        </div>

        <div className="rounded-lg border border-line bg-surface/60 p-4">
          <p className="mb-2 text-xs font-medium text-muted">Generated system prompt (auto)</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted/90">
            {a?.systemPrompt ?? "Save the form once to generate the prompt."}
          </pre>
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:text-soft"
            disabled
          >
            Preview replies (soon)
          </button>
          <button
            type="submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent"
          >
            Save agent training
          </button>
        </div>
      </form>
    </Card>
  );
}

async function ConversationsTab({ restaurantId }: { restaurantId: string }) {
  const convos = await getRestaurantConversations(restaurantId);
  if (convos.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No conversations yet"
          description="Once the WhatsApp/Instagram channel is linked and customers message, their threads will appear here."
        />
      </Card>
    );
  }
  return (
    <Card>
      <div className="divide-y divide-line">
        {convos.map((c) => (
          <Link
            key={c.id}
            href={`/admin/restaurants/${restaurantId}/conversation/${c.id}`}
            className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-surface"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-soft">
                {c.customerName ?? c.remoteJid}
                <span className="ml-2 text-[11px] font-normal text-muted">{c.channel}</span>
              </p>
              <p className="truncate text-xs text-muted">
                {c.lastMessage
                  ? `${c.lastMessage.direction === "in" ? "Customer" : "Agent"}: ${c.lastMessage.text ?? c.lastMessage.contentType}`
                  : "No messages yet"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {c.newOrders > 0 ? <Badge tone="warn">{c.newOrders} new order</Badge> : null}
              {c.pinned ? <Badge tone="good">pinned</Badge> : null}
              {c.status === "manual" ? <Badge tone="neutral">manual</Badge> : null}
              <span className="text-[11px] text-muted/70">
                {formatDateTime(c.lastMessageAt)}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </Card>
  );
}

async function OrdersTab({ restaurantId }: { restaurantId: string }) {
  const orders = await getRestaurantOrders(restaurantId);
  if (orders.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No orders captured yet"
          description="When a customer finishes an order with the agent, it appears here ready to be pinned."
        />
      </Card>
    );
  }
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
              <th className="px-5 py-3 font-medium">Customer</th>
              <th className="px-5 py-3 font-medium">Items</th>
              <th className="px-5 py-3 font-medium">Total</th>
              <th className="px-5 py-3 font-medium">Phone</th>
              <th className="px-5 py-3 font-medium">Address</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {orders.map((o) => {
              const statusTone =
                o.status === "new"
                  ? "warn"
                  : o.status === "declined"
                    ? "bad"
                    : o.status === "done"
                      ? "good"
                      : "info";
              return (
                <tr key={o.id} className="align-top">
                  <td className="px-5 py-3 text-soft">
                    {o.customerName ?? "—"}
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-muted">
                    {o.itemsJson}
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-soft">
                    {o.total != null ? `$${o.total.toFixed(2)}` : "—"}
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-muted">{o.phone ?? "—"}</td>
                  <td className="max-w-[160px] truncate px-5 py-3 text-xs text-muted">{o.address ?? "—"}</td>
                  <td className="px-5 py-3">
                    <Badge tone={statusTone}>{o.status}</Badge>
                    <form action={setOrderStatus} className="mt-1.5">
                      <input type="hidden" name="orderId" value={o.id} />
                      <input type="hidden" name="restaurantId" value={restaurantId} />
                      <select
                        name="status"
                        onChange={(e) => e.target.form?.requestSubmit()}
                        defaultValue={o.status}
                        className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-muted focus:outline-none"
                      >
                        <option value="new">new</option>
                        <option value="pinned">pinned</option>
                        <option value="preparing">preparing</option>
                        <option value="done">done</option>
                        <option value="declined">declined</option>
                      </select>
                    </form>
                  </td>
                  <td className="px-5 py-3 text-xs text-muted">{formatDateTime(o.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

async function ErrorsTab({ restaurantId }: { restaurantId: string }) {
  const errors = await getRestaurantErrors(restaurantId);
  if (errors.length === 0) {
    return (
      <Card>
        <EmptyState title="No errors" description="Any agent or gateway failures will show here." />
      </Card>
    );
  }
  return (
    <Card>
      <div className="divide-y divide-line">
        {errors.map((e) => (
          <div key={e.id} className="px-5 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-xs text-bad">
                {e.source} · {formatDateTime(e.createdAt)}
              </p>
              {!e.resolved ? (
                <form action={resolveError}>
                  <input type="hidden" name="errorId" value={e.id} />
                  <input type="hidden" name="restaurantId" value={restaurantId} />
                  <button className="rounded-md border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:text-soft">
                    Mark resolved
                  </button>
                </form>
              ) : (
                <Badge tone="good">resolved</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-soft">{e.message}</p>
            {e.stack ? <pre className="mt-1 max-h-40 overflow-auto font-mono text-[11px] text-muted/70">{e.stack}</pre> : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

async function UsageTab({ restaurantId }: { restaurantId: string }) {
  const { logs, totals } = await getRestaurantUsage(restaurantId);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <p className="text-xs text-muted">Total cost</p>
          <p className="mt-1 text-2xl font-bold text-soft">{formatMoney(totals.cost, true)}</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs text-muted">Tokens (in / out)</p>
          <p className="mt-1 font-mono text-sm text-soft">
            {totals.input.toLocaleString()} / {totals.output.toLocaleString()}
          </p>
        </Card>
        <Card className="p-5">
          <p className="text-xs text-muted">Voice seconds</p>
          <p className="mt-1 text-2xl font-bold text-soft">{totals.audio.toLocaleString()}s</p>
        </Card>
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                <th className="px-5 py-3 font-medium">When</th>
                <th className="px-5 py-3 font-medium">Model</th>
                <th className="px-5 py-3 font-medium">Input</th>
                <th className="px-5 py-3 font-medium">Output</th>
                <th className="px-5 py-3 font-medium">Audio</th>
                <th className="px-5 py-3 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-muted">No usage yet.</td>
                </tr>
              ) : (
                logs.map((l) => (
                  <tr key={l.id}>
                    <td className="px-5 py-2.5 text-xs text-muted">{formatDateTime(l.createdAt)}</td>
                    <td className="px-5 py-2.5 font-mono text-xs text-soft">{l.model}</td>
                    <td className="px-5 py-2.5 font-mono text-xs text-muted">{l.inputTokens}</td>
                    <td className="px-5 py-2.5 font-mono text-xs text-muted">{l.outputTokens}</td>
                    <td className="px-5 py-2.5 font-mono text-xs text-muted">{l.audioSeconds}s</td>
                    <td className="px-5 py-2.5 font-mono text-xs text-soft">{formatMoney(l.costUsd, true)}</td>
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