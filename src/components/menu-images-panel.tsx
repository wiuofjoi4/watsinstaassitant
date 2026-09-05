"use client";

import { useRouter } from "next/navigation";
import { startTransition, useRef, useState } from "react";
import {
  addMenuImages,
  removeMenuImage,
  saveMenuPrefs,
} from "@/app/admin/actions";
import { Toggle } from "@/components/ui";

interface PanelImage {
  id: string;
  index: number;
}

export default function MenuImagesPanel({
  restaurantId,
  images,
  autoWhatsapp,
  autoInstagram,
}: {
  restaurantId: string;
  images: PanelImage[];
  autoWhatsapp: boolean;
  autoInstagram: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [wa, setWa] = useState(autoWhatsapp);
  const [ig, setIg] = useState(autoInstagram);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  function run(fn: (fd: FormData) => Promise<void>, fd: FormData, okText: string) {
    setBusy(true);
    setMsg(null);
    startTransition(async () => {
      try {
        await fn(fd);
        router.refresh();
        setMsg({ tone: "good", text: okText });
      } catch {
        setMsg({ tone: "bad", text: "Something went wrong, please try again." });
      } finally {
        setBusy(false);
      }
    });
  }

  function submitPrefs(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("restaurantId", restaurantId);
    if (wa) fd.set("autoMenuWhatsapp", "on");
    if (ig) fd.set("autoMenuInstagram", "on");
    run(saveMenuPrefs, fd, "Menu auto-send preferences saved.");
  }

  function submitUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const files = fileRef.current?.files;
    if (!files || files.length === 0) {
      setMsg({ tone: "bad", text: "Choose at least one image first." });
      return;
    }
    const fd = new FormData();
    fd.set("restaurantId", restaurantId);
    for (const f of Array.from(files)) {
      fd.append("images", f);
    }
    run(addMenuImages, fd, `Added ${files.length} menu image(s).`);
    if (fileRef.current) fileRef.current.value = "";
  }

  function removeImage(index: number) {
    const fd = new FormData();
    fd.set("restaurantId", restaurantId);
    fd.set("index", String(index));
    run(removeMenuImage, fd, "Menu image removed.");
  }

  return (
    <div className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-soft">Menu images & auto-send</p>
          <p className="mt-0.5 text-xs text-muted">
            Upload the menu pictures. When enabled for a channel, the agent will send
            them to any customer message that is not a direct order.
          </p>
        </div>
      </div>

      {msg ? (
        <div
          className={`mb-4 rounded-lg border px-3.5 py-2.5 text-xs ${
            msg.tone === "good"
              ? "border-good/30 bg-good/10 text-good"
              : "border-bad/30 bg-bad/10 text-bad"
          }`}
        >
          {msg.text}
        </div>
      ) : null}

      <form
        onSubmit={submitPrefs}
        className="mb-5 flex flex-wrap items-center gap-6 rounded-lg border border-line bg-surface/60 p-4"
      >
        <label className="flex items-center gap-2.5 text-sm text-soft">
          <Toggle checked={wa} onChange={() => setWa((v) => !v)} />
          Auto-send on WhatsApp
        </label>
        <label className="flex items-center gap-2.5 text-sm text-soft">
          <Toggle checked={ig} onChange={() => setIg((v) => !v)} />
          Auto-send on Instagram
        </label>
        <button
          type="submit"
          disabled={busy}
          className="ml-auto rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent disabled:opacity-50"
        >
          Save preferences
        </button>
      </form>

      <form
        onSubmit={submitUpload}
        className="mb-4 flex flex-wrap items-end gap-3"
      >
        <input
          ref={fileRef}
          type="file"
          name="images"
          multiple
          accept="image/*"
          className="block w-full max-w-sm text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-primary/10 file:px-3 file:py-2 file:text-xs file:font-medium file:text-primary"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-soft transition-colors hover:bg-surface disabled:opacity-50"
        >
          Add images
        </button>
      </form>

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {images.length === 0 ? (
          <p className="col-span-full text-xs text-muted">No menu images uploaded yet.</p>
        ) : (
          images.map((img) => (
            <div
              key={img.id}
              className="group relative overflow-hidden rounded-lg border border-line"
            >
              <img
                src={`/api/media/${restaurantId}/${img.index}`}
                alt="Menu"
                className="aspect-square w-full object-cover"
              />
              <button
                type="button"
                onClick={() => removeImage(img.index)}
                title="Remove image"
                className="absolute right-1 top-1 rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white opacity-0 transition-opacity hover:bg-bad group-hover:opacity-100"
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}