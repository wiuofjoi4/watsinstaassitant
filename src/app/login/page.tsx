import { login } from "@/app/admin/actions";
import { isAdmin } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  if (await isAdmin()) redirect("/admin");

  return (
    <main className="flex flex-1 items-center justify-center bg-base px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-navy/30 text-2xl font-bold text-primary ring-1 ring-primary/30">
            R
          </div>
          <h1 className="text-xl font-semibold text-soft">Repli Control</h1>
          <p className="mt-1 text-sm text-muted">
            AI sales agents for restaurants — admin sign in.
          </p>
        </div>

        <form
          action={async (fd) => {
            "use server";
            await login(null, fd);
          }}
          className="space-y-4 rounded-xl border border-line bg-card p-6"
        >
          <div>
            <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-muted">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-soft placeholder:text-muted/60 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
              placeholder="Admin password"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent"
          >
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}