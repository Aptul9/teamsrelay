import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { safeNext } from "@/lib/authz";
import { currentUser } from "@/lib/session";

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next ?? null);
  if (await currentUser(await headers())) redirect(next);
  return <LoginForm next={next} />;
}
