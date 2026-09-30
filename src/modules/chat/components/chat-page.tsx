"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowUp, Check, ChevronDown, Code2, Copy, Download, FileText, Globe, History, ImageIcon, Loader2, Mic, MicOff, MonitorPlay, Paperclip, Plus,
  RotateCcw, Square, Telescope, ThumbsDown, ThumbsUp, Trash2, X,
} from "lucide-react";
import { Markdown } from "@/components/ai/markdown";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { readSSE } from "@/lib/ai/sse";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import {
  DEFAULT_TOOL_FLAGS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS,
  type ChatAttachmentInput, type ChatEvent, type ChatFile, type ChatKnowledge, type ChatMessage, type ChatSource, type ChatThreadSummary, type ChatToolFlags,
} from "../types";
import { KnowledgeMenu, useStoredKnowledge } from "./knowledge-menu";
import { speechLang, useDictation } from "./use-dictation";

const SUGGESTIONS: { text: string; icon: typeof Globe; tools?: Partial<ChatToolFlags> }[] = [
  { text: "What did the Supreme Court decide this week?", icon: Globe },
  { text: "Compute interest at 9% simple on ₹24,00,000 from 1 March 2022 to today", icon: Code2, tools: { code: true } },
  { text: "Summarise the latest RBI circulars on digital lending", icon: Globe },
  { text: "Draft a short client note explaining an adjournment of the hearing", icon: FileText },
];

interface Draft {
  text: string;
  steps: { id: string; label: string; state: "running" | "done" | "failed" }[];
  sources: ChatSource[];
  files: ChatFile[];
  tier?: "fast" | "standard";
}

const emptyDraft = (): Draft => ({ text: "", steps: [], sources: [], files: [] });

function host(url: string) { try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; } }

async function toAttachment(file: File): Promise<ChatAttachmentInput> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const mime = file.type || (file.name.endsWith(".md") ? "text/markdown" : file.name.endsWith(".csv") ? "text/csv" : "text/plain");
  return { name: file.name, mime, size: file.size, data: btoa(bin) };
}

