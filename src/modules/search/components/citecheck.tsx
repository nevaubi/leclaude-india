"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, CheckCircle2, ClipboardPaste, ExternalLink, FileText, HelpCircle, Loader2, ShieldCheck, WifiOff, XCircle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/misc";
import { markdownToDoc } from "@/modules/office/shared/markdown-doc";
import type { ExtractedCitation } from "../citations";
import type { CitationCheck } from "../types";

export interface CiteCheckResponse {
  extracted: ExtractedCitation[];
  checks: CitationCheck[];
  providerError?: string;
  summary: { total: number; resolved: number; unresolved: number; unchecked: number };
}

export async function runCiteCheck(text: string, signal?: AbortSignal): Promise<CiteCheckResponse> {
  const res = await fetch("/api/search/citecheck", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal });
  const j = (await res.json()) as CiteCheckResponse & { error?: string };
  if (!res.ok) throw new Error(j.error ?? res.statusText);
  return j;
}

type RowStatus = "resolved" | "unresolved" | "unchecked" | "structural";

function rowStatus(c: ExtractedCitation, check: CitationCheck | undefined, providerError?: string): RowStatus {
  if (c.kind !== "case") return "structural";
  if (!check) return providerError ? "unchecked" : "unchecked";
  return check.resolved ? "resolved" : "unresolved";
}

const norm = (s: string) => s.replace(/\s+/g, " ").replace(/,\s*\d+(?:[-–]\d+)?$/, "").trim().toLowerCase();

