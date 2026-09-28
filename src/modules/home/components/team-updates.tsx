"use client";
import * as React from "react";
import { useT } from "@/lib/i18n/client";
import Link from "next/link";
import { CornerDownRight, HelpCircle, Megaphone, MessageSquare, MoreHorizontal, Paperclip, Send, Trophy, Users, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PersonAvatar } from "@/components/ui/avatar";
import { Tip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TeamUpdate } from "@/lib/types/domain";
import { REACTIONS, UPDATE_KINDS, type TeamUpdateView } from "../types";
import { relativeLabel } from "../time";
import { useHomeUI } from "../store";
import { useHome } from "./home-provider";
import { EmptyRow, MatterBadge, NONE, Section } from "./shared";

const KIND: Record<TeamUpdate["kind"], { label: string; icon: LucideIcon; className: string }> = {
  update: { label: "Update", icon: MessageSquare, className: "text-muted-foreground" },
  win: { label: "Win", icon: Trophy, className: "text-success" },
  announcement: { label: "Announcement", icon: Megaphone, className: "text-primary" },
  question: { label: "Question", icon: HelpCircle, className: "text-warning-foreground dark:text-warning" },
};

/** Kind as icon + text (no chip); the only chip on an update is "Unanswered", a decision state. */
function KindBadge({ kind }: { kind: TeamUpdate["kind"] }) {
  const k = KIND[kind];
  const Icon = k.icon;
  return <span className={cn("inline-flex items-center gap-1 text-[10.5px] font-medium", k.className)}><Icon className="size-3" />{k.label}</span>;
}

export function useVisibleUpdates() {
  const { updates, matterFilter } = useHome();
  return React.useMemo(() => (matterFilter ? updates.filter((u) => u.matterId === matterFilter) : updates), [updates, matterFilter]);
}

export function UpdatesOverview() {
  const list = useVisibleUpdates();
  const setFocus = useHomeUI((s) => s.setFocus);
  const t = useT();
  const shown = list.slice(0, 6);
  return (
    <Section id="updates" title={t("home.section.updates")} count={list.length} onExpand={() => setFocus("updates")}>
      <div className="border-b px-1 py-2"><UpdateComposer /></div>
      {shown.length === 0 ? <EmptyRow icon={Users} title={t("home.section.noUpdates")} hint={t("home.updates.emptyHint")} /> : (
        <ul className="divide-y">{shown.map((u, i) => <UpdateCard key={u.id} update={u} index={i} />)}</ul>
      )}
      {list.length > shown.length && <button onClick={() => setFocus("updates")} className="flex w-full items-center justify-center border-t py-2 text-[11.5px] text-muted-foreground hover:text-foreground cursor-pointer">Show all {list.length}</button>}
    </Section>
  );
}

export function UpdatesFocus() {
  const list = useVisibleUpdates();
  const setFocus = useHomeUI((s) => s.setFocus);
  const t = useT();
  return (
    <Section id="updates" title={t("home.section.updates")} icon={Users} count={list.length} expanded onExpand={() => setFocus(null)} bodyClassName="overflow-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl">
        <div className="border-b p-3"><UpdateComposer /></div>
        {list.length === 0 ? <EmptyRow icon={Users} title={t("home.section.noUpdates")} /> : <ul className="divide-y">{list.map((u, i) => <UpdateCard key={u.id} update={u} index={i} full />)}</ul>}
      </div>
    </Section>
  );
}

export function UpdateComposer() {
  const { postUpdate, matters, matterFilter, userName } = useHome();
  const nonce = useHomeUI((s) => s.composerNonce);
  const [body, setBody] = React.useState("");
  const [kind, setKind] = React.useState<TeamUpdate["kind"]>("update");
  const [matterId, setMatterId] = React.useState<string>(matterFilter ?? "");
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => { if (nonce) { ref.current?.focus(); ref.current?.scrollIntoView({ block: "center", behavior: "smooth" }); } }, [nonce]);
  React.useEffect(() => { if (matterFilter) setMatterId(matterFilter); }, [matterFilter]);
  React.useEffect(() => { const ta = ref.current; if (!ta) return; ta.style.height = "auto"; ta.style.height = Math.min(200, Math.max(38, ta.scrollHeight)) + "px"; }, [body]);

  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    const u = await postUpdate({ body: text, kind, matterId: matterId || null });
    setBusy(false);
    if (u) { setBody(""); setKind("update"); toast.success("Posted to the team"); }
  };

  return (
    <div className="rounded-md border bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 transition-shadow">
      <div className="flex items-start gap-2 px-2.5 pt-2.5">
        <PersonAvatar name={userName} size="sm" className="mt-0.5" />
        <textarea ref={ref} value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); } }} placeholder="Share an update, a win or a question with the team…" rows={1} className="block w-full resize-none bg-transparent py-1 text-[13px] outline-none placeholder:text-muted-foreground" aria-label="New team update" />
      </div>
      <div className="flex flex-wrap items-center gap-1 px-2 pb-2 pt-1.5">
        <div className="flex items-center rounded-md border p-0.5">
          {UPDATE_KINDS.map((k) => { const Icon = KIND[k].icon; return (
            <Tip key={k} label={KIND[k].label}><button onClick={() => setKind(k)} className={cn("flex h-6 items-center gap-1 rounded px-1.5 text-[11px] cursor-pointer", kind === k ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground")} aria-pressed={kind === k}><Icon className="size-3" /><span className="hidden sm:inline">{KIND[k].label}</span></button></Tip>
          ); })}
        </div>
        <Select value={matterId || NONE} onValueChange={(v) => setMatterId(v === NONE ? "" : v)}>
          <SelectTrigger size="xs" className="w-auto min-w-[120px] max-w-[180px] text-[11px]"><SelectValue placeholder="Matter" /></SelectTrigger>
          <SelectContent><SelectItem value={NONE}>Firm-wide</SelectItem>{matters.map((m) => <SelectItem key={m.id} value={m.id}>{m.shortName}</SelectItem>)}</SelectContent>
        </Select>
        <div className="flex-1" />
        <span className="hidden text-[10.5px] text-muted-foreground sm:inline"><kbd>⌘</kbd> <kbd>↵</kbd></span>
        <Button size="xs" onClick={() => void submit()} disabled={!body.trim() || busy}><Send className="size-3" /> Post</Button>
      </div>
    </div>
  );
}

