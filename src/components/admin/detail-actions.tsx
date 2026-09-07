"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  generateLink,
  resolveError,
  setOrderStatus,
  toggleAgent,
} from "@/app/admin/actions";

/**
 * Client-side admin actions: optimistic UI + router.refresh() instead of a
 * full form navigation (which re-loaded the whole page on every click).
 */

export function AgentToggle({
  restaurantId,
  enabled,
}: {
  restaurantId: string;
  enabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [on, setOn] = useState(enabled ?? false);

  const run = () => {
    startTransition(async () => {
      const previous = on;
      const next = !previous;
      setOn(next);
      const fd = new FormData();
      fd.set("restaurantId", restaurantId);
      try {
        await toggleAgent(fd);
      } catch {
        setOn(previous);
      }
      router.refresh();
    });
  };

  return (
    <button
      type="button"
      onClick={run}
      disabled={pending}
      className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-60 ${
        on
          ? "border border-bad/30 bg-bad/15 text-bad hover:bg-bad/25"
          : "border border-good/30 bg-good/15 text-good hover:bg-good/25"
      }`}
    >
      {pending ? "…" : on ? "⏸ Pause agent" : "▶ Resume agent"}
    </button>
  );
}

export function GenerateLinkButton({
  restaurantId,
  hasLink,
}: {
  restaurantId: string;
  hasLink: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("restaurantId", restaurantId);
    try {
      await generateLink(fd);
    } finally {
      setBusy(false);
      router.refresh();
    }
  };

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      className="rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent disabled:opacity-60"
    >
      {busy ? "…" : hasLink ? "↻ New link" : "Generate QR link"}
    </button>
  );
}

const ORDER_STATUSES = ["new", "pinned", "preparing", "done", "declined"] as const;

export function OrderStatusSelect({
  orderId,
  restaurantId,
  status,
}: {
  orderId: string;
  restaurantId: string;
  status: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(status);

  return (
    <select
      disabled={pending}
      value={value}
      onChange={(e) => {
        const next = e.target.value;
        setValue(next);
        startTransition(async () => {
          const fd = new FormData();
          fd.set("orderId", orderId);
          fd.set("restaurantId", restaurantId);
          fd.set("status", next);
          try {
            await setOrderStatus(fd);
          } catch {
            setValue(status);
          }
          router.refresh();
        });
      }}
      className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-muted focus:outline-none disabled:opacity-60"
    >
      {ORDER_STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

export function ResolveErrorButton({
  errorId,
  restaurantId,
}: {
  errorId: string;
  restaurantId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("errorId", errorId);
    fd.set("restaurantId", restaurantId);
    try {
      await resolveError(fd);
    } finally {
      setBusy(false);
      router.refresh();
    }
  };

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      className="rounded-md border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:text-soft disabled:opacity-60"
    >
      {busy ? "…" : "Mark resolved"}
    </button>
  );
}