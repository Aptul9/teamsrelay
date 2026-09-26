import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { App } from "@/components/App";
import { config } from "@/lib/config";
import { currentUser } from "@/lib/session";

export default async function Home() {
  const user = await currentUser(await headers());
  if (!user) redirect("/login");
  return <App user={{ name: user.name, email: user.email, role: user.role ?? "user" }} desktopUrl={config.desktopUrl} />;
}
