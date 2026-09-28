"use client";
import * as React from "react";
import { useT } from "@/lib/i18n/client";
import { FileText, FileUp, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { addFiles, describeFiles, formatAccept, formatFileSize, type DroppedFile } from "./form-helpers";

export type { DroppedFile } from "./form-helpers";

export interface FileDropProps {
  files: DroppedFile[];
  onChange: (files: DroppedFile[], rejected: { name: string; reason: string }[]) => void;
  accept?: string[] | string;
  multiple?: boolean;
  maxFiles?: number;
  /** Bytes. */
  maxSize?: number;
  disabled?: boolean;
  label?: React.ReactNode;
  help?: React.ReactNode;
  className?: string;
  compact?: boolean;
  id?: string;
}

let counter = 0;
function toDropped(f: File): DroppedFile {
  return { id: `f_${Date.now().toString(36)}_${(counter++).toString(36)}`, name: f.name, size: f.size, type: f.type, file: f };
}

/**
 * Multi-file drop zone with an accept list, size display and per-file remove.
 * The parent owns the list so a form can validate and submit it.
 */
export function FileDrop(p: FileDropProps) {
  const t = useT();
  const [over, setOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const multiple = p.multiple ?? true;
  const acceptText = formatAccept(p.accept);
  const take = (list: FileList | File[] | null) => {
    if (!list || p.disabled) return;
    const incoming = Array.from(list).map(toDropped);
    const r = addFiles(p.files, incoming, { accept: p.accept, maxFiles: p.maxFiles, maxSize: p.maxSize, multiple });
    p.onChange(r.files, r.rejected);
  };
  const remove = (id: string) => p.onChange(p.files.filter((f) => f.id !== id), []);
  return (
    <div className={cn("min-w-0", p.className)}>
      <div
        role="button"
        tabIndex={p.disabled ? -1 : 0}
        aria-disabled={p.disabled}
        onClick={() => !p.disabled && inputRef.current?.click()}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !p.disabled) { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); if (!p.disabled) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
        className={cn("flex cursor-pointer items-center gap-3 rounded-md border border-dashed px-3 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50", p.compact ? "h-9" : "min-h-16 py-3", over ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30 hover:bg-accent/30", p.disabled && "cursor-not-allowed opacity-50")}
      >
        <FileUp className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[12.5px] font-medium">{p.label ?? (multiple ? t("ui.dropFiles") : t("ui.dropFile"))}</div>
          <div className="text-[11px] text-muted-foreground">{p.help ?? [acceptText ? `Accepts ${acceptText}` : null, p.maxSize ? `up to ${formatFileSize(p.maxSize)} each` : null, p.maxFiles ? `max ${p.maxFiles}` : null].filter(Boolean).join(" · ")}</div>
        </div>
        <input ref={inputRef} id={p.id} type="file" className="hidden" multiple={multiple} accept={Array.isArray(p.accept) ? p.accept.join(",") : p.accept} disabled={p.disabled} onChange={(e) => { take(e.target.files); e.target.value = ""; }} />
      </div>
      {p.files.length > 0 && (
        <ul className="mt-1.5 divide-y divide-line-quiet rounded-md border" aria-label={t("ui.selectedFiles")}>
          {p.files.map((f) => (
            <li key={f.id} className="flex h-7 items-center gap-2 px-2 text-[12px]">
              <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate" title={f.name}>{f.name}</span>
              <span className="shrink-0 tabular text-[11px] text-muted-foreground">{formatFileSize(f.size)}</span>
              {!p.disabled && <Button variant="ghost" size="icon-xs" className="size-5" onClick={(e) => { e.stopPropagation(); remove(f.id); }} aria-label={`Remove ${f.name}`}><X className="size-3" /></Button>}
            </li>
          ))}
          <li className="flex h-6 items-center px-2 text-[11px] text-muted-foreground">{describeFiles(p.files)}</li>
        </ul>
      )}
    </div>
  );
}
