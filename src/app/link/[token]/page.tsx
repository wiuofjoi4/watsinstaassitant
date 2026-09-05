import { notFound } from "next/navigation";
import { getRestaurantByLinkToken } from "@/lib/queries";

export default async function LinkPage(
  props: PageProps<"/link/[token]">
) {
  const { token } = await props.params;
  const restaurant = await getRestaurantByLinkToken(decodeURIComponent(token));
  if (!restaurant) notFound();

  const gatewayBase = process.env.GATEWAY_QR_BASE_URL;
  const qrUrl = gatewayBase
    ? `${gatewayBase}/qr/${restaurant.id}/whatsapp`
    : null;

  return (
    <main className="flex flex-1 flex-col items-center justify-center bg-base px-6 py-16">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-navy/30 text-2xl font-bold text-primary ring-1 ring-primary/30">
            R
          </div>
          <h1 className="text-xl font-semibold text-soft">
            AI Receptionist for {restaurant.name}
          </h1>
          <p className="mt-1 text-sm text-muted">
            Scan with your phone to connect your accounts.
          </p>
        </div>

        <div className="rounded-xl border border-line bg-card p-6">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-medium text-soft">WhatsApp</p>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                restaurant.whatsappLinked
                  ? "bg-good/15 text-good"
                  : "bg-warn/15 text-warn"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  restaurant.whatsappLinked ? "bg-good" : "bg-warn"
                }`}
              />
              {restaurant.whatsappLinked ? "Connected" : "Waiting for scan"}
            </span>
          </div>

          <div className="flex items-center justify-center rounded-lg border border-dashed border-line bg-surface py-6">
            {qrUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- QR is a live stream from the gateway
              <img
                src={qrUrl}
                alt="WhatsApp QR code"
                className="h-56 w-56"
                width={224}
                height={224}
              />
            ) : (
              <div className="text-center">
                <p className="text-sm text-muted">QR not available yet.</p>
                <p className="mt-1 text-xs text-muted/70">
                  The connection server is not running.
                </p>
              </div>
            )}
          </div>

          <ol className="mt-4 space-y-1.5 text-xs text-muted">
            <li>1. Open WhatsApp on your phone.</li>
            <li>2. Settings → Linked devices → Link a device.</li>
            <li>3. Scan this QR code with your phone.</li>
          </ol>
        </div>

        <div className="rounded-xl border border-line bg-card p-6">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-medium text-soft">Instagram</p>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                restaurant.instagramLinked
                  ? "bg-good/15 text-good"
                  : "bg-warn/15 text-warn"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  restaurant.instagramLinked ? "bg-good" : "bg-warn"
                }`}
              />
              {restaurant.instagramLinked ? "Connected" : "Set up by the team"}
            </span>
          </div>
          <p className="text-xs text-muted">
            Instagram has no phone-QR like WhatsApp. The team connects your
            professional Instagram account through Meta&apos;s official API — just
            share your account and the connection will be handled for you.
          </p>
        </div>

        <p className="text-center text-[11px] text-muted/60">
          Need help? Contact the team.
        </p>
      </div>
    </main>
  );
}