import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { App } from "@/components/App";
import { loginFor } from "@/lib/authz";
import { config } from "@/lib/config";
import { currentUser } from "@/lib/session";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await currentUser(await headers());
  if (!user) redirect(loginFor(await searchParams));
  return <App user={{ name: user.name, email: user.email, role: user.role ?? "user" }} desktopUrl={config.desktopUrl} />;
}