export function CiteCheckTable({ result, className }: { result: CiteCheckResponse; className?: string }) {
  const findCheck = (c: ExtractedCitation) => result.checks.find((k) => norm(k.citation) === norm(c.citation) || norm(c.citation).includes(norm(k.citation)) || norm(k.citation).includes(norm(c.citation)));
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge variant="muted">{result.summary.total} citation{result.summary.total === 1 ? "" : "s"}</Badge>
        <Badge variant="success"><CheckCircle2 className="size-3" /> {result.summary.resolved} resolved</Badge>
        <Badge variant={result.summary.unresolved ? "destructive" : "muted"}><XCircle className="size-3" /> {result.summary.unresolved} unresolved</Badge>
        {result.providerError && <Badge variant="warning"><WifiOff className="size-3" /> CourtListener: {result.providerError}</Badge>}
      </div>
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[34%]">Citation</TableHead>
              <TableHead className="w-[90px]">Kind</TableHead>
              <TableHead className="w-[120px]">Status</TableHead>
              <TableHead>Resolved to</TableHead>
              <TableHead className="w-[70px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.extracted.map((c) => {
              const check = findCheck(c);
              const status = rowStatus(c, check, result.providerError);
              const match = check?.matches?.[0];
              return (
                <TableRow key={`${c.citation}-${c.index}`}>
                  <TableCell className="align-top">
                    <div className="font-mono text-[12px]">{c.citation}</div>
                    <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{c.context}</div>
                  </TableCell>
                  <TableCell className="align-top capitalize text-xs">{c.kind === "register" ? "Fed. Reg." : c.kind}</TableCell>
                  <TableCell className="align-top">
                    {status === "resolved" && <Badge variant="success"><Check className="size-3" /> Resolved</Badge>}
                    {status === "unresolved" && <Badge variant="destructive"><AlertTriangle className="size-3" /> Not found</Badge>}
                    {status === "unchecked" && <Badge variant="warning"><HelpCircle className="size-3" /> Unchecked</Badge>}
                    {status === "structural" && <Badge variant="info"><ShieldCheck className="size-3" /> Form OK</Badge>}
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    {match ? (
                      <div>
                        <div className="font-medium">{match.case_name}</div>
                        <div className="text-[11px] text-muted-foreground">{match.date_filed}{(check?.matches?.length ?? 0) > 1 ? ` · +${check!.matches!.length - 1} more` : ""}</div>
                      </div>
                    ) : status === "unresolved" ? (
                      <span className="text-[11px] text-destructive">{check?.error ?? "No opinion matches this reporter/volume/page — check for a typo or a WL/LEXIS-only cite."}</span>
                    ) : status === "structural" ? (
                      <span className="text-[11px] text-muted-foreground">Statutes, regulations and Federal Register cites are checked for form only; open the source to confirm the text.</span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">CourtListener lookup did not run.</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    {(match?.url ?? c.lookupUrl) && <Button asChild variant="ghost" size="xs"><a href={match?.url ?? c.lookupUrl} target="_blank" rel="noreferrer"><ExternalLink className="size-3" /> Open</a></Button>}
                  </TableCell>
                </TableRow>
              );
            })}
            {result.extracted.length === 0 && <TableRow><TableCell colSpan={5} className="py-6 text-center text-xs text-muted-foreground">No citations were found in the text.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

const SAMPLE = `The pleading standard requires factual allegations that raise a right to relief above the speculative level. Bell Atl. Corp. v. Twombly, 550 U.S. 544, 555 (2007); Ashcroft v. Iqbal, 556 U.S. 662, 678 (2009). A manufacturer's duty to report substantial-risk information arises under 15 U.S.C. § 2607(e); see also 68 Fed. Reg. 33129 (June 3, 2003). The government contractor defense is governed by Boyle v. United Technologies Corp., 487 U.S. 500, 512 (1988), and removal by 28 U.S.C. § 1442(a)(1). See Sawyer v. Foster Wheeler LLC, 860 F.3d 249, 255 (4th Cir. 2017). The benzene drinking-water MCL appears at 40 C.F.R. § 141.61(a). But see Doe v. Acme Chemical Corp., 999 F.3d 1234 (4th Cir. 2021).`;

export function CiteChecker({ initialText, matterId }: { initialText?: string; matterId?: string | null }) {
  const router = useRouter();
  const [text, setText] = React.useState(initialText ?? "");
  const [result, setResult] = React.useState<CiteCheckResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);

  const check = async () => {
    if (!text.trim()) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const r = await runCiteCheck(text, ctrl.signal);
      setResult(r);
      if (r.providerError) toast.warning("Citations extracted; CourtListener verification unavailable", { description: r.providerError });
      else if (r.summary.unresolved) toast.error(`${r.summary.unresolved} citation${r.summary.unresolved === 1 ? "" : "s"} did not resolve`);
      else toast.success(`${r.summary.resolved} of ${r.summary.total} citations resolved`);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Citation check failed", { description: e instanceof Error ? e.message : String(e) });
    } finally { setLoading(false); }
  };

  const sendToWord = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      const summary = result ? `\n\n---\n\n**Citation check (${new Date().toLocaleDateString()}):** ${result.summary.resolved} resolved, ${result.summary.unresolved} unresolved${result.providerError ? ` — CourtListener unavailable (${result.providerError})` : ""}.\n\n${result.extracted.map((c) => { const k = result.checks.find((x) => norm(x.citation) === norm(c.citation)); return `- ${c.citation} — ${c.kind !== "case" ? "form checked" : !k ? "unchecked" : k.resolved ? `resolved: ${k.matches?.[0]?.case_name ?? ""}` : "NOT FOUND [VERIFY]"}`; }).join("\n")}` : "";
      const content = markdownToDoc(`${text}${summary}`, { title: "Citation review" });
      const res = await fetch("/api/office/docs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "word", title: `Citation review — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, content, matterId: matterId ?? undefined, tags: ["citation review"], meta: { source: "search-citecheck" } }) });
      const j = (await res.json()) as { doc?: { id: string }; error?: string };
      if (!res.ok || !j.doc) throw new Error(j.error ?? res.statusText);
      toast.success("Opened in Word for review");
      router.push(`/office/word/${j.doc.id}?mode=review`);
    } catch (e) {
      toast.error("Could not create the Word document", { description: e instanceof Error ? e.message : String(e) });
    } finally { setSending(false); }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 overflow-y-auto p-6 scrollbar-thin">
      <div>
        <div className="flex items-center gap-2"><ShieldCheck className="size-4 text-muted-foreground" /><h1 className="text-[17px] font-semibold tracking-tight">Citation checker</h1></div>
        <p className="mt-1 text-sm text-muted-foreground">Paste a brief, memo or draft. Every case citation is resolved against CourtListener; statutes, regulations and Federal Register cites are checked for form and linked to the official source. Unresolved cites are the first place to look for hallucinated or mistyped authority.</p>
      </div>
      <div className="rounded-md border bg-card p-3">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste text containing citations, e.g. 550 U.S. 544, 860 F.3d 249, 15 U.S.C. § 2607(e), 40 C.F.R. § 141.61…" className="min-h-[180px] font-serif text-[13.5px] leading-relaxed" spellCheck={false} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button onClick={check} disabled={loading || !text.trim()}>{loading ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />} Check citations</Button>
          <Button variant="outline" onClick={sendToWord} disabled={sending || !text.trim()}>{sending ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />} Send to Word review</Button>
          <Button variant="ghost" onClick={() => setText(SAMPLE)}><ClipboardPaste className="size-4" /> Load sample</Button>
          <div className="flex-1" />
          <span className="tabular text-[11px] text-muted-foreground">{text.length.toLocaleString()} chars</span>
        </div>
      </div>
      {result ? <CiteCheckTable result={result} /> : (
        <EmptyState icon={ShieldCheck} title="No check run yet" description="Paste text and press Check citations. Results show resolved case names, unresolved cites, and official links for statutory and regulatory cites." />
      )}
    </div>
  );
}
