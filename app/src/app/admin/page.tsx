import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminPanel } from "@/components/AdminPanel";
import { currentUser } from "@/lib/session";

export default async function AdminPage() {
  const user = await currentUser(await headers());
  if (!user) redirect("/login?next=/admin");
  if (user.role !== "admin") redirect("/");
  return <AdminPanel selfId={user.id} />;
}
