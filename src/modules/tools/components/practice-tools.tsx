"use client";
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeftRight, Banknote, CalendarClock, CalendarDays, Gavel, Hourglass, ListChecks, Receipt, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { TOOL_IDS, type ToolId } from "../ids";
import { ArbitrationPanel, ChequePanel, LimitationPanel } from "./limitation-panel";
import { CauseListPanel } from "./causelist-panel";
import { CodePanel } from "./code-panel";
import { CondonationPanel } from "./condonation-panel";
import { CourtDaysPanel } from "./court-days-panel";
import { FeePanel } from "./fee-panel";
import { DecisionFooter } from "./shared";

const TOOLS: Record<ToolId, { label: string; hint: string; icon: LucideIcon; Panel: () => React.ReactElement }> = {
  limitation: { label: "Limitation", hint: "Last day under the Limitation Act", icon: CalendarClock, Panel: LimitationPanel },
  cheque: { label: "Cheque dishonour", hint: "s.138 NI Act timeline", icon: Banknote, Panel: ChequePanel },
  arbitration: { label: "Arbitration s.34", hint: "Set-aside timeline", icon: Gavel, Panel: ArbitrationPanel },
  condonation: { label: "Condonation of delay", hint: "Days of delay to explain", icon: Hourglass, Panel: CondonationPanel },
  "court-days": { label: "Court days", hint: "Working days on a court's calendar", icon: CalendarDays, Panel: CourtDaysPanel },
  causelist: { label: "Cause list search", hint: "Published lists, exact matches", icon: ListChecks, Panel: CauseListPanel },
  codes: { label: "IPC ↔ BNS converter", hint: "IPC, CrPC, IEA and the new codes", icon: ArrowLeftRight, Panel: CodePanel },
  fees: { label: "Court fee", hint: "From your verified slab table", icon: Receipt, Panel: FeePanel },
};

/**
 * /tools: deterministic practice tools over the India libraries, computed in the browser. Each tool keeps its own
 * state while the page is open (panels stay mounted), and the selected tool is mirrored in `?tool=`.
 */
export function PracticeTools({ initialTool }: { initialTool: ToolId }) {
  const [tool, setTool] = React.useState<ToolId>(initialTool);
  const router = useRouter();
  const pathname = usePathname();
  const tabRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (id: ToolId, focus = false) => {
    setTool(id);
    router.replace(`${pathname}?tool=${id}`, { scroll: false });
    if (focus) tabRefs.current[id]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = TOOL_IDS.indexOf(tool);
    const next = e.key === "ArrowDown" || e.key === "ArrowRight" ? TOOL_IDS[(i + 1) % TOOL_IDS.length] : e.key === "ArrowUp" || e.key === "ArrowLeft" ? TOOL_IDS[(i - 1 + TOOL_IDS.length) % TOOL_IDS.length] : e.key === "Home" ? TOOL_IDS[0] : e.key === "End" ? TOOL_IDS[TOOL_IDS.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    select(next, true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav aria-label="Practice tools" className="shrink-0 border-b md:w-[220px] md:border-b-0 md:border-r">
        <h1 className="sr-only md:not-sr-only md:block md:px-4 md:pt-4 md:pb-2 md:text-[12px] md:font-medium md:text-muted-foreground">Practice tools</h1>
        <div role="tablist" aria-orientation="vertical" onKeyDown={onKeyDown} className="flex gap-0.5 overflow-x-auto px-2 py-2 [scrollbar-width:none] md:flex-col md:overflow-visible md:pt-0">
          {TOOL_IDS.map((id) => {
            const t = TOOLS[id];
            const active = id === tool;
            return (
              <button
                key={id}
                ref={(el) => { tabRefs.current[id] = el; }}
                type="button"
                role="tab"
                id={`tool-tab-${id}`}
                aria-selected={active}
                aria-controls={`tool-panel-${id}`}
                tabIndex={active ? 0 : -1}
                onClick={() => select(id)}
                className={cn(
                  "flex shrink-0 items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <t.icon className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
                <span className="min-w-0">
                  <span className={cn("block whitespace-nowrap text-[12.5px]", active && "font-medium")}>{t.label}</span>
                  <span className="hidden text-[11px] leading-tight text-muted-foreground md:block">{t.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[960px] px-4 py-5 sm:px-6">
          {TOOL_IDS.map((id) => {
            const { Panel } = TOOLS[id];
            return (
              <div key={id} role="tabpanel" id={`tool-panel-${id}`} aria-labelledby={`tool-tab-${id}`} hidden={id !== tool}>
                <Panel />
              </div>
            );
          })}
          <DecisionFooter />
        </div>
      </div>
    </div>
  );
}
