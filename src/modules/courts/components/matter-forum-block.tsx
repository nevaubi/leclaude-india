"use client";
import * as React from "react";
import Link from "next/link";
import { cityById, forumRecordForCourt, stateName } from "@/lib/india/forums";
import { cityForCourtId, type IndianCaseInfo } from "@/modules/matters/india";
import { LocalLawList, useLocalLaw } from "./local-law-list";

const LINK_LABEL: Record<string, string> = { efiling: "E-filing", causeList: "Cause list", caseStatus: "Case status", judgments: "Judgments" };

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className="text-[11.5px] text-primary underline-offset-2 hover:underline">{children}</a>;
}

/**
 * Compact "Forum & local law" block for a matter: the forum's official links (from the sourced city list) and the
 * State's local-law pointers resolved against the law corpus. The city is the matter's own, else the one the court
 * implies; when neither is known the block says so instead of guessing.
 */
export function MatterForumBlock({ india }: { india: IndianCaseInfo }) {
  const cityId = india.cityId ?? cityForCourtId(india.courtId, india.benchId);
  const city = cityById(cityId);
  const forum = forumRecordForCourt(india.courtId, india.benchId);
  const law = useLocalLaw(city?.id ?? null);
  const links = forum ? [...(forum.website ? [["website", forum.website] as const] : []), ...Object.entries(forum.links ?? {}).filter(([, v]) => !!v) as [string, string][]] : [];
  return (
    <section aria-labelledby="matter-forum">
      <h3 id="matter-forum" className="mb-1 text-[11.5px] font-medium text-muted-foreground">Forum &amp; local law</h3>
      {!city ? (
        <p className="text-[12px] text-muted-foreground">No city recorded. Choose the city in the case particulars to see its forums and local law.</p>
      ) : (
        <div className="space-y-2">
          <div className="text-[12.5px]">
            {forum ? forum.name : "Forum not in the city list"}
            <span className="text-muted-foreground"> · {city.name}, {stateName(city.state)}</span>
          </div>
          {links.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">{links.map(([k, v]) => <Ext key={k} href={v}>{k === "website" ? "Website" : LINK_LABEL[k] ?? k}</Ext>)}</div>
          )}
          <div className="rounded-md border px-2 py-1"><LocalLawList state={law} /></div>
          <Link href={`/courts?city=${encodeURIComponent(city.id)}`} className="w-fit text-[11.5px] text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">All forums in {city.name}</Link>
        </div>
      )}
    </section>
  );
}
