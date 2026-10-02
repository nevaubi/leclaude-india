"use client";
import * as React from "react";
import { Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { computeAdValoremFee } from "@/lib/india/court-fees";
import { buildFeeTable, feeToText, parseRupees, parseSlabTable } from "../lib";
import { Caveats, Field, Placeholder, ResultCard, ToolHeader } from "./shared";

const ROWS_HELP = "One slab per line: upper bound | rate % | fixed ₹. Use “above” for the open last slab. JSON with fractional rates is accepted too.";

function optionalRupees(v: string): { value?: number; error?: string } {
  if (!v.trim()) return {};
  const n = parseRupees(v);
  return n === null ? { error: "Enter an amount in rupees." } : { value: n };
}

export function FeePanel() {
  const [amount, setAmount] = React.useState("");
  const [slabs, setSlabs] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [act, setAct] = React.useState("");
  const [article, setArticle] = React.useState("");
  const [effective, setEffective] = React.useState("");
  const [min, setMin] = React.useState("");
  const [max, setMax] = React.useState("");
  const [source, setSource] = React.useState("");
  const [verified, setVerified] = React.useState(false);

  const amt = amount.trim() ? parseRupees(amount) : null;
  const minR = optionalRupees(min), maxR = optionalRupees(max);
  const parsed = React.useMemo(() => (slabs.trim() ? parseSlabTable(slabs) : null), [slabs]);
  const built = parsed ? buildFeeTable(parsed, { label, act, article, source, effectiveFrom: effective, minimum: minR.value, maximum: maxR.value, verified }) : null;
  const inputErrors = [...(minR.error ? [`Minimum: ${minR.error}`] : []), ...(maxR.error ? [`Maximum: ${maxR.error}`] : [])];
  const table = built && !inputErrors.length ? built.table : null;
  const result = amt !== null ? computeAdValoremFee(amt, table) : null;

  return (
    <div>
      <ToolHeader title="Court fee" description="Ad valorem court fee from a slab table you supply. Court-fee schedules differ by State and have been amended repeatedly, so no fee table is shipped and no amount is ever assumed." />
      <div role="note" className="mb-4 flex max-w-[72ch] gap-2 rounded-md border bg-muted/40 px-3 py-2 text-[12px] leading-snug">
        <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span>No verified fee table is loaded. Enter the slabs from your State&apos;s Court Fees Act schedule as currently amended. The result stays “requires verification” unless you tick that you checked the table against a named source.</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Field id="fee-amount" label="Amount or valuation (₹)" error={amount.trim() && amt === null ? "Enter a non-negative amount in rupees, e.g. 5,00,000." : null}>
          <Input id="fee-amount" size="sm" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="5,00,000" className="tabular sm:w-[220px]" aria-invalid={!!amount.trim() && amt === null} />
        </Field>
        <Field id="fee-label" label="Court or State" hint="A label for the table, e.g. Karnataka, plaints.">
          <Input id="fee-label" size="sm" value={label} onChange={(e) => setLabel(e.target.value)} className="sm:w-[320px]" />
        </Field>
        <Field id="fee-slabs" label="Slab table" hint={ROWS_HELP} className="lg:col-span-2">
          <Textarea id="fee-slabs" value={slabs} onChange={(e) => setSlabs(e.target.value)} rows={5} spellCheck={false} placeholder={"upTo | rate % | fixed ₹"} className="max-w-[560px] font-mono text-[12.5px]" aria-describedby="fee-slabs-hint" aria-invalid={!!built?.errors.length} />
        </Field>
        <Field id="fee-act" label="Act">
          <Input id="fee-act" size="sm" value={act} onChange={(e) => setAct(e.target.value)} placeholder="Court Fees Act of your State" />
        </Field>
        <Field id="fee-article" label="Schedule and article">
          <Input id="fee-article" size="sm" value={article} onChange={(e) => setArticle(e.target.value)} placeholder="Schedule I, Article 1" />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field id="fee-min" label="Minimum ₹" error={minR.error}><Input id="fee-min" size="sm" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} className="tabular" /></Field>
          <Field id="fee-max" label="Maximum ₹" error={maxR.error}><Input id="fee-max" size="sm" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} className="tabular" /></Field>
          <Field id="fee-eff" label="Effective from"><Input id="fee-eff" size="sm" type="date" value={effective} onChange={(e) => setEffective(e.target.value)} className="tabular dark:[color-scheme:dark]" /></Field>
        </div>
        <Field id="fee-source" label="Source checked" hint="Gazette notification or amending Act and the schedule you took the slabs from.">
          <Input id="fee-source" size="sm" value={source} onChange={(e) => setSource(e.target.value)} />
        </Field>
        <div className="flex items-start gap-2 lg:col-span-2">
          <Checkbox id="fee-verified" size="sm" className="mt-0.5" checked={verified} onCheckedChange={(v) => setVerified(v === true)} />
          <Label htmlFor="fee-verified" className="text-[12px] font-normal leading-snug">I have checked these slabs against the current Gazette text named above.</Label>
        </div>
      </div>

      <div className="mt-5">
        {!result ? (
          <Placeholder>Enter the amount or valuation and the slab table to compute the fee.</Placeholder>
        ) : built?.errors.length || inputErrors.length ? (
          <ResultCard title="Court fee" status="invalid_input" copyText={null}>
            <ul className="list-disc space-y-0.5 pl-5 text-[12.5px] text-destructive">{[...inputErrors, ...(built?.errors ?? [])].map((e, i) => <li key={i}>{e}</li>)}</ul>
          </ResultCard>
        ) : (
          <ResultCard title={table && (act.trim() || article.trim()) ? [act.trim(), article.trim()].filter(Boolean).join(", ") : "Court fee"} status={result.status} copyText={table && amt !== null ? feeToText(amt, table, result) : null}>
            {result.fee !== undefined ? (
              <div>
                <div className="text-[11.5px] text-muted-foreground">Fee</div>
                <div className="mt-0.5 text-[20px] font-semibold tabular">₹{result.fee.toLocaleString("en-IN")}</div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground">on ₹{amt!.toLocaleString("en-IN")} · {table?.verified ? <>verified by you against {table.source}</> : "table not verified"}</div>
              </div>
            ) : (
              <p className="text-[12.5px]">No amount: enter a slab table to compute a fee.</p>
            )}
            {result.steps.length ? (
              <ol className="mt-4 divide-y rounded-md border text-[12.5px]">
                {result.steps.map((s, i) => <li key={i} className="px-3 py-1.5 tabular">{i + 1}. {s}</li>)}
              </ol>
            ) : null}
            <Caveats uncertain={result.status === "requires_verification" && result.fee !== undefined ? ["The slab table has not been verified against the current Gazette text."] : []} notes={result.notes} />
          </ResultCard>
        )}
      </div>
    </div>
  );
}
