"use client";
import * as React from "react";
import { T } from "@/lib/i18n/client";
import Link from "next/link";
import { KeyRound, MessageSquareText, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { Inspector } from "@/components/ui/inspector";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Composer, MessageList, SuggestionChips } from "@/components/ai";
import { useAgent } from "@/hooks/use-agent";
import { useHomeUI } from "../store";
import { useHome } from "./home-provider";

const SUGGESTIONS = [
  "What is due this week?",
  "Which of my tasks are overdue, and what should I do first?",
  "Summarize this week's Federal Register items for my practice areas",
  "Draft a status update for my most active matter",
  "What did the team post this week?",
];

/** True while the viewport is narrower than `px` (false during SSR and before mount). */
function useNarrow(px: number) {
  const [narrow, setNarrow] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${px - 1}px)`);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [px]);
  return narrow;
}

/**
 * Firm assistant as a right inspector. At xl and wider it is a resizable
 * column; below xl it opens as a right-hand sheet so the overview keeps its width.
 */
export function AssistantDock() {
  const open = useHomeUI((s) => s.dockOpen);
  const setOpen = useHomeUI((s) => s.setDockOpen);
  const narrow = useNarrow(1280);
  const [width, setWidth] = React.useState(360);

  if (narrow) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent width="max-w-md" className="w-full p-0" aria-describedby={undefined}>
          <SheetTitle className="sr-only">Assistant</SheetTitle>
          <AssistantBody onCollapse={() => setOpen(false)} inSheet />
        </SheetContent>
      </Sheet>
    );
  }

  if (!open) return null;
  return <AssistantBody onCollapse={() => setOpen(false)} width={width} onWidthChange={setWidth} />;
}

function AssistantBody({ onCollapse, inSheet, width, onWidthChange }: { onCollapse: () => void; inSheet?: boolean; width?: number; onWidthChange?: (w: number) => void }) {
  const { matterFilter, matterById, aiConfigured, userName } = useHome();
  const prefill = useHomeUI((s) => s.dockPrefill);
  const clearPrefill = useHomeUI((s) => s.clearDockPrefill);
  const [draft, setDraft] = React.useState("");
  const [noKey, setNoKey] = React.useState(!aiConfigured);
  const matter = matterById(matterFilter);

  const agent = useAgent({
    endpoint: "/api/ai/chat",
    extra: () => ({ matterId: matterFilter, research: { web: true, legal: true, internal: true } }),
    onEvent: (ev) => { if (ev.type === "error" && ev.code === "no_api_key") setNoKey(true); },
  });

  React.useEffect(() => {
    if (prefill) { setDraft(prefill.text); clearPrefill(); }
  }, [prefill, clearPrefill]);

  const send = (text: string) => { void agent.send(text); };

  return (
    <Inspector
      icon={MessageSquareText}
      title={<T k="home.section.assistant" />}
      subtitle={matter ? `Scoped to ${matter.shortName}` : "Calendar, tasks, matters, library, e-discovery and research"}
      onClose={inSheet ? undefined : onCollapse}
      closeShortcut="A"
      width={inSheet ? undefined : width}
      resizable={!inSheet}
      minWidth={320}
      maxWidth={560}
      onWidthChange={onWidthChange}
      className={cn(inSheet && "w-full border-l-0")}
      actions={agent.messages.length > 0 ? <Tip label="New conversation"><Button variant="ghost" size="icon-xs" onClick={() => { agent.reset(); setDraft(""); }} aria-label="New conversation"><RotateCcw className="size-3.5" /></Button></Tip> : undefined}
      bodyClassName="flex flex-col"
      footer={
        <div className="p-2">
          <Composer
            placeholder={matter ? `Ask about ${matter.shortName}…` : "Ask the assistant…"}
            value={draft}
            onValueChange={setDraft}
            streaming={agent.isStreaming}
            onStop={agent.stop}
            onSend={(text, attachments) => { void agent.send(text, { attachments }); }}
            minRows={2}
            className={cn(noKey && "opacity-80")}
          />
          <div className="mt-1 flex items-center justify-between px-0.5 text-[10px] text-muted-foreground">
            <span className="truncate">Web · CourtListener · Federal Register · Library · E-Discovery</span>
            <span><kbd>↵</kbd> send</span>
          </div>
        </div>
      }
      ariaLabel="Assistant"
    >
      {noKey && (
        <div className="flex items-start gap-2 border-b px-3 py-2 text-[11.5px] text-muted-foreground">
          <KeyRound className="mt-0.5 size-3.5 shrink-0" />
          <span>The assistant needs a model provider (Amazon Bedrock, Anthropic or OpenAI). <Link href="/settings#ai" className="text-foreground underline underline-offset-2">Connect one in Settings</Link>.</span>
        </div>
      )}
      <MessageList
        messages={agent.messages}
        statusLine={agent.statusLine}
        userName={userName}
        onRetry={(m) => send(m.content)}
        className="min-h-0 flex-1"
        emptyState={
          <div className="p-3">
            <div className="text-[12.5px] font-medium">Ask about today</div>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">Reads your calendar, tasks and matter context, searches the library and e-discovery sets, pulls case law and Federal Register documents, and drafts updates. Every answer cites its sources.</p>
            {matter && <p className="mt-1 text-[11px] text-muted-foreground">Scoped to <span className="font-medium text-foreground">{matter.shortName}</span>.</p>}
            <div className="mt-3 text-[11.5px] font-medium text-muted-foreground">Try</div>
            <SuggestionChips className="mt-1.5" suggestions={SUGGESTIONS} onPick={send} />
          </div>
        }
      />
    </Inspector>
  );
}
