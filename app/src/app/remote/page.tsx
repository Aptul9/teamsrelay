import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { DesktopSwitcher } from "@/components/DesktopSwitcher";
import { accountsOf } from "@/lib/accounts";
import { loginUrl } from "@/lib/authz";
import { currentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Remote Teams" };

// The one remote desktop in a tab of its own, a button per account above it (docs/design/2026-09-29-desktop-switcher.md)
export default async function Remote({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account } = await searchParams;
  const asked = typeof account === "string" && /^\d+$/.test(account) ? account : "";
  const user = await currentUser(await headers());
  if (!user) redirect(loginUrl(asked ? `/remote?account=${asked}` : "/remote"));
  return <DesktopSwitcher accounts={accountsOf(user.id).accounts} initial={Number(asked)} />;
}
