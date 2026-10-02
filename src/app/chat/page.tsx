import type { Metadata } from "next";
import { pageDb } from "@/lib/db/request";
import { pagePrincipal } from "@/lib/auth/page";
import { listThreads } from "@/modules/chat/server/store";
import { ChatPage } from "@/modules/chat/components/chat-page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Chat" };

export default async function Page({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  await pageDb();
  const sp = await searchParams;
  const principal = await pagePrincipal("/chat");
  const threads = principal ? listThreads(principal.id) : [];
  return <ChatPage initialThreadId={sp.t} threads={threads} configured={Boolean(process.env.OPENAI_API_KEY?.trim())} signedIn={Boolean(principal)} />;
}
