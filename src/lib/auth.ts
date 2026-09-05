import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { hashSecret } from "./utils";

const ADMIN_COOKIE = "admin_session";

export function adminCookieValue(password: string): string {
  return hashSecret(password + "|repli");
}

export async function isAdmin(): Promise<boolean> {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return true;
  const jar = await cookies();
  const value = jar.get(ADMIN_COOKIE)?.value;
  return !!value && value === adminCookieValue(password);
}

export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) {
    redirect("/login");
  }
}

export function adminCookieMaxAge(): number {
  return 60 * 60 * 24 * 7;
}