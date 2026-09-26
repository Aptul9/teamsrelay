import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";
import { Button } from "@/components/ui/button";

// Top bar of the pages outside the chats: back to the app, title, page actions. `width` matches the page body.
export function PageHeader({ title, width = "max-w-5xl", children }: { title: string; width?: string; children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-20 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className={cn("mx-auto flex h-14 items-center gap-2 px-3 md:px-6", width)}>
        <Button asChild variant="ghost" className="h-10 gap-2 px-2.5 md:h-9">
          <Link href="/">
            <ArrowLeftIcon />
            <span className="max-sm:sr-only">Chats</span>
          </Link>
        </Button>
        <h1 className="ml-1 text-base font-semibold">{title}</h1>
        <div className="ml-auto flex items-center gap-2">{children}</div>
      </div>
    </header>
  );
}