function UpdateCard({ update: u, index, full }: { update: TeamUpdateView; index: number; full?: boolean }) {
  const { now, personById, react, reply, deleteUpdate, userId } = useHome();
  const author = personById(u.authorId);
  const [replying, setReplying] = React.useState(false);
  const [replyText, setReplyText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const recent = now.getTime() - new Date(u.createdAt).getTime() < 60_000;

  const sendReply = async () => {
    const t = replyText.trim();
    if (!t || busy) return;
    setBusy(true);
    const r = await reply(u.id, t);
    setBusy(false);
    if (r) { setReplyText(""); setReplying(false); }
  };

  return (
    <li className={cn("px-3 py-2", recent && "bg-primary/5")} data-index={index}>
      <div className="flex gap-2.5">
        <PersonAvatar name={author?.name ?? "Unknown"} size="sm" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="text-[12.5px] font-semibold text-foreground">{author?.name ?? "Unknown"}</span>
            {author?.title && <span className="hidden sm:inline">{author.title}</span>}
            <KindBadge kind={u.kind} />
            <MatterBadge matterId={u.matterId} link />
            <span>·</span>
            <time dateTime={u.createdAt} title={new Date(u.createdAt).toLocaleString()}>{relativeLabel(u.createdAt, now)}</time>
            {u.authorId === userId && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" className="ml-auto size-5" aria-label="Update actions"><MoreHorizontal className="size-3" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end"><DropdownMenuItem destructive onClick={async () => { if (await deleteUpdate(u.id)) toast.success("Update deleted"); }}>Delete</DropdownMenuItem></DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <p className={cn("mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90", !full && "line-clamp-4")}>{u.body}</p>
          {u.attachments?.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">{u.attachments.map((a, i) => <Link key={i} href={a.href} className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-[11px] hover:bg-accent"><Paperclip className="size-3" />{a.label}</Link>)}</div>
          ) : null}
          <div className="mt-1.5 flex items-center gap-1">
            {REACTIONS.map((emoji) => {
              const count = u.reactions?.[emoji] ?? 0;
              const mine = u.myReactions.includes(emoji);
              return (
                <button key={emoji} onClick={() => void react(u.id, emoji)} className={cn("inline-flex h-6 items-center gap-1 rounded-full border px-1.5 text-[11px] tabular transition-colors cursor-pointer", mine ? "border-transparent bg-accent text-foreground" : count ? "bg-background hover:bg-accent" : "border-transparent text-muted-foreground opacity-60 hover:opacity-100 hover:bg-accent")} aria-pressed={mine} aria-label={`React ${emoji}`}>
                  <span>{emoji}</span>{count > 0 && <span>{count}</span>}
                </button>
              );
            })}
            <button onClick={() => setReplying((v) => !v)} className="ml-1 inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"><CornerDownRight className="size-3" /> Reply{u.replies.length > 0 && <span className="tabular">· {u.replies.length}</span>}</button>
          </div>
          {u.replies.length > 0 && (
            <ul className="mt-2 space-y-2 border-l-2 border-border pl-3">
              {u.replies.map((r) => { const p = personById(r.authorId); return (
                <li key={r.id} className="flex gap-2">
                  <PersonAvatar name={p?.name ?? "Unknown"} size="xs" className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] text-muted-foreground"><span className="font-medium text-foreground">{p?.name ?? "Unknown"}</span> · {relativeLabel(r.createdAt, now)}</div>
                    <p className="text-[12.5px] leading-relaxed text-foreground/90">{r.body}</p>
                  </div>
                </li>
              ); })}
            </ul>
          )}
          {replying && (
            <div className="mt-2 flex items-start gap-2 border-l-2 border-primary/40 pl-3">
              <textarea autoFocus value={replyText} onChange={(e) => setReplyText(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void sendReply(); } if (e.key === "Escape") setReplying(false); }} rows={2} placeholder={`Reply to ${author?.name?.split(" ")[0] ?? "this update"}…`} className="min-h-[38px] flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-[12.5px] outline-none focus:border-ring focus:ring-2 focus:ring-ring/30" />
              <Button size="xs" onClick={() => void sendReply()} disabled={!replyText.trim() || busy}>Reply</Button>
            </div>
          )}
          {u.kind === "question" && !u.replies.length && !replying && <Badge variant="warning" size="sm" className="mt-1.5">Unanswered</Badge>}
        </div>
      </div>
    </li>
  );
}
