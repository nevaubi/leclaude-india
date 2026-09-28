"use client";
import * as React from "react";
import { T } from "@/lib/i18n/client";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: "left" | "right" | "top" | "bottom"; width?: string }
>(({ className, children, side = "right", width = "max-w-xl", onOpenAutoFocus, ...props }, ref) => {
  const content = React.useRef<HTMLDivElement | null>(null);
  const setRef = React.useCallback((node: HTMLDivElement | null) => {
    content.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
  }, [ref]);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/35 data-[state=open]:animate-fade-in" />
      <DialogPrimitive.Content
        ref={setRef}
        // Focus the sheet itself rather than its first control: a focused control can open its tooltip, which then
        // swallows the first Escape so the sheet would not close. Callers that want a specific control focused pass
        // their own onOpenAutoFocus and call preventDefault().
        onOpenAutoFocus={(e) => {
          onOpenAutoFocus?.(e);
          if (e.defaultPrevented) return;
          e.preventDefault();
          content.current?.focus({ preventScroll: true });
        }}
        className={cn(
          "fixed z-50 bg-popover text-popover-foreground shadow-overlay border data-[state=open]:animate-slide-up flex flex-col outline-none",
          side === "right" && `inset-y-0 right-0 h-full w-full ${width}`,
          side === "left" && `inset-y-0 left-0 h-full w-full ${width}`,
          side === "top" && "inset-x-0 top-0 max-h-[80vh]",
          side === "bottom" && "inset-x-0 bottom-0 max-h-[80vh]",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute end-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-accent cursor-pointer">
          <X className="size-4" />
          <span className="sr-only"><T k="ui.close" /></span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
SheetContent.displayName = "SheetContent";

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("flex flex-col gap-1 border-b px-5 py-4", className)} {...props} />;
const SheetTitle = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Title>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-base font-semibold", className)} {...props} />
));
SheetTitle.displayName = "SheetTitle";
const SheetDescription = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Description>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
SheetDescription.displayName = "SheetDescription";
const SheetBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("flex-1 overflow-auto scrollbar-thin px-5 py-4", className)} {...props} />;
const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("flex items-center justify-end gap-2 border-t px-5 py-3", className)} {...props} />;

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetBody, SheetFooter };
