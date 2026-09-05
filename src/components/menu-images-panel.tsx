"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef, useState } from "react";
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

interface LocalImage {
  key: string;
  url: string;
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
  const runningRef = useRef(false);
  const [wa, setWa] = useState(autoWhatsapp);
  const [ig, setIg] = useState(autoInstagram);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [local, setLocal] = useState<LocalImage[]>(() =>
    images.map((im) => ({
      key: `s-${im.id}`,
      url: `/api/media/${restaurantId}/${im.id}`,
    }))
  );

  const sig = images.map((im) => `${im.id}:${im.index}`).join(",");
  useEffect(() => {
    setLocal(
      images.map((im) => ({
        key: `s-${im.id}`,
        url: `/api/media/${restaurantId}/${im.id}`,
      }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  function run(fn: (fd: FormData) => Promise<void>, fd: FormData, okText: string) {
    if (runningRef.current) return;
    runningRef.current = true;
    setMsg({ tone: "good", text: okText });
    startTransition(async () => {
      try {
        await fn(fd);
        router.refresh();
      } catch (err) {
        console.error(err);
        setMsg({
          tone: "bad",
          text: "Saved locally but syncing failed — a page refresh will retry.",
        });
      } finally {
        runningRef.current = false;
      }
    });
  }

  function submitPrefs(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("restaurantId", restaurantId);
    if (wa) fd.set("autoMenuWhatsapp", "on");
    if (ig) fd.set("autoMenuInstagram", "on");
    run(saveMenuPrefs, fd, "Menu auto-send preferences saved ✓");
  }

  function submitUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const files = fileRef.current?.files;
    if (!files || files.length === 0) {
      setMsg({ tone: "bad", text: "Choose at least one image first." });
      return;
    }
    const fileList = Array.from(files);
    setLocal((prev) => [
      ...prev,
      ...fileList.map((f) => ({
        key: `l-${Math.random().toString(36).slice(2)}`,
        url: URL.createObjectURL(f),
      })),
    ]);
    const clearFile = () => {
      if (fileRef.current) fileRef.current.value = "";
    };
    clearFile();

    const fd = new FormData();
    fd.set("restaurantId", restaurantId);
    for (const f of fileList) fd.append("images", f);
    run(addMenuImages, fd, `Added ${fileList.length} menu image(s) ✓`);
  }

  function removeImage(index: number) {
    setLocal((prev) => prev.filter((_, i) => i !== index));
    const fd = new FormData();
    fd.set("restaurantId", restaurantId);
    fd.set("index", String(index));
    run(removeMenuImage, fd, "Menu image removed ✓");
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
          className="ml-auto rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent"
        >
          Save preferences
        </button>
      </form>

      <form onSubmit={submitUpload} className="mb-4 flex flex-wrap items-end gap-3">
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
          className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-soft transition-colors hover:bg-surface"
        >
          Add images
        </button>
      </form>

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {local.length === 0 ? (
          <p className="col-span-full text-xs text-muted">No menu images uploaded yet.</p>
        ) : (
          local.map((img, i) => (
            <div
              key={img.key}
              className="group relative overflow-hidden rounded-lg border border-line"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt="Menu"
                className="aspect-square w-full object-cover"
              />
              <button
                type="button"
                onClick={() => removeImage(i)}
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