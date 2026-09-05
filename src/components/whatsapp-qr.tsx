"use client";

import { useEffect, useState } from "react";

export default function WhatsAppQR({
  qrUrl,
  statusUrl,
  initiallyLinked,
}: {
  qrUrl: string | null;
  statusUrl: string;
  initiallyLinked: boolean;
}) {
  const [linked, setLinked] = useState(initiallyLinked);
  const [src, setSrc] = useState<string | null>(
    qrUrl ? `${qrUrl}?_=${Date.now()}` : null
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!qrUrl || linked) return;
    const timer = setInterval(() => {
      setFailed(false);
      setSrc(`${qrUrl}?_=${Date.now()}`);
      fetch(statusUrl, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (d.linked) {
            setLinked(true);
            clearInterval(timer);
            window.location.reload();
          }
        })
        .catch(() => {
          /* transient network error — keep polling */
        });
    }, 4000);
    return () => clearInterval(timer);
  }, [qrUrl, statusUrl, linked]);

  useEffect(() => {
    if (!src) return;
    const img = new Image();
    img.onload = () => setFailed(false);
    img.onerror = () => setFailed(true);
    img.src = src;
  }, [src]);

  if (linked) return null;

  return (
    <div className="flex w-full flex-col items-center">
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- QR is a live stream from the gateway
        <img
          src={src}
          alt="WhatsApp QR code"
          className="h-56 w-56"
          width={224}
          height={224}
        />
      ) : (
        <div className="text-center">
          <p className="text-sm text-muted">QR not available yet.</p>
          <p className="mt-1 text-xs text-muted/70">
            The connection server is starting… please wait a few seconds.
          </p>
        </div>
      )}
      <p className="mt-3 text-[11px] text-muted/70">
        The QR refreshes automatically. Scan it on your phone within a few seconds.
      </p>
    </div>
  );
}