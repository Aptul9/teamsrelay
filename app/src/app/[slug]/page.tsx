import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { nowSeconds } from "@/agent/context";
import { StatusDashboard } from "@/components/StatusDashboard";
import { appDb } from "@/lib/appdb";
import { SLUG, statusAnswer } from "@/lib/status-pages";

// A status page of the status challenge, public: no session (app/status-challenge-spec.md)
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

const answerOf = (slug: string) => (SLUG.test(slug) ? statusAnswer(appDb(), slug) : null);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const answer = answerOf((await params).slug);
  return { title: answer ? `${answer.name} · Status challenge` : "Not found", robots: { index: false, follow: false } };
}

export default async function StatusPage({ params }: Props) {
  const { slug } = await params;
  const answer = answerOf(slug);
  if (!answer) notFound();
  return <StatusDashboard slug={slug} initial={answer} serverNow={nowSeconds()} />;
}
