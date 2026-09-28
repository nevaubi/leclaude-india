"use client";
import * as React from "react";
import { useT } from "@/lib/i18n/client";
import Link from "next/link";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { NewMatterDialog } from "@/modules/matters/components/new-matter-dialog";
import { useHome } from "./home-provider";
import { firstRunSteps } from "./first-run-model";

/**
 * Home before the first matter exists: a short checklist in place of empty widgets. Steps already
 * satisfied (a provider in the environment, a teammate added) show as done.
 */
export function FirstRunChecklist() {
  const { setup, aiConfigured, refresh } = useHome();
  const [newMatter, setNewMatter] = React.useState(false);
  const t = useT();
  const steps = firstRunSteps({ ...setup, aiConfigured });
  const remaining = steps.filter((s) => !s.done).length;
  return (
    <section aria-labelledby="first-run-title" className="w-full max-w-[640px] pt-2">
      <h2 id="first-run-title" className="text-[14px] font-semibold tracking-tight">{t("home.firstRun.title")}</h2>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground">{remaining === 0 ? t("home.firstRun.allSet") : t("home.firstRun.remaining", { remaining, total: steps.length })}</p>
      <ol className="mt-3 divide-y divide-line-quiet border-y border-line-quiet">
        {steps.map((s, i) => (
          <li key={s.id}>
            <Link href={s.href} onClick={(e) => { if (s.id === "matter" && !s.done) { e.preventDefault(); setNewMatter(true); } }} className="group flex items-start gap-3 px-1 py-2.5 hover:bg-accent/40 focus-ring rounded-sm">
              <span className={cn("mt-px flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] tabular", s.done ? "border-transparent bg-foreground/5 text-muted-foreground" : "text-foreground")} aria-hidden>
                {s.done ? <Check className="size-3" /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-[13px] font-medium", s.done && "text-muted-foreground line-through decoration-muted-foreground/40")}>{t(`home.firstRun.${s.id}.title`)}</span>
                <span className="block text-[12px] text-muted-foreground">{t(`home.firstRun.${s.id}.detail`)}</span>
              </span>
              <span className="mt-0.5 shrink-0 text-[11.5px] text-muted-foreground">{s.done ? t("home.firstRun.done") : <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" />}</span>
              <span className="sr-only">{s.done ? t("home.firstRun.completed") : t("home.firstRun.notCompleted")}</span>
            </Link>
          </li>
        ))}
      </ol>
      <NewMatterDialog open={newMatter} onOpenChange={setNewMatter} onCreated={() => { setNewMatter(false); void refresh(); }} />
    </section>
  );
}
