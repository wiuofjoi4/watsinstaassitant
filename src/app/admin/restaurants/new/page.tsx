import Link from "next/link";
import { createRestaurant } from "@/app/admin/actions";
import { Card, Field, Input } from "@/components/ui";

export default function NewRestaurantPage() {
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <Link href="/admin/restaurants" className="text-xs text-muted hover:text-soft">
          ← Back to restaurants
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-soft">
          Add restaurant
        </h1>
        <p className="mt-1 text-sm text-muted">
          Create the business, then go to the Agent tab to train its AI agent.
        </p>
      </div>

      <Card className="p-6">
        <form action={createRestaurant} className="space-y-4">
          <Field label="Restaurant name" hint="Used as the default agent identity.">
            <Input
              name="name"
              placeholder="e.g. Shawarma House"
              required
              autoFocus
            />
          </Field>
          <div className="flex justify-end gap-3 pt-2">
            <Link
              href="/admin/restaurants"
              className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:text-soft"
            >
              Cancel
            </Link>
            <button
              type="submit"
              className="rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent"
            >
              Create restaurant
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}