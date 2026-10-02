"use client";
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BookCopy, CalendarDays, ClipboardList, MessageSquareReply } from "lucide-react";
import { cn } from "@/lib/utils";
import { DRAFTING_TOOLS, type DraftingTool } from "../format";
import type { ViewerTarget } from "../text-viewer";
import { DatesTool } from "./dates-tool";
import { DefectsTool } from "./defects-tool";
import { PaperbookTool } from "./paperbook-tool";
import { ReplyTool } from "./reply-tool";

export interface DraftingProps { setId: string; setName: string; matterId: string | null; aiReady: boolean | null; fileCount: number; onView: (t: ViewerTarget) => void; onOpenTab: (tab: string) => void }

const TOOLS: { id: DraftingTool; label: string; hint: string; icon: typeof CalendarDays }[] = [
  { id: "dates", label: "List of dates", hint: "Synopsis and dated events with sources", icon: CalendarDays },
  { id: "paperbook", label: "Paperbook", hint: "Index, page numbers, annexures", icon: BookCopy },
  { id: "reply", label: "Para-wise reply", hint: "Written statement from a plaint", icon: MessageSquareReply },
  { id: "defects", label: "Defect cure", hint: "Registry objections checklist", icon: ClipboardList },
];

/** Drafting tab: list of dates & synopsis, paperbook builder, para-wise reply, defect cure (tool in ?tool=). */
export function DraftingTab(props: DraftingProps & { active: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const fromUrl = params.get("tool");
  const [tool, setTool] = React.useState<DraftingTool>((DRAFTING_TOOLS as readonly string[]).includes(fromUrl ?? "") ? (fromUrl as DraftingTool) : "dates");
  const [opened, setOpened] = React.useState<Set<DraftingTool>>(() => new Set([tool]));
  const select = (t: DraftingTool) => {
    setTool(t);
    setOpened((s) => (s.has(t) ? s : new Set([...s, t])));
    const sp = new URLSearchParams(params.toString());
    sp.set("tab", "drafting");
    sp.set("tool", t);
    router.replace(`${pathname}?${sp}`, { scroll: false });
  };
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav aria-label="Drafting tools" className="flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1.5 md:w-[208px] md:flex-col md:overflow-visible md:border-b-0 md:border-e md:px-2 md:py-3">
        {TOOLS.map((t) => {
          const Icon = t.icon;
          const on = t.id === tool;
          return (
            <button key={t.id} type="button" onClick={() => select(t.id)} aria-current={on ? "page" : undefined}
              className={cn("flex shrink-0 items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors md:w-full", on ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}>
              <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium">{t.label}</span>
                <span className="hidden text-[11px] leading-snug text-muted-foreground md:block">{t.hint}</span>
              </span>
            </button>
          );
        })}
      </nav>
      <div className="min-h-0 min-w-0 flex-1">
        {/* Tools stay mounted once opened so a running proposal or translation is not cancelled by switching tools. */}
        {opened.has("dates") && <div className={cn("h-full", tool !== "dates" && "hidden")}><DatesTool {...props} active={props.active && tool === "dates"} /></div>}
        {opened.has("paperbook") && <div className={cn("h-full", tool !== "paperbook" && "hidden")}><PaperbookTool {...props} /></div>}
        {opened.has("reply") && <div className={cn("h-full", tool !== "reply" && "hidden")}><ReplyTool {...props} /></div>}
        {opened.has("defects") && <div className={cn("h-full", tool !== "defects" && "hidden")}><DefectsTool {...props} /></div>}
      </div>
    </div>
  );
}