export function ChatPage({ initialThreadId, threads: initialThreads, configured, signedIn }: { initialThreadId?: string; threads: ChatThreadSummary[]; configured: boolean; signedIn: boolean }) {
  const router = useRouter();
  const [threadId, setThreadId] = React.useState<string | undefined>(initialThreadId);
  /** The open thread, readable from effects without re-running them. */
  const threadIdRef = React.useRef(threadId);
  threadIdRef.current = threadId;
  const [threads, setThreads] = React.useState(initialThreads);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const messagesRef = React.useRef(messages);
  messagesRef.current = messages;
  const [loadingThread, setLoadingThread] = React.useState(Boolean(initialThreadId));
  const [input, setInput] = React.useState("");
  const [flags, setFlags] = React.useState<ChatToolFlags>(DEFAULT_TOOL_FLAGS);
  const [knowledge, setKnowledge] = useStoredKnowledge();
  const [attachments, setAttachments] = React.useState<ChatAttachmentInput[]>([]);
  const [streaming, setStreaming] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stickRef = React.useRef(true);

  const loadThread = React.useCallback(async (id: string) => {
    setLoadingThread(true);
    try {
      const res = await fetch(`/api/chat/threads/${encodeURIComponent(id)}`);
      if (!res.ok) { toast.error("That chat could not be opened"); setThreadId(undefined); setMessages([]); return; }
      const { thread } = (await res.json()) as { thread: { messages: ChatMessage[] } };
      setMessages(thread.messages);
      stickRef.current = true;
    } finally {
      setLoadingThread(false);
    }
  }, []);

  // Load a thread named by the URL (first visit, back/forward). A thread this page already has open — e.g. the one a
  // streaming answer just created — is not reloaded, so the in-flight answer is never replaced by the saved copy.
  const loadedRef = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (!initialThreadId || loadedRef.current === initialThreadId) return;
    loadedRef.current = initialThreadId;
    setThreadId(initialThreadId);
    void loadThread(initialThreadId);
  }, [initialThreadId, loadThread]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, draft]);

  const refreshThreads = React.useCallback(async () => {
    try { const res = await fetch("/api/chat/threads"); if (res.ok) setThreads(((await res.json()) as { threads: ChatThreadSummary[] }).threads); } catch { /* keep the list */ }
  }, []);

  const newChat = () => {
    abortRef.current?.abort();
    setThreadId(undefined); setMessages([]); setDraft(null); setInput(""); setAttachments([]);
    loadedRef.current = undefined;
    router.replace("/chat");
  };

  const openThread = (id: string) => {
    abortRef.current?.abort();
    setThreadId(id); setDraft(null);
    loadedRef.current = id;
    router.replace(`/chat?t=${encodeURIComponent(id)}`);
    void loadThread(id);
  };

  const send = async (text: string, o: { regenerate?: boolean; tools?: Partial<ChatToolFlags> } = {}) => {
    const message = text.trim();
    if ((!message && !o.regenerate) || streaming) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStreaming(true);
    stickRef.current = true;
    const sentAttachments = o.regenerate ? [] : attachments;
    if (o.regenerate) setMessages((m) => { const i = m.map((x) => x.role).lastIndexOf("assistant"); return i >= 0 && i === m.length - 1 ? m.slice(0, i) : m; });
    else {
      setMessages((m) => [...m, { id: `local_${Date.now()}`, role: "user", text: message, createdAt: new Date().toISOString(), attachments: sentAttachments.map(({ name, mime, size }) => ({ name, mime, size })) }]);
      setInput(""); setAttachments([]);
    }
    const d = emptyDraft();
    setDraft({ ...d });
    let finished: ChatMessage | null = null;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Web search follows the knowledge switch (the Search chip and the Sources menu share it).
        body: JSON.stringify({ threadId, message, tools: { ...flags, ...(o.tools ?? {}), search: knowledge.web }, knowledge, attachments: sentAttachments, regenerate: o.regenerate }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Chat failed (${res.status})`);
      }
      await readSSE<ChatEvent>(res, (ev) => {
        if (ev.type === "thread") {
          if (ev.threadId !== threadId) {
            // Record the new thread in the URL without a server round trip (a navigation would re-render the page mid-answer).
            setThreadId(ev.threadId);
            loadedRef.current = ev.threadId;
            window.history.replaceState(null, "", `/chat?t=${encodeURIComponent(ev.threadId)}`);
          }
        } else if (ev.type === "route") d.tier = ev.tier;
        else if (ev.type === "delta") d.text += ev.text;
        else if (ev.type === "step") {
          const at = d.steps.findIndex((s) => s.id === ev.id);
          if (at >= 0) d.steps[at] = { id: ev.id, label: ev.label, state: ev.state }; else d.steps.push({ id: ev.id, label: ev.label, state: ev.state });
        } else if (ev.type === "source") d.sources.push(ev.source);
        else if (ev.type === "file") d.files.push(ev.file);
        else if (ev.type === "done") finished = ev.message;
        else if (ev.type === "error") throw new Error(ev.message);
        setDraft({ ...d, steps: [...d.steps], sources: [...d.sources], files: [...d.files] });
      }, ctrl.signal);
      if (!finished) throw new Error("The answer was interrupted before it finished.");
    } catch (e) {
      const stopped = ctrl.signal.aborted;
      finished = {
        id: `local_${Date.now()}`, role: "assistant", text: d.text, createdAt: new Date().toISOString(),
        sources: d.sources.length ? d.sources : undefined, files: d.files.length ? d.files : undefined, steps: d.steps.map((s) => s.label),
        status: stopped ? "stopped" : "error", error: stopped ? undefined : (e as Error).message,
      };
    } finally {
      if (finished) { const m = finished; setMessages((prev) => [...prev, m]); }
      setDraft(null);
      setStreaming(false);
      abortRef.current = null;
      void refreshThreads();
    }
  };

  const stop = () => abortRef.current?.abort();

  const onFiles = async (list: FileList | null) => {
    if (!list) return;
    const next = [...attachments];
    for (const f of Array.from(list)) {
      if (next.length >= MAX_ATTACHMENTS) { toast.error(`Up to ${MAX_ATTACHMENTS} files per message`); break; }
      if (f.size > MAX_ATTACHMENT_BYTES) { toast.error(`${f.name} is larger than 3 MB`); continue; }
      next.push(await toAttachment(f));
    }
    setAttachments(next);
  };

  const feedback = async (m: ChatMessage, value: "up" | "down") => {
    if (!threadId || m.id.startsWith("local_")) return;
    const next = m.feedback === value ? null : value;
    setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, feedback: next ?? undefined } : x)));
    await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageId: m.id, feedback: next }) }).catch(() => {});
  };

  const removeThread = async (id: string) => {
    const res = await fetch(`/api/chat/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) { toast.error("Could not delete the chat"); return; }
    setThreads((t) => t.filter((x) => x.id !== id));
    if (id === threadId) newChat();
  };

  const empty = messages.length === 0 && !draft && !loadingThread;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  const composer = (
    <Composer
      value={input}
      onChange={setInput}
      onSend={() => void send(input)}
      onStop={stop}
      streaming={streaming}
      disabled={!configured || !signedIn}
      flags={flags}
      onFlags={setFlags}
      knowledge={knowledge}
      onKnowledge={setKnowledge}
      attachments={attachments}
      onRemoveAttachment={(i) => setAttachments((a) => a.filter((_, j) => j !== i))}
      onFiles={onFiles}
      onDeepResearch={() => router.push(`/search${input.trim() ? `?q=${encodeURIComponent(input.trim())}` : ""}`)}
      autoFocus
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center justify-between px-4">
        <HistoryMenu threads={threads} current={threadId} onOpen={openThread} onDelete={removeThread} />
        <button type="button" onClick={newChat} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Plus className="size-4" /> New chat
        </button>
      </header>

      {!configured && (
        <div className="mx-auto mt-2 w-full max-w-[760px] px-4">
          <div className="rounded-lg border bg-surface-quiet px-3 py-2 text-[13px] text-muted-foreground">Chat needs an OpenAI API key. Add <code className="font-mono">OPENAI_API_KEY</code> to the deployment and reload.</div>
        </div>
      )}

      {empty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 pb-16">
          <h1 className="mb-8 text-center text-[28px] font-semibold tracking-tight text-foreground sm:text-[32px]">What can I help with?</h1>
          <div className="w-full max-w-[760px]">{composer}</div>
          <div className="mt-5 flex w-full max-w-[760px] flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((s) => (
              <button key={s.text} type="button" disabled={!configured || streaming} onClick={() => void send(s.text, { tools: s.tools })}
                className="inline-flex max-w-full items-center gap-2 rounded-full border bg-background px-3.5 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <s.icon className="size-3.5 shrink-0" />
                <span className="truncate">{s.text}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" onScroll={(e) => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
            <div className="mx-auto w-full max-w-[760px] space-y-7 px-4 pb-8 pt-4">
              {loadingThread && <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading chat…</div>}
              {messages.map((m) => m.role === "user"
                ? <UserBubble key={m.id} m={m} />
                : <AssistantMessage key={m.id} m={m} onCopy={() => { void navigator.clipboard.writeText(m.text); toast.success("Copied"); }} onFeedback={(v) => void feedback(m, v)} onRegenerate={m === lastAssistant && !streaming ? () => void send("", { regenerate: true }) : undefined} />)}
              {draft && <StreamingMessage d={draft} />}
            </div>
          </div>
          <div className="shrink-0 px-4 pb-3">
            <div className="mx-auto w-full max-w-[760px]">{composer}</div>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">Chat can make mistakes. Check important information, and use Research for cited legal work.</p>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Chip({ on, onClick, icon: Icon, label, title }: { on?: boolean; onClick: () => void; icon: typeof Globe; label: string; title?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} title={title}
      className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] transition-colors sm:px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}>
      <Icon className="size-4" /> <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function Composer(p: {
  value: string; onChange: (v: string) => void; onSend: () => void; onStop: () => void; streaming: boolean; disabled: boolean;
  flags: ChatToolFlags; onFlags: (f: ChatToolFlags) => void; knowledge: ChatKnowledge; onKnowledge: (k: ChatKnowledge) => void; attachments: ChatAttachmentInput[]; onRemoveAttachment: (i: number) => void;
  onFiles: (f: FileList | null) => void; onDeepResearch: () => void; autoFocus?: boolean;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [p.value]);
  const toggle = (k: keyof ChatToolFlags) => p.onFlags({ ...p.flags, [k]: !p.flags[k] });
  const canSend = p.value.trim().length > 0 && !p.disabled;
  const { locale } = useI18n();
  const dictation = useDictation({ value: p.value, onChange: p.onChange, lang: speechLang(locale) });
  const { stop: stopDictation } = dictation;
  const send = () => { stopDictation(); p.onSend(); };
  React.useEffect(() => { if (p.disabled || p.streaming) stopDictation(); }, [p.disabled, p.streaming, stopDictation]);
  return (
    <div className="rounded-[26px] border bg-background px-3 pb-2.5 pt-3 shadow-sm transition-shadow focus-within:shadow-md">
      {p.attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5 px-1">
          {p.attachments.map((a, i) => (
            <span key={`${a.name}-${i}`} className="inline-flex items-center gap-1.5 rounded-lg border bg-surface-quiet px-2 py-1 text-[12px]">
              {a.mime.startsWith("image/") ? <ImageIcon className="size-3.5" /> : <FileText className="size-3.5" />}
              <span className="max-w-[180px] truncate">{a.name}</span>
              <button type="button" aria-label={`Remove ${a.name}`} onClick={() => p.onRemoveAttachment(i)} className="rounded text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={p.value}
        autoFocus={p.autoFocus}
        disabled={p.disabled}
        placeholder={p.disabled ? "Chat is not available" : "Ask anything"}
        aria-label="Message"
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend && !p.streaming) send(); } }}
        className="block max-h-[220px] min-h-[28px] w-full resize-none bg-transparent px-2 text-[15px] leading-6 text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed"
      />
      <div className="mt-2 flex items-center gap-1">
        <input ref={fileRef} type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/csv,text/markdown,.md,.csv,.txt,application/json" onChange={(e) => { p.onFiles(e.target.files); e.target.value = ""; }} />
        <button type="button" aria-label="Attach files" title="Attach files (up to 3 MB each)" onClick={() => fileRef.current?.click()} disabled={p.disabled}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Plus className="size-5" />
        </button>
        {/* Tool chips scroll sideways on narrow screens so the mic and send buttons always stay visible. */}
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {/* Web search is one of the sources (the former Search chip is folded into this menu). */}
        <KnowledgeMenu value={p.knowledge} onChange={p.onKnowledge} disabled={p.disabled} />
        <Chip onClick={p.onDeepResearch} icon={Telescope} label="Deep research" title="Open Research for a sourced, verified legal answer" />
        <Chip on={p.flags.code} onClick={() => toggle("code")} icon={Code2} label="Code" title="Run code: calculations, data, charts, files" />
        <Chip on={p.flags.image} onClick={() => toggle("image")} icon={ImageIcon} label="Image" title="Create images" />
        <Chip on={p.flags.browse} onClick={() => toggle("browse")} icon={MonitorPlay} label="Browse" title="Read specific web pages" />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <MicButton d={dictation} disabled={p.disabled || p.streaming} />
          {p.streaming ? (
            <button type="button" onClick={p.onStop} aria-label="Stop" className="inline-flex size-9 items-center justify-center rounded-full bg-foreground text-background hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button type="button" onClick={send} disabled={!canSend} aria-label="Send" className="inline-flex size-9 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90 disabled:bg-muted-foreground/30 disabled:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MicButton({ d, disabled }: { d: ReturnType<typeof useDictation>; disabled: boolean }) {
  if (d.supported === null) return null;
  if (!d.supported) {
    return (
      <span title="Dictation is not supported in this browser" aria-label="Dictation is not supported in this browser" role="img"
        className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground/40">
        <MicOff className="size-4" />
      </span>
    );
  }
  const label = d.listening ? "Stop dictation" : "Dictate";
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">{d.listening ? "Listening" : d.error ?? ""}</span>
      <button type="button" onClick={d.toggle} disabled={disabled} aria-pressed={d.listening} aria-label={label} title={d.error ?? (d.listening ? "Listening… click to stop" : "Dictate (speech is recognised by your browser)")}
        className={cn("relative inline-flex size-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
          d.listening ? "bg-destructive/10 text-destructive" : d.error ? "text-destructive hover:bg-accent" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
        <Mic className="size-4" />
        {d.listening && <span aria-hidden className="absolute right-1 top-1 size-1.5 animate-pulse rounded-full bg-destructive" />}
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function UserBubble({ m }: { m: ChatMessage }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      {m.attachments?.length ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {m.attachments.map((a, i) => <span key={i} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[12px] text-muted-foreground"><Paperclip className="size-3" />{a.name}</span>)}
        </div>
      ) : null}
      <div className="max-w-[85%] whitespace-pre-wrap rounded-3xl bg-accent px-4 py-2.5 text-[15px] leading-6 text-foreground">{m.text}</div>
    </div>
  );
}

function Sources({ sources }: { sources: ChatSource[] }) {
  if (!sources.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {sources.slice(0, 12).map((s, i) => {
        // In-app sources (a page of the user's documents) open in place and show their title ("Lease.pdf, p. 4").
        const internal = s.url.startsWith("/");
        return (
          <a key={s.url} href={s.url} {...(internal ? {} : { target: "_blank", rel: "noreferrer" })} title={s.title}
            className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full bg-accent/70 px-2.5 py-1 text-[12px] text-foreground hover:bg-accent">
            {internal
              ? <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              : <span aria-hidden className="inline-flex size-4 items-center justify-center rounded-sm bg-background text-[9px] font-semibold uppercase text-muted-foreground">{host(s.url).charAt(0)}</span>}
            <span className="truncate">{internal ? s.title : host(s.url)}</span>
            <span className="text-muted-foreground">{i + 1}</span>
          </a>
        );
      })}
    </div>
  );
}

function Files({ files }: { files: ChatFile[] }) {
  if (!files.length) return null;
  return (
    <div className="space-y-2">
      {files.filter((f) => f.kind === "image").map((f) => (
        // eslint-disable-next-line @next/next/no-img-element -- generated images are served from the workspace blob store
        <a key={f.id} href={f.url} target="_blank" rel="noreferrer" className="block w-fit overflow-hidden rounded-xl border"><img src={f.url} alt={f.name} className="max-h-[420px] max-w-full" /></a>
      ))}
      <div className="flex flex-wrap gap-2">
        {files.filter((f) => f.kind === "file").map((f) => (
          <a key={f.id} href={f.url} download={f.name} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-[13px] hover:bg-accent">
            <FileText className="size-4 text-muted-foreground" />
            <span className="max-w-[260px] truncate">{f.name}</span>
            <span className="text-[11px] text-muted-foreground">{f.size < 1024 ? `${f.size} B` : f.size < 1048576 ? `${Math.round(f.size / 1024)} KB` : `${(f.size / 1048576).toFixed(1)} MB`}</span>
            <Download className="size-3.5 text-muted-foreground" />
          </a>
        ))}
      </div>
    </div>
  );
}

function Steps({ steps, live }: { steps: { label: string; state?: string }[]; live?: boolean }) {
  const [open, setOpen] = React.useState(false);
  if (!steps.length) return null;
  const current = steps[steps.length - 1];
  return (
    <div className="text-[13px] text-muted-foreground">
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 rounded-md py-0.5 hover:text-foreground" aria-expanded={open}>
        {live && current.state === "running" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
        <span className="max-w-[520px] truncate">{live ? current.label : `${steps.length} step${steps.length === 1 ? "" : "s"}`}</span>
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 border-l pl-3">
          {steps.map((s, i) => <li key={i} className={cn(s.state === "failed" && "text-destructive")}>{s.label}</li>)}
        </ul>
      )}
    </div>
  );
}

function StreamingMessage({ d }: { d: Draft }) {
  return (
    <div className="space-y-3">
      <Steps steps={d.steps} live />
      {d.text ? <Markdown className="text-[15px] leading-7">{d.text}</Markdown> : !d.steps.length && <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><span className="size-2 animate-pulse rounded-full bg-muted-foreground" /> Thinking…</div>}
      <Files files={d.files} />
      <Sources sources={d.sources} />
    </div>
  );
}

function AssistantMessage({ m, onCopy, onFeedback, onRegenerate }: { m: ChatMessage; onCopy: () => void; onFeedback: (v: "up" | "down") => void; onRegenerate?: () => void }) {
  return (
    <div className="group space-y-3">
      {m.steps?.length ? <Steps steps={m.steps.map((label) => ({ label }))} /> : null}
      {m.text ? <Markdown className="text-[15px] leading-7">{m.text}</Markdown> : null}
      {m.status === "error" && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">{m.error ?? "Something went wrong."}</div>}
      {m.status === "incomplete" && m.error && <div className="text-[13px] text-muted-foreground">{m.error}</div>}
      {m.status === "stopped" && <div className="text-[13px] text-muted-foreground">Stopped.</div>}
      <Files files={m.files ?? []} />
      <Sources sources={m.sources ?? []} />
      <div className="flex items-center gap-0.5 text-muted-foreground">
        <IconButton label="Copy" onClick={onCopy}><Copy className="size-4" /></IconButton>
        <IconButton label="Good answer" onClick={() => onFeedback("up")} active={m.feedback === "up"}><ThumbsUp className="size-4" /></IconButton>
        <IconButton label="Poor answer" onClick={() => onFeedback("down")} active={m.feedback === "down"}><ThumbsDown className="size-4" /></IconButton>
        {onRegenerate && <IconButton label="Regenerate" onClick={onRegenerate}><RotateCcw className="size-4" /></IconButton>}
        {m.durationMs != null && <span className="ml-2 text-[11px] opacity-0 transition-opacity group-hover:opacity-100">{(m.durationMs / 1000).toFixed(1)}s{m.tier === "fast" ? " · fast" : ""}</span>}
      </div>
    </div>
  );
}

function IconButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} onClick={onClick}
      className={cn("inline-flex size-8 items-center justify-center rounded-md hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active && "text-foreground")}>
      {children}
    </button>
  );
}

function HistoryMenu({ threads, current, onOpen, onDelete }: { threads: ChatThreadSummary[]; current?: string; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <History className="size-4" /> Chats
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1">
        {threads.length === 0 ? <div className="px-3 py-6 text-center text-[13px] text-muted-foreground">No chats yet</div> : (
          <ul className="max-h-[420px] overflow-y-auto scrollbar-thin">
            {threads.map((t) => (
              <li key={t.id} className={cn("group flex items-center rounded-md hover:bg-accent", t.id === current && "bg-accent")}>
                <button type="button" onClick={() => { setOpen(false); onOpen(t.id); }} className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[13px]">{t.title}</button>
                <button type="button" aria-label={`Delete ${t.title}`} onClick={() => onDelete(t.id)} className="mr-1 hidden size-7 items-center justify-center rounded text-muted-foreground hover:text-destructive group-hover:inline-flex"><Trash2 className="size-3.5" /></button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
