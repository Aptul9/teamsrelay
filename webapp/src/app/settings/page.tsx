import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Settings } from "@/components/Settings";
import { currentUser } from "@/lib/session";

export default async function SettingsPage() {
  const user = await currentUser(await headers());
  if (!user) redirect("/login?next=/settings");
  return <Settings user={{ name: user.name, email: user.email }} />;
}
