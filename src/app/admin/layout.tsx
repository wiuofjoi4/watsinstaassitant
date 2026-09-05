import Link from "next/link";
import { logout } from "@/app/admin/actions";
import { isAdmin } from "@/lib/auth";
import { redirect } from "next/navigation";

const NAV = [
  { href: "/admin", label: "Dashboard", icon: "▦" },
  { href: "/admin/restaurants", label: "Restaurants", icon: "✤" },
];

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await isAdmin())) redirect("/login");

  return (
    <div className="flex min-h-full bg-base">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface/60 md:flex">
        <div className="flex items-center gap-2.5 border-b border-line px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy/30 text-lg font-bold text-primary ring-1 ring-primary/30">
            R
          </div>
          <div>
            <p className="text-sm font-semibold text-soft">Repli</p>
            <p className="text-[11px] text-muted">Agent Control Panel</p>
          </div>
        </div>
        <nav className="flex flex-col gap-1 p-3">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-line hover:text-soft"
            >
              <span className="text-primary/70">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto space-y-3 border-t border-line p-4">
          <p className="text-[11px] text-muted/70">
            Deployment: Vercel · WhatsApp + Instagram
          </p>
          <form
            action={async () => {
              "use server";
              await logout();
            }}
          >
            <button
              type="submit"
              className="w-full rounded-lg border border-line px-3 py-2 text-xs font-medium text-muted transition-colors hover:bg-line hover:text-soft"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-line bg-base/85 px-5 py-3.5 backdrop-blur md:hidden">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-navy/30 text-base font-bold text-primary ring-1 ring-primary/30">
              R
            </div>
            <p className="text-sm font-semibold text-soft">Repli Admin</p>
          </div>
          <form
            action={async () => {
              "use server";
              await logout();
            }}
          >
            <button className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted">
              Sign out
            </button>
          </form>
        </header>
        <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}