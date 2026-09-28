"use client";
import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";
import { Kbd } from "./misc";
import { GLOBAL_SHORTCUTS, detectPlatform, formatKeys, isTypingTarget, mergeShortcutGroups, type ShortcutGroup } from "./shortcut-help-helpers";
import { useT } from "@/lib/i18n/client";

export type { ShortcutGroup, ShortcutItem } from "./shortcut-help-helpers";

interface ShortcutHelpContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
  register: (id: string, groups: ShortcutGroup[]) => () => void;
}

const ShortcutHelpContext = React.createContext<ShortcutHelpContextValue | null>(null);

/**
 * Mounted once in the shell. Pages add their own groups with
 * `useShortcutHelp(groups)`; `?` opens the dialog anywhere outside a text
 * field. Dialogs stack fine: the key is ignored while another dialog is open.
 */
export function ShortcutHelpProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [pages, setPages] = React.useState<Record<string, ShortcutGroup[]>>({});
  const register = React.useCallback((id: string, groups: ShortcutGroup[]) => {
    setPages((p) => ({ ...p, [id]: groups }));
    return () => setPages((p) => { const next = { ...p }; delete next[id]; return next; });
  }, []);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target as HTMLElement | null)) return;
      if (!open && document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const value = React.useMemo(() => ({ open, setOpen, register }), [open, register]);
  const groups = React.useMemo(() => mergeShortcutGroups(GLOBAL_SHORTCUTS, Object.values(pages).flat()), [pages]);
  return (
    <ShortcutHelpContext.Provider value={value}>
      {children}
      <ShortcutHelpDialog open={open} onOpenChange={setOpen} groups={groups} />
    </ShortcutHelpContext.Provider>
  );
}

/** Register page shortcuts for the `?` dialog while the component is mounted. */
export function useShortcutHelp(groups: ShortcutGroup[] | undefined, id?: string) {
  const ctx = React.useContext(ShortcutHelpContext);
  const auto = React.useId();
  const key = id ?? auto;
  const json = JSON.stringify(groups ?? []);
  React.useEffect(() => {
    if (!ctx || !groups?.length) return;
    return ctx.register(key, JSON.parse(json) as ShortcutGroup[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key, json]);
  return { open: () => ctx?.setOpen(true), close: () => ctx?.setOpen(false) };
}

export function ShortcutHelpDialog({ open, onOpenChange, groups }: { open: boolean; onOpenChange: (v: boolean) => void; groups: ShortcutGroup[] }) {
  const platform = React.useMemo(() => detectPlatform(typeof navigator !== "undefined" ? navigator.userAgent : undefined), []);
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="gap-3 p-4">
        <DialogHeader>
          <DialogTitle className="text-[14px]">{t("shortcuts.title")}</DialogTitle>
          <DialogDescription className="text-[11.5px]">{t("shortcuts.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {groups.map((g) => (
            <section key={g.id} className="min-w-0">
              <h3 className="mb-1 text-[12px] font-medium text-muted-foreground">{g.titleKey ? t(g.titleKey) : g.title}</h3>
              <dl className="divide-y divide-line-quiet">
                {g.items.map((it, i) => (
                  <div key={i} className="flex h-7 items-center gap-3">
                    <dt className="min-w-0 flex-1 truncate text-[12px]">{it.labelKey ? t(it.labelKey) : it.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1" dir="ltr">{formatKeys(it.keys, platform).map((k, j) => <Kbd key={j} className="whitespace-nowrap">{k}</Kbd>)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
