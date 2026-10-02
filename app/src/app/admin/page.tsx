import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminPanel } from "@/components/AdminPanel";
import { loginUrl } from "@/lib/authz";
import { currentUser } from "@/lib/session";

export default async function AdminPage() {
  const user = await currentUser(await headers());
  if (!user) redirect(loginUrl("/admin"));
  if (user.role !== "admin") redirect("/");
  return <AdminPanel selfId={user.id} />;
}
