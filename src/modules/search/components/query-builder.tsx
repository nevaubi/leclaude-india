"use client";
import * as React from "react";
import { PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildQuery, parseQuery, toCourtListenerSyntax } from "../query-builder";

/** Structured boolean/proximity builder (CourtListener syntax) seeded from the current query. */
export function QueryBuilder({ query, onApply }: { query: string; onApply: (q: string) => void }) {
  const seed = React.useMemo(() => parseQuery(query), [query]);
  const [all, setAll] = React.useState(seed.all?.join(" ") ?? "");
  const [any, setAny] = React.useState(seed.any?.join(", ") ?? "");
  const [none, setNone] = React.useState(seed.none?.join(", ") ?? "");
  const [phrase, setPhrase] = React.useState(seed.phrases?.join(", ") ?? "");
  const [proxA, setProxA] = React.useState(seed.proximity?.[0]?.a ?? "");
  const [proxB, setProxB] = React.useState(seed.proximity?.[0]?.b ?? "");
  const [proxN, setProxN] = React.useState(String(seed.proximity?.[0]?.within ?? 15));
  const [caseName, setCaseName] = React.useState("");
  const [judge, setJudge] = React.useState("");

  const split = (s: string) => s.split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean);
  const built = buildQuery({
    all: all.trim() ? all.trim().split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/) : [],
    any: split(any),
    none: split(none),
    phrases: split(phrase),
    proximity: proxA.trim() && proxB.trim() ? [{ a: proxA, b: proxB, within: Math.max(1, parseInt(proxN, 10) || 15) }] : [],
    fields: { caseName, judge },
  });
  const normalized = toCourtListenerSyntax(query);

  return (
    <div className="w-[380px] space-y-3 text-xs">
      <div className="flex items-center gap-2"><PenLine className="size-3.5 text-muted-foreground" /><span className="text-[12.5px] font-semibold">Query builder</span><span className="text-[11px] text-muted-foreground">CourtListener syntax</span></div>
      <div className="grid grid-cols-[110px_1fr] items-center gap-x-2 gap-y-2">
        <Label>All of these</Label><Input value={all} onChange={(e) => setAll(e.target.value)} placeholder="effluent warning" className="h-7 text-xs" />
        <Label>Any of these</Label><Input value={any} onChange={(e) => setAny(e.target.value)} placeholder="benzene, toluene, xylene" className="h-7 text-xs" />
        <Label>None of these</Label><Input value={none} onChange={(e) => setNone(e.target.value)} placeholder="asbestos" className="h-7 text-xs" />
        <Label>Exact phrase(s)</Label><Input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder="failure to warn, duty to warn" className="h-7 text-xs" />
        <Label>Proximity</Label>
        <div className="flex items-center gap-1">
          <Input value={proxA} onChange={(e) => setProxA(e.target.value)} placeholder="warn" className="h-7 text-xs" />
          <span className="text-muted-foreground">within</span>
          <Input value={proxN} onChange={(e) => setProxN(e.target.value)} className="h-7 w-14 text-center text-xs tabular" inputMode="numeric" />
          <Input value={proxB} onChange={(e) => setProxB(e.target.value)} placeholder="adequate" className="h-7 text-xs" />
        </div>
        <Label>Case name</Label><Input value={caseName} onChange={(e) => setCaseName(e.target.value)} placeholder="Meridian" className="h-7 text-xs" />
        <Label>Judge</Label><Input value={judge} onChange={(e) => setJudge(e.target.value)} placeholder="Judge surname" className="h-7 text-xs" />
      </div>
      <div className="rounded-md border bg-muted/40 p-2 font-mono text-[11px] break-words min-h-8">{built || <span className="text-muted-foreground">(empty)</span>}</div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => built && onApply(built)} disabled={!built}>Use this query</Button>
        {normalized && normalized !== query.trim() && <Button size="sm" variant="outline" onClick={() => onApply(normalized)}>Normalize current</Button>}
      </div>
      <div className="rounded-md border p-2 text-[11px] text-muted-foreground leading-relaxed">
        <div className="mb-1 font-medium text-foreground">Cheat sheet</div>
        <div><code>AND</code> <code>OR</code> <code>NOT</code> · <code>&quot;exact phrase&quot;</code> · <code>warn*</code> wildcard · <code>&quot;a b&quot;~10</code> within 10 words</div>
        <div>Westlaw habits are converted: <code>/s</code> → <code>~15</code>, <code>/p</code> → <code>~50</code>, <code>/5</code> → <code>~5</code>, <code>&amp;</code> → AND, <code>%</code> → NOT, <code>!</code> → *</div>
        <div>Fields: <code>caseName:(…)</code> <code>judge:(…)</code> <code>docketNumber:…</code> <code>citation:(…)</code></div>
      </div>
    </div>
  );
}
